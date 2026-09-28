import Homey from 'homey';

import { type EnergyFlow, energyFlow } from './lib/energy-flow.mts';
import type { AtmoceGateway } from './lib/gateway.mts';
import { GatewayRegistry } from './lib/gateway-registry.mts';

/** Realtime event the energy-flow widget listens to (Homey.on in the widget view). */
export const ENERGY_FLOW_EVENT = 'energyflow';

export default class AtmoceApp extends Homey.App {

  gateways!: GatewayRegistry;

  override async onInit(): Promise<void> {
    this.gateways = new GatewayRegistry(
      {
        setTimeout: (callback, ms) => this.homey.setTimeout(callback, ms),
        clearTimeout: (timer) => this.homey.clearTimeout(timer),
      },
      { log: (...args) => this.log(...args), error: (...args) => this.error(...args) },
      () => this.homey.cloud.getLocalAddress(),
      (gateway) => this.publishEnergyFlow(gateway),
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

  private flowOf(gateway: AtmoceGateway): EnergyFlow | null {
    if (!gateway.snapshot || !gateway.isAvailable) return null;
    const { identity } = gateway;
    const hasBattery = identity !== null && (identity.storageCapacityKwh > 0 || identity.ratedStoragePowerW > 0);
    return energyFlow(gateway.serial, gateway.snapshot, hasBattery);
  }

  private publishEnergyFlow(gateway: AtmoceGateway): void {
    const flow = this.flowOf(gateway);
    if (!flow) return;
    Promise.resolve(this.homey.api.realtime(ENERGY_FLOW_EVENT, flow)).catch((err) => this.error('Widget update failed:', err));
  }

}
