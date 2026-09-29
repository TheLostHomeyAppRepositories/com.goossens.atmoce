import type { EventEmitter } from 'node:events';

import Homey from 'homey';

import type AtmoceApp from '../app.mts';
import type { AtmoceGateway, BlockSupport, Snapshot } from './gateway.mts';
import { type ConnectionSettings, sameEndpoint, toEndpoint } from './gateway-registry.mts';
import { errorMessage } from './modbus-connection.mts';
import {
  FIRMWARE,
  type Identity,
  type PowerLimitKind,
  batteryPowerForHomey,
  gridPowerForHomey,
} from './registers.mts';

/** Device settings shared by every driver (.homeycompose/drivers/settings). */
export const CONNECTION_SETTING_KEYS = ['host', 'port', 'unit_id', 'poll_interval'] as const;

/** Maintenance action on every device (Device settings → Maintenance actions). */
export const MAINTENANCE_CAPABILITIES = ['button.test_connection'];

type SettingsRecord = Record<string, unknown>;
type Listener = Parameters<EventEmitter['on']>[1];

/** Device#setLastSeenAt (Homey ≥ 12.6.1) is missing from the SDK typings (homey-apps-sdk-v3-types 0.3.12). */
interface LastSeen {
  setLastSeenAt(): Promise<void>;
}

/** Homey's "last seen" is refreshed at most this often. */
const LAST_SEEN_INTERVAL_MS = 60_000;
/** Diagnostics settings are rewritten at most this often, besides on connection changes. */
const DIAGNOSTICS_INTERVAL_MS = 10 * 60_000;
const SUPPORT_MARK: Readonly<Record<BlockSupport, string>> = { yes: '✓', no: '✗', unknown: '?' };

function signedWatts(watts: number): string {
  return `${watts > 0 ? '+' : ''}${Math.round(watts)} W`;
}

export function connectionSettingsFrom(settings: SettingsRecord): ConnectionSettings {
  return {
    host: String(settings.host ?? '').trim(),
    port: Number(settings.port),
    unitId: Number(settings.unit_id),
    pollIntervalS: Number(settings.poll_interval),
  };
}

/**
 * Base class for the solar, battery and grid devices. Each device belongs to one gateway
 * (device data `id` = gateway serial) and shares that gateway's connection.
 */
export abstract class AtmoceDevice extends Homey.Device {

  private attachedGateway: AtmoceGateway | null = null;
  private readonly gatewayListeners: Array<[string, Listener]> = [];
  private warnedDecrease = new Set<string>();
  private lastSeenAt = 0;
  private diagnosticsAt = 0;

  /** Serial of the gateway this device belongs to. */
  get serial(): string {
    return (this.getData() as { id: string }).id;
  }

  /**
   * Device setting "Timeline notifications" (on for devices paired before it existed).
   * Setting ids must differ from group ids: a checkbox and group both called `notifications`
   * made Homey 13.5 reject every setSettings ("Invalid Value Type For Setting: notifications").
   */
  get notificationsEnabled(): boolean {
    return this.getSetting('timeline_notifications') !== false;
  }

  protected get gateway(): AtmoceGateway {
    if (!this.attachedGateway) throw new Error(this.homey.__('errors.not_connected'));
    return this.attachedGateway;
  }

  private get app(): AtmoceApp {
    return this.homey.app as AtmoceApp;
  }

  /** Capability setup and listeners, before the first snapshot arrives. */
  protected abstract onDeviceInit(): Promise<void>;

  /** Maps a poll result onto capabilities. */
  protected abstract onSnapshot(snapshot: Snapshot): Promise<void>;

  /** Extra read-only info settings derived from the gateway identity. */
  protected identitySettings(identity: Identity): SettingsRecord {
    return {};
  }

  override async onInit(): Promise<void> {
    await this.onDeviceInit();
    await this.addMissingCapabilities(MAINTENANCE_CAPABILITIES);
    this.registerCapabilityListener('button.test_connection', async () => this.testConnection());
    this.attach();
  }

