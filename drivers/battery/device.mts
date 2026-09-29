import { AtmoceDevice } from '../../lib/atmoce-device.mts';
import type { ForcedTarget, Snapshot } from '../../lib/gateway.mts';
import {
  equivalentFullCycles,
  minutesToEmpty,
  minutesToFull,
  storedEnergyKwh,
} from '../../lib/derived.mts';
import { type LearnedLimits, LimitLearner } from '../../lib/limit-learner.mts';
import {
  type Control,
  hasActiveLimit,
  type Identity,
  type RunningStatus,
  type Status,
  batteryPowerForHomey,
} from '../../lib/registers.mts';

type TargetPowerMode = 'device' | 'homey';

/** Same step as capabilitiesOptions.target_power in driver.compose.json. */
const TARGET_POWER_STEP_W = 10;

const ADDED_AFTER_1_0 = ['measure_battery_energy', 'measure_time_to_full', 'measure_time_to_empty', 'measure_battery_cycles'];

/**
 * The battery follows commands (remote dispatch, a forced run or power limits), not only its
 * own limits — its live limits (60200/60202) then say nothing about the Atmozen cut-off SOC.
 */
function isCommanded(control: Control, status: Status, powerLimitsActive: boolean): boolean {
  return powerLimitsActive || control.remoteControl || status.storageMode === 'remote'
    || control.forcedCommand === 'charge' || control.forcedCommand === 'discharge' || control.forcedCommand === 'standby';
}

/** Changed values from registerMultipleCapabilityListener (only changed keys are present). */
interface TargetPowerChange {
  target_power?: number;
  target_power_mode?: TargetPowerMode;
}

/**
 * All batteries behind the gateway (MS-7K-U, MS-8K-U, BattBank, …) as one Homey home
 * battery: the gateway reports them as a single aggregate (sum of capacity and power
 * limits, one SOC), so no model-specific handling is needed.
 *
 * Control
 * - `target_power_mode` = homey: remote dispatch (#43 = 1, #52 = −target_power).
 * - `target_power_mode` = device: dispatch 0 and #43 = 0, the battery follows the mode
 *   set in Atmozen (self-consumption / time-of-use).
 * - Flow actions: forced charge/discharge (#47–#51), to a target SOC or for a duration.
 */
export default class BatteryDevice extends AtmoceDevice {

  /** Re-send Homey's setpoint after (re)start: onUninit hands control back to the gateway. */
  private reapplyTargetPower = false;
  /** Snapshots taken before this moment may predate our own write; skip external sync. */
  private lastWriteAt = 0;
  private previousSoc: number | null = null;
  private readonly limitLearner = new LimitLearner();

  protected override async onDeviceInit(): Promise<void> {
    await this.addMissingCapabilities(ADDED_AFTER_1_0);
    // A fresh device has no mode yet; the gateway starts in its own (Atmozen) mode.
    if (this.getCapabilityValue('target_power_mode') === null) await this.setCapabilityValue('target_power_mode', 'device');
    this.reapplyTargetPower = this.getCapabilityValue('target_power_mode') === 'homey';
    this.registerMultipleCapabilityListener(
      ['target_power', 'target_power_mode'],
      async (values: TargetPowerChange) => this.onTargetPower(values),
      500,
    );
  }

  protected override identitySettings(identity: Identity): Record<string, unknown> {
    return {
      storage_capacity: `${identity.storageCapacityKwh.toFixed(2)} kWh`,
      rated_storage_power: `${(identity.ratedStoragePowerW / 1000).toFixed(2)} kW`,
      ...this.limitSettings(),
    };
  }

  /** Atmozen charge/discharge cut-offs learned so far (also used by the dashboard widget). */
  get learnedLimits(): LearnedLimits {
    const stored = this.getStoreValue('learnedLimits') as Partial<LearnedLimits> | null;
    return { chargeLimitPercent: stored?.chargeLimitPercent ?? null, dischargeLimitPercent: stored?.dischargeLimitPercent ?? null };
  }

