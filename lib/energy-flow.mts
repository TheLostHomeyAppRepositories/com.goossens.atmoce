/**
 * Energy flow for the dashboard widget: where the power goes right now, derived from one
 * gateway snapshot with the same sign conventions and formulas as the devices.
 * Pure, unit-tested.
 */
import {
  consumptionTodayKwh,
  homeConsumptionW,
  minutesToEmpty,
  minutesToFull,
  selfSufficiencyTodayPercent,
} from './derived.mts';
import type { Snapshot } from './gateway.mts';
import { batteryPowerForHomey, gridPowerForHomey } from './registers.mts';

export interface EnergyFlow {
  serial: string;
  /** Node values in W. battery: + charging, − discharging; grid: + import, − export. */
  solarW: number;
  homeW: number;
  batteryW: number;
  gridW: number;
  socPercent: number;
  hasBattery: boolean;
  /** Estimates at the current battery power, up to the Atmozen limits when learned; null when not moving that way. */
  minutesToFull: number | null;
  minutesToEmpty: number | null;
  /** The same as clock times in Homey's language and time zone, filled in by the app. */
  fullAt: string | null;
  emptyAt: string | null;
  /** Flows between nodes in W (all ≥ 0). */
  flows: {
    solarToHome: number;
    solarToBattery: number;
    solarToGrid: number;
    batteryToHome: number;
    gridToHome: number;
    gridToBattery: number;
    batteryToGrid: number;
  };
  today: {
    producedKwh: number;
    consumedKwh: number;
    selfSufficiencyPercent: number | null;
  };
  receivedAt: number;
}

/** The batteries behind a gateway, for the time estimates. */
export interface BatteryInfo {
  capacityKwh: number;
  /** Learned Atmozen cut-offs (see LimitLearner); null until detected. */
  chargeLimitPercent: number | null;
  dischargeLimitPercent: number | null;
}

/**
 * Splits the node values into flows: solar serves the home first, then the battery, then
 * the grid; the rest of the home comes from the battery, then the grid. Measurement noise
 * between the registers is absorbed by clamping, so flows never go negative.
 */
export function energyFlow(serial: string, snapshot: Snapshot, battery: BatteryInfo | null): EnergyFlow {
  const hasBattery = battery !== null;
  const { status, phases, energy } = snapshot;
  const solarW = Math.max(0, status.pvPowerW);
  const batteryW = batteryPowerForHomey(status.storagePowerW);
  const gridW = gridPowerForHomey(status.gridPowerW);
  const homeW = homeConsumptionW(status);

  const charging = Math.max(0, batteryW);
  const discharging = Math.max(0, -batteryW);
  const importing = Math.max(0, gridW);
  const exporting = Math.max(0, -gridW);

  const solarToHome = Math.min(solarW, homeW);
  const solarToBattery = Math.min(solarW - solarToHome, charging);
  const solarToGrid = Math.min(solarW - solarToHome - solarToBattery, exporting);
  const batteryToHome = Math.min(discharging, homeW - solarToHome);
  const gridToHome = Math.min(importing, Math.max(0, homeW - solarToHome - batteryToHome));
  const gridToBattery = Math.min(importing - gridToHome, Math.max(0, charging - solarToBattery));
  const batteryToGrid = Math.min(Math.max(0, discharging - batteryToHome), Math.max(0, exporting - solarToGrid));

  const round = (w: number) => Math.max(0, Math.round(w));
  return {
    serial,
    solarW: round(solarW),
    homeW: round(homeW),
    batteryW: Math.round(batteryW),
    gridW: Math.round(gridW),
    socPercent: phases.socPercent,
    hasBattery,
    minutesToFull: battery
      ? minutesToFull(phases.socPercent, battery.capacityKwh, batteryW, battery.chargeLimitPercent ?? 100)
      : null,
    minutesToEmpty: battery
      ? minutesToEmpty(phases.socPercent, battery.capacityKwh, batteryW, battery.dischargeLimitPercent ?? 0)
      : null,
    flows: {
      solarToHome: round(solarToHome),
      solarToBattery: round(solarToBattery),
      solarToGrid: round(solarToGrid),
      batteryToHome: round(batteryToHome),
      gridToHome: round(gridToHome),
      gridToBattery: round(gridToBattery),
      batteryToGrid: round(batteryToGrid),
    },
    today: {
      producedKwh: energy.pvTodayKwh,
      consumedKwh: consumptionTodayKwh(energy),
      selfSufficiencyPercent: selfSufficiencyTodayPercent(energy),
    },
    fullAt: null,
    emptyAt: null,
    receivedAt: snapshot.startedAt,
  };
}
