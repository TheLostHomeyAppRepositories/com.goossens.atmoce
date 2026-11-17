/**
 * Battery control state shared by Homey's standard capabilities and the forced-run Flow cards.
 * One source of truth: `target_power_mode` / `target_power` always show who controls the
 * battery, also during a forced run, and a forced run restores the previous control when it
 * ends. Pure, unit-tested.
 *
 * Verified on an MC100 (fw 01.01.00.29.03, 2026-11-17):
 * - a forced run ends by itself: 60310 returns to 2 (or 4 with power limits) when the target
 *   SOC is reached or the duration has passed, and its parameters are cleared;
 * - a forced run overrides remote dispatch: with 60310 = 0 at 1500 W, 60301 = 1 and
 *   60316 = 0 kept the battery charging at 1500 W. So dispatch must end the run first.
 */
import type { ForcedCommand } from './registers.mts';

export type TargetPowerMode = 'device' | 'homey';

/** What the standard capabilities show: `targetW` in the Homey convention (+ charge, − discharge). */
export interface ControlState {
  mode: TargetPowerMode;
  targetW: number;
}

/** A forced charge/discharge started from a Flow, with the control to restore afterwards. */
export interface ForcedRun {
  direction: 'charge' | 'discharge';
  powerW: number;
  previous: ControlState;
  /** When the forced command was written; snapshots taken before it say nothing about the run. */
  startedAt: number;
}

/** Homey commands the battery at ±P while the run executes. */
export function forcedRunState(run: Pick<ForcedRun, 'direction' | 'powerW'>): ControlState {
  return { mode: 'homey', targetW: run.direction === 'charge' ? run.powerW : -run.powerW };
}

/**
 * The run is over once a snapshot taken after it started no longer shows it: the gateway ended
 * it (target SOC, duration), or something else replaced it (exit, standby, the other direction).
 */
export function forcedRunEnded(run: ForcedRun, snapshotStartedAt: number, forcedCommand: ForcedCommand | null): boolean {
  if (snapshotStartedAt <= run.startedAt) return false;
  return forcedCommand !== run.direction;
}

/**
 * Forced commands that override remote dispatch and have to end before a dispatch setpoint
 * means anything. Self-consumption (4) is how the app keeps power limits accepted; it leaves
 * dispatch alone.
 */
export function overridesDispatch(forcedCommand: ForcedCommand | null): boolean {
  return forcedCommand === 'charge' || forcedCommand === 'discharge' || forcedCommand === 'standby';
}

/** The control to remember when a forced run starts: a run started during another keeps the first one's. */
export function controlBeforeRun(running: ForcedRun | null, current: ControlState): ControlState {
  return running?.previous ?? current;
}
