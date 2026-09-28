import { MAINTENANCE_CAPABILITIES } from '../../lib/atmoce-device.mts';
import { AtmoceDriver, type PairDevice } from '../../lib/atmoce-driver.mts';
import { crossed } from '../../lib/derived.mts';
import type { ProbeResult } from '../../lib/gateway-registry.mts';
import type GridDevice from './device.mts';

/** Capabilities of the grid meter, in display order (see driver.compose.json). */
/** Home consumption first: it becomes the default device indicator (grid power stays the Energy value). */
export const GRID_POWER = ['measure_power.consumption', 'measure_power'];
export const GRID_METERS = [
  'meter_power.imported',
  'meter_power.exported',
  'meter_power.imported_today',
  'meter_power.exported_today',
];
export const SINGLE_PHASE = ['measure_voltage', 'measure_current'];
export const THREE_PHASE = [
  'measure_voltage.l1', 'measure_current.l1',
  'measure_voltage.l2', 'measure_current.l2',
  'measure_voltage.l3', 'measure_current.l3',
];
export const GRID_DERIVED = ['meter_power.consumption_today', 'measure_self_sufficiency'];

interface CrossingState {
  previous: number | null;
  current: number;
}

export default class GridDriver extends AtmoceDriver {

  override async onInit(): Promise<void> {
    const { flow } = this.homey;
    const above = async ({ power }: { power: number }, state: CrossingState) => crossed(state.previous, state.current, power, 'above');
    flow.getDeviceTriggerCard('grid_import_above').registerRunListener(above);
    flow.getDeviceTriggerCard('grid_export_above').registerRunListener(above);
    flow.getActionCard('limit_export').registerRunListener(async ({ device, power }: { device: GridDevice; power: number }) => {
      await device.setPowerLimit('export', power);
    });
    flow.getActionCard('allow_export').registerRunListener(async ({ device }: { device: GridDevice }) => {
      await device.setPowerLimit('export', null);
    });
    flow.getActionCard('limit_import').registerRunListener(async ({ device, power }: { device: GridDevice; power: number }) => {
      await device.setPowerLimit('import', power);
    });
    flow.getActionCard('allow_import').registerRunListener(async ({ device }: { device: GridDevice }) => {
      await device.setPowerLimit('import', null);
    });
    flow.getConditionCard('export_is_limited').registerRunListener(async ({ device }: { device: GridDevice }) => device.powerLimit('export') !== null);
    flow.getConditionCard('import_is_limited').registerRunListener(async ({ device }: { device: GridDevice }) => device.powerLimit('import') !== null);
    flow.getConditionCard('grid_is_off').registerRunListener(async ({ device }: { device: GridDevice }) => device.offGrid);
    flow.getConditionCard('grid_is_exporting').registerRunListener(async ({ device }: { device: GridDevice }) => device.exporting);
    flow.getConditionCard('grid_is_importing').registerRunListener(async ({ device }: { device: GridDevice }) => device.importing);
  }

  protected override pairDevice({ phaseCount }: ProbeResult): Pick<PairDevice, 'name' | 'capabilities'> {
    return {
      name: this.homey.__('pair.name_grid'),
      capabilities: [...GRID_POWER, ...GRID_METERS, ...(phaseCount === 3 ? THREE_PHASE : SINGLE_PHASE), ...GRID_DERIVED, ...MAINTENANCE_CAPABILITIES],
    };
  }

}
