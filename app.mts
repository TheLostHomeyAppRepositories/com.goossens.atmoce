import Homey from 'homey';

import { AtmoceDevice } from './lib/atmoce-device.mts';
import { type BatteryInfo, type EnergyFlow, energyFlow } from './lib/energy-flow.mts';
import { formatDuration, formatTime } from './lib/format.mts';
import type BatteryDevice from './drivers/battery/device.mts';
import type { AtmoceGateway, Timers } from './lib/gateway.mts';
import { type GatewayAlert, GatewayAlerts } from './lib/gateway-alerts.mts';
import { GatewayRegistry } from './lib/gateway-registry.mts';

/** Realtime event the energy-flow widget listens to (Homey.on in the widget view). */
export const ENERGY_FLOW_EVENT = 'energyflow';
/** App setting: last firmware seen per gateway serial. */
const FIRMWARE_SETTING = 'firmware';

export default class AtmoceApp extends Homey.App {

  gateways!: GatewayRegistry;
  private alerts!: GatewayAlerts;

  override async onInit(): Promise<void> {
    const timers: Timers = {
      setTimeout: (callback, ms) => this.homey.setTimeout(callback, ms),
      clearTimeout: (timer) => this.homey.clearTimeout(timer),
    };
    this.alerts = new GatewayAlerts({
      timers,
      firmware: {
        get: (serial) => this.lastFirmware(serial),
        set: (serial, version) => this.homey.settings.set(FIRMWARE_SETTING, { ...this.firmwareSeen(), [serial]: version }),
      },
      alert: (serial, alert) => {
        this.sendGatewayAlert(serial, alert).catch((err) => this.error('Gateway alert failed:', err));
      },
    });
    this.gateways = new GatewayRegistry(
      timers,
      { log: (...args) => this.log(...args), error: (...args) => this.error(...args) },
      () => this.homey.cloud.getLocalAddress(),
      (gateway) => {
        gateway.on('snapshot', () => this.publishEnergyFlow(gateway));
        this.alerts.watch(gateway);
      },
    );

    this.homey.dashboards.getWidget('energy-flow').registerSettingAutocompleteListener('gateway', async (query: string) => {
      const needle = query.trim().toLowerCase();
      return this.gateways.list()
        .filter((gateway) => gateway.serial.toLowerCase().includes(needle))
        .map((gateway) => ({ name: gateway.serial, description: gateway.endpoint.host, serial: gateway.serial }));
    });

    this.log(`${this.manifest.id} v${this.manifest.version} started`);
  }

  override async onUninit(): Promise<void> {
    await this.gateways.destroy();
  }

  /** Current energy flow of a gateway (the only one when `serial` is empty), for the widget. */
  energyFlow(serial?: string): EnergyFlow | null {
    const gateway = serial ? this.gateways.get(serial) : this.gateways.list()[0];
    return gateway ? this.flowOf(gateway) : null;
  }

  /** Puts a message on the Homey timeline (and the owner's phone). Never throws. */
  async timeline(excerpt: string): Promise<void> {
    this.log('Timeline:', excerpt);
    await this.homey.notifications.createNotification({ excerpt })
      .catch((err) => this.error('Timeline notification failed:', err));
  }

  formatDuration(ms: number): string {
    return formatDuration(ms, this.homey.i18n.getLanguage());
  }

  formatTime(timestamp: number): string {
    return formatTime(timestamp, this.homey.i18n.getLanguage(), this.homey.clock.getTimezone());
  }

  /** The solar, battery and grid devices of one gateway. */
  devicesOf(serial: string): AtmoceDevice[] {
    return Object.values(this.homey.drivers.getDrivers())
      .flatMap((driver) => driver.getDevices())
      .filter((device): device is AtmoceDevice => device instanceof AtmoceDevice && device.serial === serial);
  }

  /** Gateway-wide alerts go out once, when any device of that gateway has notifications on. */
  private async sendGatewayAlert(serial: string, alert: GatewayAlert): Promise<void> {
    if (!this.devicesOf(serial).some((device) => device.notificationsEnabled)) {
      this.log(`[${serial}] ${alert.kind} (timeline notifications are off)`);
      return;
    }
    let tokens: Record<string, string>;
    if (alert.kind === 'connection_lost') {
      tokens = { host: `${alert.host}:${alert.port}`, duration: this.formatDuration(alert.sinceMs), error: alert.error };
    } else if (alert.kind === 'connection_restored') {
      tokens = { host: `${alert.host}:${alert.port}`, duration: this.formatDuration(alert.downMs) };
    } else {
      tokens = { previous: alert.previous, current: alert.current };
    }
    await this.timeline(this.homey.__(`notify.${alert.kind}`, { serial, ...tokens }));
  }

  private firmwareSeen(): Record<string, string> {
    return (this.homey.settings.get(FIRMWARE_SETTING) as Record<string, string> | null) ?? {};
  }

  /**
   * Firmware seen last time; before this setting existed, the firmware the devices show
   * (so an update while Homey was off is still noticed).
   */
  private lastFirmware(serial: string): string | null {
    const seen = this.firmwareSeen()[serial];
    if (seen) return seen;
    const shown = this.devicesOf(serial).map((device) => device.getSetting('firmware_version') as unknown).find((value) => typeof value === 'string' && value !== '');
    return typeof shown === 'string' ? shown : null;
  }

  private flowOf(gateway: AtmoceGateway): EnergyFlow | null {
    if (!gateway.snapshot || !gateway.isAvailable) return null;
    const { identity } = gateway;
    const hasBattery = identity !== null && (identity.storageCapacityKwh > 0 || identity.ratedStoragePowerW > 0);
    return energyFlow(gateway.serial, gateway.snapshot, hasBattery ? this.batteryInfo(gateway) : null);
  }

  /** Capacity from the gateway; charge/discharge limits as learned by the battery device, if paired. */
  private batteryInfo(gateway: AtmoceGateway): BatteryInfo {
    const device = this.homey.drivers.getDriver('battery').getDevices()
      .find((candidate) => (candidate.getData() as { id: string }).id === gateway.serial) as BatteryDevice | undefined;
    const limits = device?.learnedLimits;
    return {
      capacityKwh: gateway.identity?.storageCapacityKwh ?? 0,
      chargeLimitPercent: limits?.chargeLimitPercent ?? null,
      dischargeLimitPercent: limits?.dischargeLimitPercent ?? null,
    };
  }

  private publishEnergyFlow(gateway: AtmoceGateway): void {
    const flow = this.flowOf(gateway);
    if (!flow) return;
    Promise.resolve(this.homey.api.realtime(ENERGY_FLOW_EVENT, flow)).catch((err) => this.error('Widget update failed:', err));
  }

}
