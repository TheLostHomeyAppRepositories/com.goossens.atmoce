/**
 * Decides whether the V1.5 status registers (60096 on/off grid, 60098 running status) can be
 * trusted on a gateway, by what they report rather than by firmware version.
 *
 * Spec V1.6 says they need firmware ≥ 01.01.00.25, but a real MC100 on 01.01.00.23.10
 * answered them with values that followed the charging state. Reading is harmless, so the
 * app checks the values instead: while the documented storage status (60067) says charging or
 * discharging, 60098 must say the same. After a few agreements (and hardly any disagreement,
 * which the two registers being read a moment apart can cause) the registers are trusted.
 * Gateways at the documented firmware are trusted immediately.
 */
import type { GridState, StorageStatus } from './registers.mts';

const AGREEMENTS_NEEDED = 3;
/** Tolerated disagreements per agreement (status can change between the two reads). */
const MAX_DISAGREEMENT_RATIO = 0.1;

export default class GridStateCheck {

  private agreements = 0;
  private disagreements = 0;
  private readonly trustedByFirmware: boolean;

  constructor(trustedByFirmware: boolean) {
    this.trustedByFirmware = trustedByFirmware;
  }

  get trusted(): boolean {
    if (this.trustedByFirmware) return true;
    return this.agreements >= AGREEMENTS_NEEDED && this.disagreements <= this.agreements * MAX_DISAGREEMENT_RATIO;
  }

  /** Feeds one poll; returns the grid state when it can be trusted, otherwise null. */
  check(gridState: GridState, storageStatus: StorageStatus | null): GridState | null {
    const moving = storageStatus === 'charging' || storageStatus === 'discharging';
    const reported = gridState.runningStatus === 'charging' || gridState.runningStatus === 'discharging';
    if (moving && reported) {
      if (gridState.runningStatus === storageStatus) this.agreements += 1;
      else this.disagreements += 1;
    }
    return this.trusted ? gridState : null;
  }

}