  private limitSettings(): Record<string, string> {
    const show = (percent: number | null) => (percent === null ? this.homey.__('settings.not_detected') : `${percent} %`);
    const { chargeLimitPercent, dischargeLimitPercent } = this.learnedLimits;
    return { detected_charge_limit: show(chargeLimitPercent), detected_discharge_limit: show(dischargeLimitPercent) };
  }

  /** Battery problem from the V1.5 running status (60098): all shut down, or an alarm. */
  get problem(): 'faulty' | 'shutdown' | null {
    return (this.getStoreValue('batteryProblem') as 'faulty' | 'shutdown' | null) ?? null;
  }

  private async updateProblem(runningStatus: RunningStatus, snapshot: Snapshot): Promise<void> {
    const problem = runningStatus === 'faulty' || runningStatus === 'shutdown' ? runningStatus : null;
    if (problem === this.problem) return;
    await this.setStoreValue('batteryProblem', problem);
    const { flow } = this.homey;
    if (problem) {
      const context = this.context(snapshot);
      this.log(`Battery problem: ${problem} (60098); ${context}`);
      await this.setStoreValue('batteryProblemSince', Date.now());
      await this.setWarning(this.homey.__(`warning.battery_${problem}`));
      await flow.getDeviceTriggerCard('battery_problem_started').trigger(this, { status: problem }, {});
      await this.notify(`battery_${problem}`, { context });
    } else {
      this.log('Battery problem cleared');
      await this.unsetWarning();
      await flow.getDeviceTriggerCard('battery_problem_cleared').trigger(this, {}, {});
      await this.notify('battery_problem_cleared', {}, (this.getStoreValue('batteryProblemSince') as number | null) ?? null);
    }
  }

  /** Learns the Atmozen charge/discharge limits from the live limits (see LimitLearner). */
  private async learnLimits({
    limits, control, status, phases, powerLimits,
  }: Snapshot): Promise<void> {
    if (!limits || !control) return;
    const learned = this.limitLearner.observe({
      socPercent: phases.socPercent,
      maxChargePowerW: limits.maxChargePowerW,
      maxDischargePowerW: limits.maxDischargePowerW,
      commanded: isCommanded(control, status, hasActiveLimit(powerLimits)),
    });
    if (!learned) return;
    const current = this.learnedLimits;
    const key = learned.kind === 'charge' ? 'chargeLimitPercent' : 'dischargeLimitPercent';
    if (current[key] === learned.percent) return;
    this.log(`Learned ${learned.kind} limit: ${learned.percent} % (was ${current[key] ?? 'unknown'})`);
    await this.setStoreValue('learnedLimits', { ...current, [key]: learned.percent });
    await this.setSettings(this.limitSettings());
  }

  override async onUninit(): Promise<void> {
    await this.handBackControl();
    await super.onUninit();
  }

  override async onDeleted(): Promise<void> {
    await this.handBackControl();
    await super.onDeleted();
  }

  // -------------------------------------------------------------------------
  // Flow actions (registered in driver.mts)
  // -------------------------------------------------------------------------

  async force(direction: 'charge' | 'discharge', target: ForcedTarget): Promise<void> {
    const maxW = this.powerRangeW;
    const powerW = maxW > 0 ? Math.min(target.powerW, maxW) : target.powerW;
    if (powerW !== target.powerW) this.log(`Forced ${direction} power ${target.powerW} W capped to ${powerW} W`);
    // A forced run replaces Homey's dispatch setpoint.
    await this.leaveHomeyMode();
    this.lastWriteAt = Date.now();
    await this.gateway.force(direction, { ...target, powerW });
  }

  async stopForced(): Promise<void> {
    this.lastWriteAt = Date.now();
    await this.gateway.stopForced();
  }

