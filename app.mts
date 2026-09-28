import Homey from 'homey';

import { GatewayRegistry } from './lib/gateway-registry.mts';

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
    );
    this.log(`${this.manifest.id} v${this.manifest.version} started`);
  }

  override async onUninit(): Promise<void> {
    await this.gateways.destroy();
  }

}
