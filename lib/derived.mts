/**
 * Values the app derives from the gateway's documented registers, plus the edge detection
 * used by threshold Flow cards. Pure functions, unit-tested.
 */
import type { Energy, Status } from './registers.mts';

/** Below this battery power (W) the battery counts as idle for time estimates. */
const MIN_BATTERY_POWER_W = 50;

/**
 * House load: everything produced or imported that is not exported or stored.
 * PV + grid (+ import) + battery (gateway sign: + discharging). Clamped at 0 because the
 * three registers are sampled at slightly different moments.
 */
export function homeConsumptionW(status: Pick<Status, 'pvPowerW' | 'gridPowerW' | 'storagePowerW'>): number {
  return Math.max(0, status.pvPowerW + status.gridPowerW + status.storagePowerW);
}

/** House consumption today from the gateway's daily counters (kWh). */
export function consumptionTodayKwh(energy: Energy): number {
  const value = energy.pvTodayKwh + energy.importedTodayKwh - energy.exportedTodayKwh
    + energy.dischargedTodayKwh - energy.chargedTodayKwh;
  return Math.max(0, Math.round(value * 100) / 100);
}

/**
 * Share of today's house consumption not taken from the grid, in %.
 * null until the house has used something today.
 */
export function selfSufficiencyTodayPercent(energy: Energy): number | null {
  const consumption = consumptionTodayKwh(energy);
  if (consumption <= 0) return null;
  const fromGrid = Math.min(energy.importedTodayKwh, consumption);
  return Math.round((1 - fromGrid / consumption) * 100);
}

/** Energy in the batteries (kWh), from SOC and total capacity. */
export function storedEnergyKwh(socPercent: number, capacityKwh: number): number {
  return Math.round(((socPercent / 100) * capacityKwh) * 100) / 100;
}

/**
 * Equivalent full cycles: lifetime energy discharged ÷ total capacity, one decimal.
 * The gateway's counter starts at its installation. null without a known capacity.
 */
export function equivalentFullCycles(dischargedTotalKwh: number, capacityKwh: number): number | null {
  if (capacityKwh <= 0) return null;
  return Math.round((dischargedTotalKwh / capacityKwh) * 10) / 10;
}

/**
 * Minutes until the charge limit / discharge limit is reached at the current battery power
 * (Homey sign: + charging). null when the battery is not moving in that direction.
 * The gateway does not report the cut-off SOC set in Atmozen, so the limits are device
 * settings (default 100 % and 0 %).
 */
export function minutesToFull(socPercent: number, capacityKwh: number, batteryPowerW: number, chargeLimitPercent = 100): number | null {
  if (batteryPowerW < MIN_BATTERY_POWER_W || capacityKwh <= 0) return null;
  const missingWh = (Math.max(0, chargeLimitPercent - socPercent) / 100) * capacityKwh * 1000;
  return Math.round((missingWh / batteryPowerW) * 60);
}

export function minutesToEmpty(socPercent: number, capacityKwh: number, batteryPowerW: number, dischargeLimitPercent = 0): number | null {
  if (batteryPowerW > -MIN_BATTERY_POWER_W || capacityKwh <= 0) return null;
  const usableWh = (Math.max(0, socPercent - dischargeLimitPercent) / 100) * capacityKwh * 1000;
  return Math.round((usableWh / -batteryPowerW) * 60);
}

/** True when `current` crossed `level` in the given direction since `previous`. */
export function crossed(previous: number | null, current: number, level: number, direction: 'above' | 'below'): boolean {
  if (previous === null) return false;
  return direction === 'above'
    ? previous <= level && current > level
    : previous >= level && current < level;
}

/**
 * On/off state with hysteresis, so values hovering around a threshold do not flap.
 * `update` returns 'started' / 'stopped' on a transition, otherwise null. The first value
 * only sets the initial state.
 */
export class Hysteresis {

  private state: boolean | null = null;
  private readonly isOn: (value: number) => boolean;
  private readonly isOff: (value: number) => boolean;

  constructor(isOn: (value: number) => boolean, isOff: (value: number) => boolean) {
    this.isOn = isOn;
    this.isOff = isOff;
  }

  get active(): boolean {
    return this.state === true;
  }

  update(value: number): 'started' | 'stopped' | null {
    if (this.state === null) {
      this.state = this.isOn(value);
      return null;
    }
    if (!this.state && this.isOn(value)) {
      this.state = true;
      return 'started';
    }
    if (this.state && this.isOff(value)) {
      this.state = false;
      return 'stopped';
    }
    return null;
  }

}

/** Thresholds (W) for the started/stopped Flow cards. */
export const THRESHOLDS = {
  /** Solar production: started at ≥ 20 W, stopped below 5 W. */
  production: { on: 20, off: 5 },
  /** Grid export / import: started at ≥ 50 W, stopped below 20 W. */
  grid: { on: 50, off: 20 },
} as const;
