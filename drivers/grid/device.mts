import { AtmoceDevice } from '../../lib/atmoce-device.mts';
import {
  Hysteresis,
  THRESHOLDS,
  consumptionTodayKwh,
  homeConsumptionW,
  selfSufficiencyTodayPercent,
} from '../../lib/derived.mts';
import type { Snapshot } from '../../lib/gateway.mts';
import { batteryPowerForHomey, gridPowerForHomey } from '../../lib/registers.mts';
import { SurplusTracker } from '../../lib/surplus.mts';

const ADDED_AFTER_1_0 = ['measure_power.consumption', 'meter_power.consumption_today', 'measure_self_sufficiency', 'measure_power.surplus'];

/**
 * Grid connection point measured by the gateway (class `sensor`, cumulative meter:
 * positive power while importing), plus the house consumption derived from it.
 *
 * Pairing picks the phase capabilities: `measure_voltage`/`measure_current` on
 * single-phase systems (MC100), `.l1`–`.l3` when the gateway reports a voltage on
 * phase B or C (MC100-T). Only capabilities the device has are updated.
 *
 * Homey Energy only reads the main `measure_power` of a cumulative device, so the
 * consumption sub-capability is not counted twice.
 */
export default class GridDevice extends AtmoceDevice {

  private readonly exportState = new Hysteresis((w) => -w >= THRESHOLDS.grid.on, (w) => -w < THRESHOLDS.grid.off);
  private readonly importState = new Hysteresis((w) => w >= THRESHOLDS.grid.on, (w) => w < THRESHOLDS.grid.off);
  private previousGridW: number | null = null;
  private readonly surplus = new SurplusTracker();

  /** V1.5 on/off-grid status (60096), persisted so a restart does not re-trigger Flows. */
  get offGrid(): boolean {
    return this.getStoreValue('offGrid') === true;
  }

  get exporting(): boolean {
    return this.exportState.active;
  }

  get importing(): boolean {
    return this.importState.active;
  }

  /** Solar surplus (see lib/surplus.mts) has been at least `powerW` for `minutes`; Flow condition. */
  surplusHeld(minutes: number, powerW: number): boolean {
    return this.surplus.surplusHeld(minutes, powerW);
  }

  /** Run listeners of the surplus trigger cards: true only at the poll the condition is reached. */
  surplusStarted(minutes: number, powerW: number): boolean {
    return this.surplus.surplusStarted(minutes, powerW);
  }

  surplusEnded(minutes: number): boolean {
    return this.surplus.surplusEnded(minutes);
  }

  protected override async onDeviceInit(): Promise<void> {
    await this.addMissingCapabilities(ADDED_AFTER_1_0);
  }

  protected override async onSnapshot(snapshot: Snapshot): Promise<void> {
    const {
      status, phases, energy, gridState,
    } = snapshot;
    const gridW = gridPowerForHomey(status.gridPowerW);
    await this.update('measure_power', gridW);
    await this.update('measure_power.consumption', homeConsumptionW(status));
    await this.updateMeter('meter_power.imported', energy.importedTotalKwh);
    await this.updateMeter('meter_power.exported', energy.exportedTotalKwh);
    await this.update('meter_power.imported_today', energy.importedTodayKwh);
    await this.update('meter_power.exported_today', energy.exportedTodayKwh);
    await this.update('meter_power.consumption_today', consumptionTodayKwh(energy));
    await this.update('measure_self_sufficiency', selfSufficiencyTodayPercent(energy));

    const [a, b, c] = phases.phases;
    await this.update('measure_voltage', a.voltageV);
    await this.update('measure_current', a.currentA);
    for (const [index, phase] of [a, b, c].entries()) {
      await this.update(`measure_voltage.l${index + 1}`, phase.voltageV);
      await this.update(`measure_current.l${index + 1}`, phase.currentA);
    }

    await this.triggerFlows(gridW);
    await this.updateSurplus(snapshot, gridW);
    if (gridState?.offGrid != null) await this.updateOffGrid(gridState.offGrid, snapshot);
  }

  private async updateSurplus(snapshot: Snapshot, gridW: number): Promise<void> {
    const sample = this.surplus.add(snapshot.startedAt, gridW, batteryPowerForHomey(snapshot.status.storagePowerW), this.gateway.pollIntervalMs);
    await this.update('measure_power.surplus', sample.surplusW);
    const { flow } = this.homey;
    await flow.getDeviceTriggerCard('solar_surplus_held')
      .trigger(this, { surplus: sample.surplusW }, {});
    await flow.getDeviceTriggerCard('solar_surplus_ended').trigger(this, { power: sample.deficitW }, {});
  }

  private async updateOffGrid(offGrid: boolean, snapshot: Snapshot): Promise<void> {
    if (offGrid === this.offGrid) return;
    await this.setStoreValue('offGrid', offGrid);
    await this.homey.flow.getDeviceTriggerCard(offGrid ? 'grid_outage_started' : 'grid_outage_ended').trigger(this, {}, {});
    if (offGrid) {
      const context = this.context(snapshot);
      this.log(`Grid outage: running off-grid (60096 = 1); ${context}`);
      await this.setStoreValue('offGridSince', Date.now());
      await this.notify('grid_outage', { context });
    } else {
      this.log('Grid is back');
      await this.notify('grid_restored', {}, (this.getStoreValue('offGridSince') as number | null) ?? null);
    }
  }

  private async triggerFlows(gridW: number): Promise<void> {
    const { flow } = this.homey;
    const tokens = { power: Math.abs(gridW) };
    const exportChange = this.exportState.update(gridW);
    if (exportChange) await flow.getDeviceTriggerCard(`grid_export_${exportChange}`).trigger(this, exportChange === 'started' ? tokens : {});
    const importChange = this.importState.update(gridW);
    if (importChange) await flow.getDeviceTriggerCard(`grid_import_${importChange}`).trigger(this, importChange === 'started' ? tokens : {});

    const previous = this.previousGridW;
    this.previousGridW = gridW;
    if (previous === null) return;
    await flow.getDeviceTriggerCard('grid_import_above').trigger(this, tokens, { previous, current: gridW });
    await flow.getDeviceTriggerCard('grid_export_above').trigger(this, tokens, { previous: -previous, current: -gridW });
  }

}