  /**
   * Homey takes control at a fixed power (Homey sign: + charge, − discharge, 0 = pause).
   * Same path as Homey's own "Set the target power" card, with the capabilities updated.
   */
  async holdPower(targetW: number): Promise<void> {
    this.assertAchievable(targetW);
    this.lastWriteAt = Date.now();
    await this.gateway.setDispatchPower(targetW);
    await this.setCapabilityValue('target_power_mode', 'homey');
    await this.setCapabilityValue('target_power', targetW);
  }

  /** Back to the Atmozen mode: ends Homey control and any forced run. */
  async resumeAtmozen(): Promise<void> {
    this.lastWriteAt = Date.now();
    await this.gateway.stopForced();
    await this.gateway.resumeLocalControl();
    await this.setCapabilityValue('target_power_mode', 'device');
  }

  // -------------------------------------------------------------------------

  private async onTargetPower(change: TargetPowerChange): Promise<void> {
    if (this.isRepeat(change)) {
      this.log('Ignoring target power change that repeats the current values', change);
      return;
    }
    this.lastWriteAt = Date.now();
    if (change.target_power_mode === 'device') {
      // "When switching from homey to device mode, the driver should discard any
      // target_power setpoint and resume internal device logic." (Homey Energy docs)
      await this.gateway.resumeLocalControl();
      return;
    }
    const mode = change.target_power_mode ?? this.getCapabilityValue('target_power_mode');
    if (mode !== 'homey') return;
    const targetW = change.target_power ?? (this.getCapabilityValue('target_power') as number | null) ?? 0;
    this.assertAchievable(targetW);
    await this.gateway.setDispatchPower(targetW);
  }

  /**
   * The Homey mobile app can re-send cached slider/picker values when a device page is
   * opened (reported for Sessy, Anker SOLIX and Marstek apps). A change that only repeats
   * the current values must not switch control or re-issue a setpoint. An empty change
   * is the explicit re-apply after a restart and always goes through.
   */
  private isRepeat(change: TargetPowerChange): boolean {
    const keys = Object.keys(change) as Array<keyof TargetPowerChange>;
    return keys.length > 0 && keys.every((key) => change[key] === this.getCapabilityValue(key));
  }

  /** Rejects setpoints beyond anything the batteries have been reported to handle. */
  private assertAchievable(targetW: number): void {
    const rangeW = this.powerRangeW;
    if (rangeW <= 0 || Math.abs(targetW) <= rangeW) return;
    throw new Error(this.homey.__(targetW > 0 ? 'errors.charge_limit' : 'errors.discharge_limit', { max: rangeW }));
  }

  private async leaveHomeyMode(): Promise<void> {
    if (this.getCapabilityValue('target_power_mode') !== 'homey') return;
    await this.gateway.resumeLocalControl();
    await this.setCapabilityValue('target_power_mode', 'device');
  }

  /** Graceful stop: never leave the battery on a dispatch setpoint nobody maintains. */
  private async handBackControl(): Promise<void> {
    if (this.getCapabilityValue('target_power_mode') !== 'homey') return;
    try {
      await this.gateway.resumeLocalControl();
      this.log('Handed battery control back to the gateway');
    } catch (err) {
      this.error('Could not hand battery control back to the gateway:', err);
    }
  }

