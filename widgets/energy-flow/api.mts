import type AtmoceApp from '../../app.mts';
import type { EnergyFlow } from '../../lib/energy-flow.mts';

interface Request {
  homey: AtmoceApp['homey'];
  query: Record<string, string | undefined>;
}

export default {
  /** GET /?serial=… → the current energy flow, or { error: 'no_data' } while there is none. */
  async getFlow({ homey, query }: Request): Promise<EnergyFlow | { error: string }> {
    return (homey.app as AtmoceApp).energyFlow(query.serial || undefined) ?? { error: 'no_data' };
  },
};
