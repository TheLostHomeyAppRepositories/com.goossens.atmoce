/**
 * Recognises a battery that Homey asks to charge from (or discharge into) the grid while
 * Atmozen does not allow it. Neither switch ("Grid recharging", "Export power to grid") is
 * on Modbus, but the effect is clear: the battery then only follows the solar surplus
 * (charging) or the home load (discharging), however much power Homey asks for.
 * Verified 2026-10-06 on an MC100: forced charge 3000 W with grid recharging off charged
 * only PV minus home, with it on exactly 3000 W; forced discharge 3000 W with export off
 * stayed at 0 W while the sun covered the home. Pure, unit-tested.
 */

export type GridPermission = 'grid_recharging' | 'export_power';

export interface PermissionSample {
  at: number;
  /** What Homey asked for: + charge, − discharge (W); null when nothing is asked. */
  requestedW: number | null;
  /** Battery power, + charging, − discharging (Homey signs). */
  batteryW: number;
  pvW: number;
  homeW: number;
  socPercent: number;
  /** Live charge/discharge limits (60200/60202); null when unknown. */
  maxChargeW: number | null;
  maxDischargeW: number | null;
  /** SOC the battery stops at for this request (target or Atmozen limit). */
  stopSocPercent: number;
}

/** How long the battery must ignore the request before it counts. */
export const HOLD_MS = 3 * 60_000;
/** Measurement noise and slow ramps. */
const MARGIN_W = 150;
const REACHED = 0.8;

function blocked(sample: PermissionSample): GridPermission | null {
  const { requestedW, batteryW } = sample;
  if (requestedW === null || Math.abs(requestedW) < 500) return null;
  const asked = Math.abs(requestedW);
  if (requestedW > 0) {
    if (sample.socPercent >= sample.stopSocPercent - 2) return null;
    if (sample.maxChargeW !== null && sample.maxChargeW < REACHED * asked) return null;
    const solarLeft = Math.max(0, sample.pvW - sample.homeW);
    // Solar alone could not deliver this, and the battery takes no more than solar gives.
    if (solarLeft + MARGIN_W >= REACHED * asked) return null;
    return batteryW < REACHED * asked && batteryW <= solarLeft + MARGIN_W ? 'grid_recharging' : null;
  }
  if (sample.socPercent <= sample.stopSocPercent + 2) return null;
  if (sample.maxDischargeW !== null && sample.maxDischargeW < REACHED * asked) return null;
  const discharging = Math.max(0, -batteryW);
  // The home alone could not take this, and the battery gives no more than the home uses.
  if (sample.homeW + MARGIN_W >= REACHED * asked) return null;
  return discharging < REACHED * asked && discharging <= sample.homeW + MARGIN_W ? 'export_power' : null;
}

export class GridPermissionCheck {
  private issue: GridPermission | null = null;
  private since = 0;
  private lastAt = 0;
  private reported = false;

  /** Returns the permission that is missing, once per continuous episode of HOLD_MS. */
  add(sample: PermissionSample, pollIntervalMs: number): GridPermission | null {
    const issue = blocked(sample);
    const gap = this.lastAt > 0 && sample.at - this.lastAt > 3 * pollIntervalMs;
    this.lastAt = sample.at;
    if (issue === null || issue !== this.issue || gap) {
      this.issue = issue;
      this.since = sample.at;
      this.reported = false;
      return null;
    }
    if (this.reported || sample.at - this.since < HOLD_MS) return null;
    this.reported = true;
    return issue;
  }
}