  override async onUninit(): Promise<void> {
    await this.detach();
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Homey awaits onDeleted; the SDK typings declare void.
  override async onDeleted(): Promise<void> {
    await this.detach();
  }

  override async onSettings({
    newSettings,
    changedKeys,
  }: {
    oldSettings: SettingsRecord;
    newSettings: SettingsRecord;
    changedKeys: string[];
  }): Promise<void> {
    if (!changedKeys.some((key) => (CONNECTION_SETTING_KEYS as readonly string[]).includes(key))) return;

    const settings = connectionSettingsFrom(newSettings);
    const endpoint = toEndpoint(settings);
    if (!sameEndpoint(endpoint, this.gateway.endpoint)) {
      let identity: Identity;
      try {
        ({ identity } = await this.app.gateways.probe(endpoint));
      } catch (err) {
        throw new Error(`${this.homey.__('errors.cannot_reach', { host: endpoint.host })} (${errorMessage(err)})`);
      }
      if (identity.serial !== this.serial) {
        throw new Error(this.homey.__('errors.other_gateway', { serial: identity.serial }));
      }
    }
    await this.gateway.reconfigure(endpoint, settings.pollIntervalS * 1000);
    await this.propagateConnectionSettings(newSettings);
  }

  // -------------------------------------------------------------------------
  // Helpers for subclasses
  // -------------------------------------------------------------------------

  /** Sets a capability only when it exists and the value changed. */
  protected async update(capability: string, value: string | number | boolean | null): Promise<void> {
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    await this.setCapabilityValue(capability, value);
  }

  /**
   * Lifetime counters feed Homey Energy, which requires them to never decrease
   * ("If the values are periodically reset to zero or decrease unexpectedly, it may lead
   * to data loss"). A lower reading is logged once and ignored.
   */
  protected async updateMeter(capability: string, valueKwh: number): Promise<void> {
    const current = this.getCapabilityValue(capability) as number | null;
    if (typeof current === 'number' && valueKwh < current) {
      if (!this.warnedDecrease.has(capability)) {
        this.warnedDecrease.add(capability);
        this.error(`${capability} went down from ${current} to ${valueKwh} kWh; keeping ${current}`);
      }
      return;
    }
    this.warnedDecrease.delete(capability);
    await this.update(capability, valueKwh);
  }

  /** Sets (W) or removes (null) a V1.3 power limit; explains the firmware need when unsupported. */
  async setPowerLimit(kind: PowerLimitKind, watts: number | null): Promise<void> {
    if (!this.gateway.supportsPowerLimits) {
      throw new Error(this.homey.__('errors.needs_firmware', {
        needed: FIRMWARE.powerLimits,
        current: this.gateway.identity?.firmwareVersion ?? '?',
      }));
    }
    this.log(`Power limit ${kind}: ${watts === null ? 'none' : `${watts} W`}`);
    await this.gateway.setPowerLimit(kind, watts);
  }

  /** Current V1.3 power limit as read back from the gateway (W), or null for none/unknown. */
  powerLimit(kind: PowerLimitKind): number | null {
    return this.attachedGateway?.snapshot?.powerLimits?.[kind] ?? null;
  }

  /**
   * Puts an alarm or all-clear on the Homey timeline, unless turned off for this device.
   * `startedAt` adds how long the condition lasted.
   */
  protected async notify(key: string, tokens: Record<string, string | number> = {}, startedAt: number | null = null): Promise<void> {
    if (!this.notificationsEnabled) {
      this.log(`Timeline notification ${key} not sent (turned off in the device settings)`);
      return;
    }
    let excerpt = this.homey.__(`notify.${key}`, { device: this.getName(), ...tokens });
    if (startedAt !== null) excerpt += ` ${this.homey.__('notify.lasted', { duration: this.app.formatDuration(Date.now() - startedAt) })}`;
    await this.app.timeline(excerpt);
  }

  /** One line of system state for alarms: what the gateway reported at that moment. */
  protected context({ status, phases }: Snapshot): string {
    return this.homey.__('notify.context', {
      firmware: this.attachedGateway?.identity?.firmwareVersion ?? '?',
      solar: `${Math.round(status.pvPowerW)} W`,
      soc: phases.socPercent,
      battery: signedWatts(batteryPowerForHomey(status.storagePowerW)),
      grid: signedWatts(gridPowerForHomey(status.gridPowerW)),
    });
  }

  /**
   * Capability options from the driver manifest. setCapabilityOptions replaces a capability's
   * options, so runtime changes pass these along (translated title, hidden UI component).
   */
  protected manifestOptions(capability: string): Record<string, unknown> {
    return (this.driver.manifest as { capabilitiesOptions?: Record<string, Record<string, unknown>> })
      .capabilitiesOptions?.[capability] ?? {};
  }

  /** Adds capabilities introduced after the device was paired (appended, values follow on the next poll). */
  protected async addMissingCapabilities(capabilities: readonly string[]): Promise<void> {
    for (const capability of capabilities) {
      if (!this.hasCapability(capability)) {
        this.log(`Adding capability ${capability}`);
        await this.addCapability(capability);
      }
    }
  }

  // -------------------------------------------------------------------------

  private attach(): void {
    const gateway = this.app.gateways.acquire(this.serial, connectionSettingsFrom(this.getSettings()), this);
    this.attachedGateway = gateway;

    this.listen(gateway, 'snapshot', (snapshot: Snapshot) => this.handleSnapshot(snapshot));
    this.listen(gateway, 'identity', (identity: Identity) => {
      this.handleIdentity(identity);
      this.refreshDiagnostics();
    });
    this.listen(gateway, 'available', () => {
      this.setAvailable().catch((err) => this.error(err));
      this.refreshDiagnostics();
    });
    this.listen(gateway, 'unavailable', (reason: string) => {
      this.setUnavailable(`${this.homey.__('errors.unreachable')}: ${reason}`).catch((err) => this.error(err));
      this.refreshDiagnostics();
      this.followGateway().catch((err) => this.error('Searching for the gateway failed:', err));
    });

    if (gateway.identity) this.handleIdentity(gateway.identity);
    if (gateway.snapshot) this.handleSnapshot(gateway.snapshot);
    if (!gateway.isAvailable && gateway.lastError) {
      this.setUnavailable(`${this.homey.__('errors.unreachable')}: ${gateway.lastError}`).catch((err) => this.error(err));
    }
  }

  /**
   * The gateway stopped answering: look for it on the network (it may have a new DHCP
   * address) and keep this device's settings in line. All devices of the gateway call this;
   * the registry runs one search and shares the result.
   */
  private async followGateway(): Promise<void> {
    const endpoint = await this.app.gateways.relocate(this.serial);
    if (endpoint && this.getSetting('host') !== endpoint.host) {
      this.log(`Gateway moved to ${endpoint.host}`);
      await this.setSettings({ host: endpoint.host });
    }
  }

  private async detach(): Promise<void> {
    const gateway = this.attachedGateway;
    if (!gateway) return;
    for (const [event, listener] of this.gatewayListeners) gateway.off(event, listener);
    this.gatewayListeners.length = 0;
    this.attachedGateway = null;
    await this.app.gateways.release(this.serial, this);
  }

  private listen(gateway: AtmoceGateway, event: string, listener: Listener): void {
    gateway.on(event, listener);
    this.gatewayListeners.push([event, listener]);
  }

  private handleSnapshot(snapshot: Snapshot): void {
    this.onSnapshot(snapshot).catch((err) => this.error('Applying snapshot failed:', err));
    const now = Date.now();
    if (now - this.lastSeenAt >= LAST_SEEN_INTERVAL_MS) {
      this.lastSeenAt = now;
      (this as unknown as LastSeen).setLastSeenAt().catch((err) => this.error('setLastSeenAt failed:', err));
    }
    if (now - this.diagnosticsAt >= DIAGNOSTICS_INTERVAL_MS) this.refreshDiagnostics();
  }

  /**
   * Maintenance action "Test connection": reads the gateway right now. A failure is shown
   * as the error of the action; a success puts a full report on the timeline (it was asked
   * for, so regardless of the notification setting).
   */
  private async testConnection(): Promise<void> {
    const { gateway } = this;
    const { host, port, unitId } = gateway.endpoint;
    let result: Awaited<ReturnType<AtmoceGateway['testConnection']>>;
    try {
      result = await gateway.testConnection();
    } catch (err) {
      const message = this.homey.__('errors.test_failed', { host: `${host}:${port}`, error: errorMessage(err) });
      this.error(`Connection test failed: ${message}`);
      this.refreshDiagnostics();
      throw new Error(message);
    }
    this.refreshDiagnostics();
    await this.app.timeline(this.homey.__('notify.test_ok', {
      device: this.getName(),
      host: `${host}:${port}`,
      unit: unitId,
      ms: result.roundTripMs,
      serial: result.identity.serial,
      firmware: result.identity.firmwareVersion,
      registers: this.registerSummary(gateway),
      polls: gateway.stats.polls,
      failed: gateway.stats.failed,
    }));
  }

  /** Rewrites the read-only Diagnostics settings (only values that changed). */
  private refreshDiagnostics(): void {
    const gateway = this.attachedGateway;
    if (!gateway) return;
    this.diagnosticsAt = Date.now();
    const t = (key: string, tokens?: Record<string, string | number>) => this.homey.__(key, tokens);
    const time = (timestamp: number) => this.app.formatTime(timestamp);
    const host = `${gateway.endpoint.host}:${gateway.endpoint.port}`;
    let connection = t('diag.connecting', { host });
    if (gateway.isAvailable && gateway.connectedSince !== null) {
      connection = t('diag.connected_since', { host, time: time(gateway.connectedSince) });
    } else if (gateway.unavailableSince !== null) {
      connection = t('diag.unreachable_since', { host, time: time(gateway.unavailableSince) });
    }
    const failure = gateway.lastFailure;
    this.setChangedSettings({
      diag_connection: connection,
      diag_last_error: failure ? `${time(failure.at)}: ${failure.message}` : t('diag.none'),
      diag_polls: t('diag.polls_value', { polls: gateway.stats.polls, failed: gateway.stats.failed }),
      diag_registers: this.registerSummary(gateway),
    });
  }

  /** Optional register blocks and whether this gateway answers them, e.g. "60200 ✓ · 60318 ✗". */
  private registerSummary(gateway: AtmoceGateway): string {
    return gateway.blockSupport.map(({ start, support }) => `${start} ${SUPPORT_MARK[support]}`).join(' · ');
  }

  private setChangedSettings(wanted: SettingsRecord): void {
    const current = this.getSettings() as SettingsRecord;
    const changed = Object.fromEntries(Object.entries(wanted).filter(([key, value]) => current[key] !== value));
    if (Object.keys(changed).length > 0) this.setSettings(changed).catch((err) => this.error(err));
  }

  private handleIdentity(identity: Identity): void {
    const wanted: SettingsRecord = {
      serial: identity.serial,
      firmware_version: identity.firmwareVersion,
      hardware_version: identity.hardwareVersion,
      protocol_version: identity.protocolVersion,
      ...this.identitySettings(identity),
    };
    this.setChangedSettings(wanted);
  }

  /** Keeps the other devices of this gateway on the same connection settings. */
  private async propagateConnectionSettings(settings: SettingsRecord): Promise<void> {
    const update = Object.fromEntries(CONNECTION_SETTING_KEYS.map((key) => [key, settings[key]]));
    for (const driver of Object.values(this.homey.drivers.getDrivers())) {
      for (const device of driver.getDevices()) {
        if (!(device instanceof AtmoceDevice) || device === this || device.serial !== this.serial) continue;
        await device.setSettings(update);
      }
    }
  }

}
