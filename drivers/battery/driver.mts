import type Homey from 'homey';

import { AtmoceDriver, type PairDevice } from '../../lib/atmoce-driver.mts';
import { crossed } from '../../lib/derived.mts';
import type { ProbeResult } from '../../lib/gateway-registry.mts';
import type BatteryDevice from './device.mts';

interface ForceArgs {
  device: BatteryDevice;
  power: number;
  soc?: number;
  minutes?: number;
}

export default class BatteryDriver extends AtmoceDriver {

  override async onInit(): Promise<void> {
    const { flow } = this.homey;
    const forceToSoc = (direction: 'charge' | 'discharge') => async ({ device, power, soc }: ForceArgs) => {
      await device.force(direction, { kind: 'target_soc', socPercent: soc ?? 0, powerW: power });
    };
    const forceFor = (direction: 'charge' | 'discharge') => async ({ device, power, minutes }: ForceArgs) => {
      await device.force(direction, { kind: 'duration', minutes: minutes ?? 0, powerW: power });
    };

    flow.getActionCard('force_charge_to_soc').registerRunListener(forceToSoc('charge'));
    flow.getActionCard('force_discharge_to_soc').registerRunListener(forceToSoc('discharge'));
    flow.getActionCard('force_charge_for').registerRunListener(forceFor('charge'));
    flow.getActionCard('force_discharge_for').registerRunListener(forceFor('discharge'));
    flow.getActionCard('stop_forced').registerRunListener(async ({ device }: { device: BatteryDevice }) => {
      await device.stopForced();
    });
    flow.getActionCard('charge_at_power').registerRunListener(async ({ device, power }: ForceArgs) => {
      await device.holdPower(Math.abs(power));
    });
    flow.getActionCard('discharge_at_power').registerRunListener(async ({ device, power }: ForceArgs) => {
      await device.holdPower(-Math.abs(power));
    });
    flow.getActionCard('pause_battery').registerRunListener(async ({ device }: { device: BatteryDevice }) => {
      await device.holdPower(0);
    });
    flow.getActionCard('limit_charging').registerRunListener(async ({ device, power }: ForceArgs) => {
      await device.setPowerLimit('charge', power);
    });
    flow.getActionCard('limit_discharging').registerRunListener(async ({ device, power }: ForceArgs) => {
      await device.setPowerLimit('discharge', power);
    });
    flow.getActionCard('remove_battery_limits').registerRunListener(async ({ device }: { device: BatteryDevice }) => {
      await device.setPowerLimit('charge', null);
      await device.setPowerLimit('discharge', null);
    });
    flow.getActionCard('resume_atmozen').registerRunListener(async ({ device }: { device: BatteryDevice }) => {
      await device.resumeAtmozen();
    });

    type Crossing = { previous: number; current: number };
    flow.getDeviceTriggerCard('battery_level_below')
      .registerRunListener(async ({ level }: { level: number }, state: Crossing) => crossed(state.previous, state.current, level, 'below'));
    flow.getDeviceTriggerCard('battery_level_above')
      .registerRunListener(async ({ level }: { level: number }, state: Crossing) => crossed(state.previous, state.current, level, 'above'));
    flow.getConditionCard('battery_has_problem')
      .registerRunListener(async ({ device }: { device: BatteryDevice }) => device.problem !== null);
    flow.getConditionCard('battery_level_is_above')
      .registerRunListener(async ({ device, level }: { device: Homey.Device; level: number }) => {
        const soc = device.getCapabilityValue('measure_battery') as number | null;
        return soc !== null && soc > level;
      });
    flow.getConditionCard('atmoce_battery_mode_is').registerRunListener(
      async ({ device, mode }: { device: Homey.Device; mode: string }) => device.getCapabilityValue('atmoce_battery_mode') === mode,
    );
  }

  protected override pairDevice({ identity }: ProbeResult): Pick<PairDevice, 'name'> {
    if (identity.storageCapacityKwh <= 0 && identity.ratedStoragePowerW <= 0) {
      throw new Error(this.homey.__('errors.no_battery'));
    }
    return { name: this.homey.__('pair.name_battery') };
  }

}
