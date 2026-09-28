import Homey from 'homey';

import type AtmoceApp from '../app.mts';
import type { ProbeResult } from './gateway-registry.mts';
import {
  DEFAULT_PORT,
  DEFAULT_UNIT_ID,
  type Endpoint,
  errorMessage,
} from './modbus-connection.mts';

export const DEFAULT_POLL_INTERVAL_S = 10;

export interface PairDevice {
  name: string;
  data: { id: string };
  settings: Record<string, string | number>;
  /** Overrides the driver's capability list for this device. */
  capabilities?: string[];
}

interface ConnectInput {
  host?: unknown;
  port?: unknown;
  unitId?: unknown;
}

/**
 * Shared pairing: the `connect` view asks for the gateway address, reads its identity
 * over Modbus, then `list_devices` offers this driver's device for that gateway.
 */
export abstract class AtmoceDriver extends Homey.Driver {

  /** The device this driver creates for a gateway. Throws when the gateway has none. */
  protected abstract pairDevice(gateway: ProbeResult): Pick<PairDevice, 'name' | 'capabilities'>;

  override async onPair(session: Homey.Driver.PairSession): Promise<void> {
    const app = this.homey.app as AtmoceApp;
    let found: { gateway: ProbeResult; endpoint: Endpoint } | null = null;

    session.setHandler('discover', async () => {
      const paired = new Set(this.getDevices().map((device) => (device.getData() as { id: string }).id));
      const found = await app.gateways.discover(DEFAULT_PORT, DEFAULT_UNIT_ID);
      return found.map(({ host, identity }) => ({
        host,
        serial: identity.serial,
        firmwareVersion: identity.firmwareVersion,
        ratedPvPowerW: identity.ratedPvPowerW,
        storageCapacityKwh: identity.storageCapacityKwh,
        paired: paired.has(identity.serial),
      }));
    });

    session.setHandler('defaults', async () => {
      return app.gateways.anyEndpoint() ?? { host: '', port: DEFAULT_PORT, unitId: DEFAULT_UNIT_ID };
    });

    session.setHandler('connect', async (input: ConnectInput) => {
      const endpoint = this.parseEndpoint(input);
      let gateway: ProbeResult;
      try {
        gateway = await app.gateways.probe(endpoint);
      } catch (err) {
        throw new Error(`${this.homey.__('errors.cannot_reach', { host: endpoint.host })} (${errorMessage(err)})`);
      }
      const { identity } = gateway;
      this.log(`Found gateway ${identity.serial} (firmware ${identity.firmwareVersion}) at ${endpoint.host}`);
      found = { gateway, endpoint };
      return {
        serial: identity.serial,
        firmwareVersion: identity.firmwareVersion,
        ratedPvPowerW: identity.ratedPvPowerW,
        storageCapacityKwh: identity.storageCapacityKwh,
      };
    });

    session.setHandler('list_devices', async (): Promise<PairDevice[]> => {
      if (!found) throw new Error(this.homey.__('errors.not_connected'));
      const { gateway, endpoint } = found;
      return [{
        ...this.pairDevice(gateway),
        data: { id: gateway.identity.serial },
        settings: {
          host: endpoint.host,
          port: endpoint.port,
          unit_id: endpoint.unitId,
          poll_interval: DEFAULT_POLL_INTERVAL_S,
        },
      }];
    });
  }

  private parseEndpoint(input: ConnectInput): Endpoint {
    const host = typeof input.host === 'string' ? input.host.trim() : '';
    const port = Number(input.port ?? DEFAULT_PORT);
    const unitId = Number(input.unitId ?? DEFAULT_UNIT_ID);
    if (!host) throw new Error(this.homey.__('errors.host_required'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(this.homey.__('errors.invalid_port'));
    if (!Number.isInteger(unitId) || unitId < 1 || unitId > 247) throw new Error(this.homey.__('errors.invalid_unit_id'));
    return { host, port, unitId };
  }

}
