/**
 * Solar surplus for the Flow cards, battery first (as evcc: loads start "when the home battery
 * can no longer absorb any power"):
 * - surplus: what the battery cannot absorb, i.e. what flows to the grid;
 * - deficit: what the home takes from the grid or from the battery. Once the battery is full
 *   the Atmoce covers dips from the battery, so grid import alone would let an appliance
 *   started on surplus drain the battery.
 * Without a battery the battery power is 0, so surplus is simply export and deficit is import.
 * Battery first is a dial (evcc `prioritySoc`, Loxone `MinSoc`): from `chargeCountsFromPercent`
 * battery level on, the battery's charging power counts as surplus too, so appliances can start
 * while the battery keeps charging with what is left. 100 % (default) is pure battery first.
 * Both are averaged over AVERAGE_MS so a passing cloud does not reset a timer. The averaged
 * samples of the last MAX_DURATION_MIN are kept, so "held for N minutes" is answered for any
 * power and duration a Flow asks, without per-Flow state. Pure, unit-tested.
 */

export const AVERAGE_MS = 2 * 60_000;
export const MAX_DURATION_MIN = 240;
/** Taking at least this much from the grid or battery means the surplus is gone (evcc example: 200 W). */
export const DEFICIT_THRESHOLD_W = 200;
const MINUTE_MS = 60_000;
// A few minutes more than the longest duration: "held for" needs a sample from before the period.
const HISTORY_MS = (MAX_DURATION_MIN + 5) * MINUTE_MS;

export interface SurplusInput {
  at: number;
  /** Homey sign: + import, − export. */
  gridW: number;
  /** Homey sign: + charging, − discharging; 0 without a battery. */
  batteryW: number;
  socPercent: number;
}

export interface SurplusOptions {
  pollIntervalMs: number;
  /** From this battery level on, charging power counts as surplus (100: only export). */
  chargeCountsFromPercent: number;
}

export interface SurplusSample {
  at: number;
  /** Averaged power to the grid, plus battery charging above the dial (W, ≥ 0). */
  surplusW: number;
  /** Averaged power from the grid plus from the battery (W, ≥ 0). */
  deficitW: number;
}

export class SurplusTracker {

  private readonly raw: SurplusSample[] = [];
  private readonly history: SurplusSample[] = [];
  /** A longer gap between samples breaks "held for": the gateway was not answering. */
  private maxGapMs = 90_000;
  /**
   * Per trigger condition (kind, power, duration): the poll at which it fired during the current
   * hold. A Flow created or changed while the condition already holds then fires at the next poll,
   * and Flows with the same arguments all fire at that same poll. Cleared when the hold breaks.
   */
  private readonly firedAt = new Map<string, number>();

  /** Adds one poll; `pollIntervalMs` sets how long a gap between samples may be. */
  add({
    at, gridW, batteryW, socPercent,
  }: SurplusInput, { pollIntervalMs, chargeCountsFromPercent }: SurplusOptions): SurplusSample {
    this.maxGapMs = Math.max(90_000, 3 * pollIntervalMs);
    const chargeW = socPercent >= chargeCountsFromPercent ? Math.max(0, batteryW) : 0;
    this.raw.push({ at, surplusW: Math.max(0, -gridW) + chargeW, deficitW: Math.max(0, gridW) + Math.max(0, -batteryW) });
    while (this.raw.length > 1 && (this.raw[0] as SurplusSample).at <= at - AVERAGE_MS) this.raw.shift();
    const average = (key: 'surplusW' | 'deficitW') => Math.round(this.raw.reduce((sum, s) => sum + s[key], 0) / this.raw.length);
    const sample = { at, surplusW: average('surplusW'), deficitW: average('deficitW') };
    this.history.push(sample);
    while (this.history.length > 1 && (this.history[0] as SurplusSample).at < at - HISTORY_MS) this.history.shift();
    return sample;
  }

  get current(): SurplusSample | null {
    return this.history.at(-1) ?? null;
  }

  /** The surplus has been at least `powerW` for the last `minutes` (0: right now). */
  surplusHeld(minutes: number, powerW: number): boolean {
    return this.heldAt(this.history.length - 1, minutes, (s) => s.surplusW >= powerW);
  }

  /** True once per hold: the surplus has been at least `powerW` for `minutes` (see firedAt). */
  surplusStarted(minutes: number, powerW: number): boolean {
    return this.fireOnce(`surplus:${minutes}:${powerW}`, this.surplusHeld(minutes, powerW));
  }

  /** True once per hold: the home has taken power from the grid or battery for `minutes`. */
  surplusEnded(minutes: number): boolean {
    const held = this.heldAt(this.history.length - 1, minutes, (s) => s.deficitW >= DEFICIT_THRESHOLD_W);
    return this.fireOnce(`deficit:${minutes}`, held);
  }

  private fireOnce(key: string, held: boolean): boolean {
    const now = this.current?.at;
    if (!held || now === undefined) {
      this.firedAt.delete(key);
      return false;
    }
    const fired = this.firedAt.get(key);
    if (fired === undefined) {
      this.firedAt.set(key, now);
      return true;
    }
    return fired === now;
  }

  /** `pick` held for every sample from `minutes` before sample `end` up to it, without gaps. */
  private heldAt(end: number, minutes: number, pick: (sample: SurplusSample) => boolean): boolean {
    const last = this.history[end];
    if (!last) return false;
    const from = last.at - minutes * MINUTE_MS;
    let newer = last.at;
    for (let i = end; i >= 0; i--) {
      const sample = this.history[i] as SurplusSample;
      if (newer - sample.at > this.maxGapMs || !pick(sample)) return false;
      if (sample.at <= from) return true;
      newer = sample.at;
    }
    // The history does not reach back far enough yet (e.g. just after a restart).
    return false;
  }

}
