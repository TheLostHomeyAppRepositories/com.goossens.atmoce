import { AtmoceDevice } from '../../lib/atmoce-device.mts';
import { Hysteresis, THRESHOLDS } from '../../lib/derived.mts';
import type { Snapshot } from '../../lib/gateway.mts';
import type { Identity } from '../../lib/registers.mts';

function formatKw(watts: number): string {
  return `${(watts / 1000).toFixed(2)} kW`;
}

type TargetPowerMode = 'device' | 'homey';

interface CurtailmentChange {
  target_power?: number;
  target_power_mode?: TargetPowerMode;
}

const CURTAILMENT = ['target_power', 'target_power_mode'] as const;
const TARGET_POWER_STEP_W = 10;

/**
 * Solar production of all microinverters behind the gateway (class `solarpanel`,
 * positive power while producing).
 *
 * The power station status (60066) is reported as a device warning plus Flow cards, not
 * as an `alarm_` capability: alarms take over the device indicator by default, and
 * production is what belongs there.
 *
 * On gateways with the V1.3 power limits (firmware ≥ 01.01.00.29) Homey Energy's solar
 * curtailment is added: `target_power` is the maximum production (60322), "device" mode or
 * the maximum value means no limit (Homey Energy docs, "Solar panels").
 */
export default class SolarDevice extends AtmoceDevice {

  private readonly production = new Hysteresis((w) => w >= THRESHOLDS.production.on, (w) => w < THRESHOLDS.production.off);
  private curtailmentListening = false;
  /** Snapshots started before this moment may predate our own write; skip syncing. */
  private lastWriteAt = 0;

  get producing(): boolean {
    return this.production.active;
  }

  /** Last known station fault state, persisted so a restart does not re-trigger Flows. */
  get systemFault(): boolean {
    return this.getStoreValue('systemFault') === true;
  }

  private get ratedPvPowerW(): number {
    return this.gateway.identity?.ratedPvPowerW ?? 0;
  }

  protected override async onDeviceInit(): Promise<void> {
    // Devices paired with 1.0.0 builds had alarm_problem.
    if (this.hasCapability('alarm_problem')) await this.removeCapability('alarm_problem');
  }

  protected override identitySettings(identity: Identity): Record<string, unknown> {
    return { rated_pv_power: formatKw(identity.ratedPvPowerW) };
  }

  protected override async onSnapshot(snapshot: Snapshot): Promise<void> {
    const { status, energy } = snapshot;
    await this.update('measure_power', status.pvPowerW);
    await this.updateMeter('meter_power', energy.pvTotalKwh);
    await this.update('meter_power.today', energy.pvTodayKwh);
    if (status.stationFault !== null) await this.updateSystemFault(status.stationFault, snapshot);

    const change = this.production.update(status.pvPowerW);
    if (change) await this.homey.flow.getDeviceTriggerCard(`production_${change}`).trigger(this, {}, {});

    await this.setUpCurtailment();
    await this.syncCurtailment(snapshot);
  }

  // -------------------------------------------------------------------------
  // Curtailment (Flow actions call these too)
  // -------------------------------------------------------------------------

  /** Caps production (W); at or above the rated PV power this means no limit. */
  async limitProduction(watts: number | null): Promise<void> {
    const ratedW = this.ratedPvPowerW;
    const limit = watts === null || (ratedW > 0 && watts >= ratedW) ? null : Math.max(0, Math.round(watts));
    this.lastWriteAt = Date.now();
    await this.setPowerLimit('pv', limit);
    if (this.hasCapability('target_power')) {
      await this.setCapabilityValue('target_power_mode', limit === null ? 'device' : 'homey');
      await this.setCapabilityValue('target_power', limit ?? this.ratedPvPowerW);
    }
  }

  async removeProductionLimit(): Promise<void> {
    await this.limitProduction(null);
  }

  private async setUpCurtailment(): Promise<void> {
    const ratedW = this.ratedPvPowerW;
    if (!this.gateway.supportsPowerLimits || ratedW <= 0) return;
    await this.addMissingCapabilities(CURTAILMENT);
    // v3: the manifest options hide the slider (uiComponent: null); earlier devices showed it.
    if (this.getStoreValue('curtailmentOptions') !== `${ratedW}:v3`) {
      await this.setCapabilityOptions('target_power', {
        ...this.manifestOptions('target_power'), min: 0, max: ratedW, step: TARGET_POWER_STEP_W,
      });
      await this.setStoreValue('curtailmentOptions', `${ratedW}:v3`);
    }
    if (this.getCapabilityValue('target_power_mode') === null) await this.setCapabilityValue('target_power_mode', 'device');
    if (this.getCapabilityValue('target_power') === null) await this.setCapabilityValue('target_power', ratedW);
    if (this.curtailmentListening) return;
    this.curtailmentListening = true;
    this.registerMultipleCapabilityListener(
      [...CURTAILMENT],
      async (change: CurtailmentChange) => this.onCurtailment(change),
      500,
    );
  }

  private async onCurtailment(change: CurtailmentChange): Promise<void> {
    // The mobile app can re-send cached values when the device page opens (see battery).
    const keys = Object.keys(change) as Array<keyof CurtailmentChange>;
    if (keys.every((key) => change[key] === this.getCapabilityValue(key))) return;
    const mode = change.target_power_mode ?? this.getCapabilityValue('target_power_mode');
    this.lastWriteAt = Date.now();
    if (mode !== 'homey') {
      await this.setPowerLimit('pv', null);
      return;
    }
    const targetW = change.target_power ?? (this.getCapabilityValue('target_power') as number | null) ?? this.ratedPvPowerW;
    await this.setPowerLimit('pv', targetW >= this.ratedPvPowerW ? null : Math.round(targetW));
  }

  /** Shows the production limit the gateway really has (also when set by another system). */
  private async syncCurtailment({ powerLimits, startedAt }: Snapshot): Promise<void> {
    if (!powerLimits || !this.hasCapability('target_power') || startedAt <= this.lastWriteAt) return;
    const limit = powerLimits.pv;
    if (limit === null && this.getCapabilityValue('target_power_mode') === 'homey') {
      await this.setCapabilityValue('target_power_mode', 'device');
      await this.setCapabilityValue('target_power', this.ratedPvPowerW);
    } else if (limit !== null) {
      await this.update('target_power_mode', 'homey');
      await this.update('target_power', limit);
    }
  }

  private async updateSystemFault(fault: boolean, snapshot: Snapshot): Promise<void> {
    if (fault === this.systemFault) return;
    await this.setStoreValue('systemFault', fault);
    if (fault) {
      const context = this.context(snapshot);
      this.log(`Gateway reports a system fault (60066 = ${snapshot.status.raw.stationStatus}); ${context}`);
      await this.setStoreValue('systemFaultSince', Date.now());
      await this.setWarning(this.homey.__('warning.system_fault'));
      await this.notify('system_fault', { context });
    } else {
      this.log('System fault cleared');
      await this.unsetWarning();
      await this.notify('system_fault_cleared', {}, (this.getStoreValue('systemFaultSince') as number | null) ?? null);
    }
    const card = this.homey.flow.getDeviceTriggerCard(fault ? 'system_fault_started' : 'system_fault_cleared');
    await card.trigger(this, {}, {});
  }

}
