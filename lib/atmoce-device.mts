import type { EventEmitter } from 'node:events';

import Homey from 'homey';

import type AtmoceApp from '../app.mts';
import type { AtmoceGateway, Snapshot } from './gateway.mts';
import { type ConnectionSettings, sameEndpoint, toEndpoint } from './gateway-registry.mts';
import { errorMessage } from './modbus-connection.mts';
import { FIRMWARE, type Identity, type PowerLimitKind } from './registers.mts';

/** Device settings shared by every driver (.homeycompose/drivers/settings). */
export const CONNECTION_SETTING_KEYS = ['host', 'port', 'unit_id', 'poll_interval'] as const;

type SettingsRecord = Record<string, unknown>;
type Listener = Parameters<EventEmitter['on']>[1];

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

  protected get serial(): string {
    return (this.getData() as { id: string }).id;
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
    this.listen(gateway, 'identity', (identity: Identity) => this.handleIdentity(identity));
    this.listen(gateway, 'available', () => {
      this.setAvailable().catch((err) => this.error(err));
    });
    this.listen(gateway, 'unavailable', (reason: string) => {
      this.setUnavailable(`${this.homey.__('errors.unreachable')}: ${reason}`).catch((err) => this.error(err));
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
  }

  private handleIdentity(identity: Identity): void {
    const wanted: SettingsRecord = {
      serial: identity.serial,
      firmware_version: identity.firmwareVersion,
      hardware_version: identity.hardwareVersion,
      protocol_version: identity.protocolVersion,
      ...this.identitySettings(identity),
    };
    const current = this.getSettings() as SettingsRecord;
    const changed = Object.fromEntries(Object.entries(wanted).filter(([key, value]) => current[key] !== value));
    if (Object.keys(changed).length > 0) this.setSettings(changed).catch((err) => this.error(err));
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