  protected override async onSnapshot(snapshot: Snapshot): Promise<void> {
    const {
      status, phases, energy, control, startedAt,
    } = snapshot;
    await this.update('measure_power', batteryPowerForHomey(status.storagePowerW));
    await this.update('measure_battery', phases.socPercent);
    if (status.storageStatus) await this.update('battery_charging_state', status.storageStatus);
    if (status.storageMode) await this.update('atmoce_battery_mode', status.storageMode);
    await this.updateMeter('meter_power.charged', energy.chargedTotalKwh);
    await this.updateMeter('meter_power.discharged', energy.dischargedTotalKwh);
    await this.update('meter_power.charged_today', energy.chargedTodayKwh);
    await this.update('meter_power.discharged_today', energy.dischargedTodayKwh);
    await this.widenPowerRange(
      this.gateway.identity?.ratedStoragePowerW ?? 0,
      snapshot.limits?.maxChargePowerW ?? 0,
      snapshot.limits?.maxDischargePowerW ?? 0,
    );
    await this.learnLimits(snapshot);
    if (snapshot.gridState?.runningStatus) await this.updateProblem(snapshot.gridState.runningStatus, snapshot);
    await this.updateEstimates(phases.socPercent, batteryPowerForHomey(status.storagePowerW), energy.dischargedTotalKwh);
    await this.triggerLevelFlows(phases.socPercent);

    if (this.reapplyTargetPower) {
      this.reapplyTargetPower = false;
      this.log('Restoring Homey control of the battery');
      await this.onTargetPower({}).catch((err) => this.error('Restoring target power failed:', err));
      return;
    }

    // Control taken back outside Homey (Atmozen, another Modbus client, gateway restart).
    if (control && startedAt > this.lastWriteAt && !control.remoteControl && this.getCapabilityValue('target_power_mode') === 'homey') {
      this.log('Gateway left remote control; switching target power mode to device');
      await this.setCapabilityValue('target_power_mode', 'device');
    }
  }

  private async updateEstimates(socPercent: number, batteryPowerW: number, dischargedTotalKwh: number): Promise<void> {
    const capacityKwh = this.gateway.identity?.storageCapacityKwh ?? 0;
    if (capacityKwh <= 0) return;
    await this.update('measure_battery_energy', storedEnergyKwh(socPercent, capacityKwh));
    await this.update('measure_battery_cycles', equivalentFullCycles(dischargedTotalKwh, capacityKwh));
    const { chargeLimitPercent, dischargeLimitPercent } = this.learnedLimits;
    await this.update('measure_time_to_full', minutesToFull(socPercent, capacityKwh, batteryPowerW, chargeLimitPercent ?? 100));
    await this.update('measure_time_to_empty', minutesToEmpty(socPercent, capacityKwh, batteryPowerW, dischargeLimitPercent ?? 0));
  }

  /** "Battery level dropped below / rose above" fire once per crossing (see driver.mts). */
  private async triggerLevelFlows(socPercent: number): Promise<void> {
    const previous = this.previousSoc;
    this.previousSoc = socPercent;
    if (previous === null || previous === socPercent) return;
    const { flow } = this.homey;
    const state = { previous, current: socPercent };
    const tokens = { level: socPercent };
    const card = socPercent < previous ? 'battery_level_below' : 'battery_level_above';
    await flow.getDeviceTriggerCard(card).trigger(this, tokens, state);
  }

  /** Widest power (W) the batteries have been reported to handle; 0 when unknown. */
  private get powerRangeW(): number {
    return (this.getStoreValue('powerRangeW') as number | null) ?? 0;
  }

  /**
   * target_power range: Homey asks for "the widest possible range". None of the gateway's
   * values is a fixed rating on a real MC100: 60029 "rated storage power" went from 7500 to
   * 5000 W on the installation day, and the live limits 60200/60202 moved between 0 and
   * 9950 W. So the range is the highest of them seen so far and only ever widens (few
   * expensive setCapabilityOptions calls); the gateway clamps what the battery cannot do.
   */
  private async widenPowerRange(...candidatesW: number[]): Promise<void> {
    const widest = Math.max(...candidatesW);
    if (widest <= this.powerRangeW) return;
    const rangeW = Math.ceil(widest / 100) * 100;
    await this.setCapabilityOptions('target_power', { min: -rangeW, max: rangeW, step: TARGET_POWER_STEP_W });
    await this.setStoreValue('powerRangeW', rangeW);
    this.log(`target_power range widened to ±${rangeW} W`);
  }

}
