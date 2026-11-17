import { AtmoceDriver, type PairDevice } from '../../lib/atmoce-driver.mts';
import type SolarDevice from './device.mts';

export default class SolarDriver extends AtmoceDriver {

  override async onInit(): Promise<void> {
    this.homey.flow.getConditionCard('system_fault_is')
      .registerRunListener(async ({ device }: { device: SolarDevice }) => device.systemFault);
    this.homey.flow.getConditionCard('is_producing')
      .registerRunListener(async ({ device }: { device: SolarDevice }) => device.producing);
  }

  protected override pairDevice(): Pick<PairDevice, 'name'> {
    return { name: this.homey.__('pair.name_solar') };
  }

}
