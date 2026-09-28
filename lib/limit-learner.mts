/**
 * Learns the charge / discharge limits set in Atmozen from the gateway's live limits.
 */
export interface LimitObservation {
  socPercent: number;
  /** Live limits 60200/60202 (the battery management system's current permission). */
  maxChargePowerW: number;
  maxDischargePowerW: number;
  /** Remote dispatch or a forced run is active: the battery follows commands, not its limits. */
  commanded: boolean;
}

export interface LearnedLimits {
  chargeLimitPercent: number | null;
  dischargeLimitPercent: number | null;
}

/** Consecutive polls (10 s default) a cut-off must hold before it is learned. */
const LEARN_POLLS = 6;

/**
 * Learns the charge / discharge limits set in Atmozen, which the gateway does not report.
 *
 * At the discharge limit the battery management system stops allowing discharge
 * (60202 → 0) while charging is still allowed (60200 > 0); at the charge limit the reverse.
 * Moments where both are 0 (seen on a real MC100 at 71 % during a pause) are ignored, as are
 * commanded periods. The SOC must be stable for LEARN_POLLS polls. A later, different
 * cut-off replaces the learned one, so a changed Atmozen setting is picked up by itself.
 */
export class LimitLearner {

  private candidate: { kind: 'charge' | 'discharge'; soc: number; polls: number } | null = null;

  /** Returns the limit learned by this observation, if any. */
  observe(observation: LimitObservation): { kind: 'charge' | 'discharge'; percent: number } | null {
    const kind = LimitLearner.kindOf(observation);
    if (!kind) {
      this.candidate = null;
      return null;
    }
    const soc = Math.round(observation.socPercent);
    if (this.candidate?.kind === kind && Math.abs(this.candidate.soc - soc) <= 1) {
      this.candidate.polls += 1;
    } else {
      this.candidate = { kind, soc, polls: 1 };
    }
    if (this.candidate.polls !== LEARN_POLLS) return null;
    return { kind, percent: this.candidate.soc };
  }

  private static kindOf({
    socPercent, maxChargePowerW, maxDischargePowerW, commanded,
  }: LimitObservation): 'charge' | 'discharge' | null {
    if (commanded) return null;
    if (maxDischargePowerW === 0 && maxChargePowerW > 0 && socPercent < 50) return 'discharge';
    if (maxChargePowerW === 0 && maxDischargePowerW > 0 && socPercent > 50 && socPercent < 100) return 'charge';
    return null;
  }

}
