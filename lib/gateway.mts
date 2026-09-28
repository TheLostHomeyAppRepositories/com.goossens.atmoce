import { EventEmitter } from 'node:events';

import WrongGatewayError from './errors.mts';
import GridStateCheck from './feature-check.mts';
import {
  type Endpoint,
  type Logger,
  ModbusConnection,
  errorMessage,
} from './modbus-connection.mts';
import {
  BLOCKS,
  FORCED_COMMAND,
  FORCED_DURATION_MAX_MIN,
  FORCED_MODE,
  WRITE,
  type Control,
  type Energy,
  FIRMWARE,
  type GridState,
  type Identity,
  type Limits,
  NO_LIMIT,
  POWER_LIMIT_REGISTER,
  type Phases,
  type PowerLimitKind,
  type PowerLimits,
  type RegisterBlock,
  type Status,
  decodeControl,
  decodeEnergy,
  decodeGridState,
  decodeIdentity,
  decodeLimits,
  decodePhases,
  decodePowerLimits,
  decodeStatus,
  dispatchFromTargetPower,
  encodeI32,
  encodeU32,
  firmwareAtLeast,
  hasActiveLimit,
} from './registers.mts';

export interface Snapshot {
  status: Status;
  phases: Phases;
  energy: Energy;
  /** Optional blocks: null when this gateway does not answer them (older firmware). */
  limits: Limits | null;
  control: Control | null;
  /** V1.5 grid/battery state; null until it proved trustworthy (see GridStateCheck). */
  gridState: GridState | null;
  /** V1.3 power limits as read back from the gateway; null when not readable. */
  powerLimits: PowerLimits | null;
  /**
   * When the poll started. Every read of this snapshot was queued after any write issued
   * before this moment (the connection serialises requests), so it reflects those writes.
   */
  startedAt: number;
}

/** Timer functions from `this.homey`, so timers are cleared when the app stops. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface GatewayOptions {
  endpoint: Endpoint;
  pollIntervalMs: number;
  /** Serial the paired devices belong to. A different gateway at the address is an error. */
  expectedSerial: string;
  timers: Timers;
  logger: Logger;
}

export type ForcedTarget =
  | { kind: 'target_soc'; socPercent: number; powerW: number }
  | { kind: 'duration'; minutes: number; powerW: number };

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Consecutive failed polls before devices are marked unavailable (single blips only log). */
const FAILURES_BEFORE_UNAVAILABLE = 3;
/** Consecutive failures before an optional block counts as unsupported by this gateway. */
const OPTIONAL_FAILURES_BEFORE_SKIP = 3;
/** Unsupported optional blocks are tried again after this (a firmware update may add them). */
const OPTIONAL_RETRY_MS = 60 * 60 * 1000;

export type OptionalBlock = 'limits' | 'control' | 'forced' | 'gridState' | 'powerLimits';
const OPTIONAL_BLOCKS: readonly OptionalBlock[] = ['limits', 'control', 'forced', 'gridState', 'powerLimits'];

/** yes: answers; no: skipped as unsupported; unknown: not read successfully yet. */
export type BlockSupport = 'yes' | 'no' | 'unknown';

/** Re-assert the self-consumption mode needed for active limits at most this often. */
const LIMIT_MODE_REASSERT_MS = 5 * 60 * 1000;

/**
 * Reads the gateway identity once. Used by pairing and by settings validation.
 */
export async function readIdentity(connection: ModbusConnection): Promise<Identity> {
  const words = await connection.readRegisters(BLOCKS.identity.start, BLOCKS.identity.length);
  const identity = decodeIdentity(words);
  if (!identity.serial) throw new Error('The device at this address did not report an Atmoce serial number');
  return identity;
}

/**
 * One Atmoce gateway (MG100, or the gateway inside an MC100 / MC100-T).
 *
 * Events:
 * - `snapshot` (Snapshot): after every successful poll
 * - `identity` (Identity): after (re)connecting
 * - `available` / `unavailable` (reason: string)
 * - `stop`: the gateway was released (no devices left)
 */
export class AtmoceGateway extends EventEmitter {

  identity: Identity | null = null;
  snapshot: Snapshot | null = null;
  lastError: string | null = null;
  /** Since when polls succeed; null while unavailable. */
  connectedSince: number | null = null;
  /** Since when the gateway is unavailable; null while available. */
  unavailableSince: number | null = null;
  /** Last failed poll, kept after recovery for diagnostics. */
  lastFailure: { at: number; message: string } | null = null;
  /** Poll attempts and failures since the app started. */
  readonly stats = { polls: 0, failed: 0 };

  private connection: ModbusConnection;
  private options: GatewayOptions;
  private timer: unknown = null;
  private polling: Promise<void> | null = null;
  private failures = 0;
  /** Start of the first poll in the current run of failures. */
  private failingSince = 0;
  private available = false;
  private stopped = true;
  private refreshRequested = false;
  /** connectionCount at which the identity was last verified. */
  private identityConnection = -1;
  private readonly reportedCodes = new Set<string>();
  private readonly optionalFailures = new Map<OptionalBlock, number>();
  private readonly optionalSkippedUntil = new Map<OptionalBlock, number>();
  private readonly optionalAnswered = new Set<OptionalBlock>();
  private gridStateCheck: GridStateCheck | null = null;
  /** The app put 60310 in self-consumption (4) so the gateway accepts the power limits. */
  private limitModeOwned = false;
  private limitModeAssertedAt = 0;

  constructor(options: GatewayOptions) {
    super();
    this.options = options;
    this.connection = new ModbusConnection(options.endpoint, options.logger);
  }

  get endpoint(): Readonly<Endpoint> {
    return this.options.endpoint;
  }

  get serial(): string {
    return this.options.expectedSerial;
  }

  get pollIntervalMs(): number {
    return this.options.pollIntervalMs;
  }

  get isAvailable(): boolean {
    return this.available;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    this.emit('stop');
    await this.polling?.catch(() => undefined);
    await this.connection.close();
  }

  /** Applies new connection settings; reconnects when the endpoint changed. */
  async reconfigure(endpoint: Endpoint, pollIntervalMs: number): Promise<void> {
    this.options = { ...this.options, pollIntervalMs };
    const current = this.options.endpoint;
    if (current.host === endpoint.host && current.port === endpoint.port && current.unitId === endpoint.unitId) {
      this.schedule(0);
      return;
    }
    const old = this.connection;
    this.options = { ...this.options, endpoint };
    this.connection = new ModbusConnection(endpoint, this.options.logger);
    this.identity = null;
    this.identityConnection = -1;
    await old.close();
    this.schedule(0);
  }

  /** V1.3 power limits (60318–60326) need firmware ≥ FIRMWARE.powerLimits (spec V1.6). */
  get supportsPowerLimits(): boolean {
    return this.identity !== null && firmwareAtLeast(this.identity.firmwareVersion, FIRMWARE.powerLimits);
  }

  /** Which optional register blocks this gateway answers, with their start address. */
  get blockSupport(): Array<{ block: OptionalBlock; start: number; support: BlockSupport }> {
    return OPTIONAL_BLOCKS.map((block) => {
      let support: BlockSupport = 'unknown';
      if (this.optionalSkippedUntil.has(block)) support = 'no';
      else if (this.optionalAnswered.has(block)) support = 'yes';
      return { block, start: BLOCKS[block].start, support };
    });
  }

  /**
   * Reads the identity now, queued behind a running poll, and times it (connecting included
   * when the connection was down). Rejects when the gateway does not answer or another
   * gateway took over the address.
   */
  async testConnection(): Promise<{ identity: Identity; roundTripMs: number }> {
    const started = Date.now();
    const identity = await readIdentity(this.connection);
    const roundTripMs = Date.now() - started;
    if (identity.serial !== this.options.expectedSerial) throw new WrongGatewayError(this.options.expectedSerial, identity.serial);
    return { identity, roundTripMs };
  }

  /** Polls now instead of waiting for the next interval (e.g. after a write). */
  refresh(): void {
    if (this.polling) {
      this.refreshRequested = true;
    } else {
      this.schedule(0);
    }
  }

  // -------------------------------------------------------------------------
  // Battery control (table 3.1 #43–#52)
  // -------------------------------------------------------------------------

  /**
   * Remote dispatch: switch #43 to remote communication, then write the dispatch power
   * #52. `targetPowerW` uses the Homey convention (+ charge, − discharge).
   */
  async setDispatchPower(targetPowerW: number): Promise<void> {
    await this.write(WRITE.communicationControlMode, [1]);
    await this.write(WRITE.dispatchPower, encodeI32(dispatchFromTargetPower(targetPowerW)));
    this.refresh();
  }

  /**
   * Leave remote dispatch: dispatch power 0, then #43 back to local (self-consumption / TOU).
   * With power limits active, 60310 goes to self-consumption so the gateway keeps them.
   */
  async resumeLocalControl(): Promise<void> {
    await this.write(WRITE.dispatchPower, encodeI32(0));
    await this.write(WRITE.communicationControlMode, [0]);
    if (this.limitsActive() && this.snapshot?.control?.forcedCommand === 'exit') await this.enterLimitMode();
    this.refresh();
  }

  /**
   * Forced charging/discharging (#47–#51). Parameters are written before the command so the
   * gateway never starts a forced run with stale parameters.
   */
  async force(direction: 'charge' | 'discharge', target: ForcedTarget): Promise<void> {
    const powerW = Math.round(target.powerW);
    await this.write(WRITE.forcedPower, encodeU32(powerW));
    if (target.kind === 'target_soc') {
      await this.write(WRITE.forcedTargetSoc, [clampInteger(target.socPercent, 0, 100)]);
      await this.write(WRITE.forcedMode, [FORCED_MODE.targetSoc]);
    } else {
      await this.write(WRITE.forcedDuration, [clampInteger(target.minutes, 0, FORCED_DURATION_MAX_MIN)]);
      await this.write(WRITE.forcedMode, [FORCED_MODE.duration]);
    }
    await this.write(WRITE.forcedCommand, [FORCED_COMMAND[direction]]);
    this.refresh();
  }

  /** Ends a forced run. With power limits active the gateway stays in self-consumption (4). */
  async stopForced(): Promise<void> {
    if (this.limitsActive()) {
      await this.enterLimitMode();
    } else {
      await this.write(WRITE.forcedCommand, [FORCED_COMMAND.exit]);
      this.limitModeOwned = false;
    }
    this.refresh();
  }

  /**
   * Sets (W) or removes (null) one V1.3 power limit. The gateway only accepts them while
   * 60301 = 1 or 60310 ≠ 2 (spec V1.6), so in normal operation 60310 is first set to
   * self-consumption (4) — the battery keeps its normal behaviour — and set back to exit (2)
   * when the last limit is removed.
   */
  async setPowerLimit(kind: PowerLimitKind, watts: number | null): Promise<void> {
    const current = this.snapshot?.powerLimits ?? {
      charge: null, discharge: null, pv: null, export: null, import: null,
    };
    const next = { ...current, [kind]: watts };
    if (hasActiveLimit(next)) await this.ensureLimitsAccepted();
    const raw = watts === null ? NO_LIMIT : clampInteger(watts, 0, NO_LIMIT - 1);
    await this.write(POWER_LIMIT_REGISTER[kind], encodeU32(raw));
    if (this.snapshot) this.snapshot = { ...this.snapshot, powerLimits: next };
    if (!hasActiveLimit(next)) await this.leaveLimitMode();
    this.refresh();
  }

  private limitsActive(): boolean {
    return hasActiveLimit(this.snapshot?.powerLimits ?? null);
  }

  private async ensureLimitsAccepted(): Promise<void> {
    const control = this.snapshot?.control;
    if (control?.remoteControl) return;
    if (control && control.forcedCommand !== 'exit' && control.forcedCommand !== null) return;
    await this.enterLimitMode();
  }

  private async enterLimitMode(): Promise<void> {
    await this.write(WRITE.forcedCommand, [FORCED_COMMAND.selfConsumption]);
    this.limitModeOwned = true;
    this.limitModeAssertedAt = Date.now();
  }

  private async leaveLimitMode(): Promise<void> {
    const forced = this.snapshot?.control?.forcedCommand;
    if (!this.limitModeOwned && forced !== 'self_consumption') return;
    await this.write(WRITE.forcedCommand, [FORCED_COMMAND.exit]);
    this.limitModeOwned = false;
  }

  /**
   * The gateway may return 60310 to exit (2) by itself (e.g. after a restart), which would
   * silently disable active limits. Re-assert self-consumption, at most every 5 minutes.
   */
  private async keepLimitsEnforced(snapshot: Snapshot): Promise<void> {
    const { control } = snapshot;
    if (!this.supportsPowerLimits || !hasActiveLimit(snapshot.powerLimits) || !control) return;
    if (control.remoteControl || control.forcedCommand !== 'exit') return;
    if (Date.now() - this.limitModeAssertedAt < LIMIT_MODE_REASSERT_MS) return;
    this.options.logger.log('Power limits active but the gateway left self-consumption mode; re-asserting');
    await this.enterLimitMode().catch((err) => this.options.logger.error('Re-asserting limit mode failed:', errorMessage(err)));
  }

  private async write(address: number, values: number[]): Promise<void> {
    this.options.logger.log(`Write ${address} = [${values.join(', ')}]`);
    if (values.length === 1) {
      await this.connection.writeRegister(address, values[0] as number);
    } else {
      await this.connection.writeRegisters(address, values);
    }
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.clearTimer();
    this.timer = this.options.timers.setTimeout(() => {
      this.timer = null;
      this.polling ??= this.poll().finally(() => {
        this.polling = null;
        const delay = this.refreshRequested ? 0 : this.options.pollIntervalMs;
        this.refreshRequested = false;
        this.schedule(delay);
      });
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.options.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    const startedAt = Date.now();
    this.stats.polls += 1;
    try {
      await this.verifyIdentity();
      // Core blocks (spec V1.0): a failure fails the poll.
      const read = (block: RegisterBlock) => this.connection.readRegisters(block.start, block.length);
      const status = decodeStatus(await read(BLOCKS.status));
      const phases = decodePhases(await read(BLOCKS.phases));
      const energy = decodeEnergy(await read(BLOCKS.energy));
      // Optional blocks: missing on some firmware; their features simply stay inactive.
      const limitWords = await this.readOptional('limits');
      const controlWords = await this.readOptional('control');
      const forcedWords = await this.readOptional('forced');
      const gridWords = await this.readOptional('gridState');
      const powerLimitWords = await this.readOptional('powerLimits');
      const limits = limitWords ? decodeLimits(limitWords) : null;
      const control = controlWords && forcedWords ? decodeControl(controlWords, forcedWords) : null;
      const gridState = gridWords ? this.checkGridState(decodeGridState(gridWords), status) : null;
      const powerLimits = powerLimitWords ? decodePowerLimits(powerLimitWords) : null;

      this.reportUndocumented(status);

      this.snapshot = {
        status, phases, energy, limits, control, gridState, powerLimits, startedAt,
      };
      this.failures = 0;
      this.lastError = null;
      if (!this.available) {
        this.available = true;
        this.connectedSince = Date.now();
        this.unavailableSince = null;
        this.emit('available');
      }
      this.emit('snapshot', this.snapshot);
      await this.keepLimitsEnforced(this.snapshot);
    } catch (err) {
      this.failures += 1;
      if (this.failures === 1) this.failingSince = startedAt;
      this.stats.failed += 1;
      this.lastError = errorMessage(err);
      this.lastFailure = { at: Date.now(), message: this.lastError };
      this.options.logger.error(`Poll failed (${this.failures}x): ${this.lastError}`);
      const immediate = err instanceof WrongGatewayError;
      if (this.available && (immediate || this.failures >= FAILURES_BEFORE_UNAVAILABLE)) {
        this.available = false;
        this.connectedSince = null;
        this.unavailableSince = this.failingSince;
        this.emit('unavailable', this.lastError);
      } else if (!this.available && this.failures === 1) {
        // Not yet reachable since start: report right away instead of waiting.
        this.unavailableSince ??= startedAt;
        this.emit('unavailable', this.lastError);
      }
    }
  }

  /** Uses the V1.5 status registers only once they prove trustworthy (see GridStateCheck). */
  private checkGridState(gridState: GridState, status: Status): GridState | null {
    if (!this.gridStateCheck) {
      const byFirmware = this.identity ? firmwareAtLeast(this.identity.firmwareVersion, FIRMWARE.gridState) : false;
      this.gridStateCheck = new GridStateCheck(byFirmware);
    }
    const wasTrusted = this.gridStateCheck.trusted;
    const checked = this.gridStateCheck.check(gridState, status.storageStatus);
    if (!wasTrusted && checked) this.options.logger.log('On/off-grid and battery running status (60096/60098) confirmed; enabled');
    return checked;
  }

  /**
   * Reads an optional block. Unknown addresses make this gateway time out rather than answer
   * with an exception, so a block is skipped after a few consecutive failures while the core
   * blocks keep working, and retried hourly (firmware updates can add registers).
   */
  private async readOptional(name: OptionalBlock): Promise<number[] | null> {
    const skippedUntil = this.optionalSkippedUntil.get(name) ?? 0;
    if (Date.now() < skippedUntil) return null;
    const block = BLOCKS[name];
    try {
      const words = await this.connection.readRegisters(block.start, block.length);
      if (skippedUntil) this.options.logger.log(`Optional block ${name} (${block.start}) answers again`);
      this.optionalFailures.delete(name);
      this.optionalSkippedUntil.delete(name);
      this.optionalAnswered.add(name);
      return words;
    } catch (err) {
      const failures = (this.optionalFailures.get(name) ?? 0) + 1;
      this.optionalFailures.set(name, failures);
      if (failures >= OPTIONAL_FAILURES_BEFORE_SKIP) {
        this.optionalFailures.delete(name);
        this.optionalSkippedUntil.set(name, Date.now() + OPTIONAL_RETRY_MS);
        this.options.logger.log(`Optional block ${name} (${block.start}) not supported by this gateway (${errorMessage(err)}); retrying in 1 h`);
      }
      return null;
    }
  }

  /**
   * (Re)reads the identity after every reconnect: picks up firmware updates and notices
   * when another gateway took over the address.
   */
  private async verifyIdentity(): Promise<void> {
    if (this.identity && this.identityConnection === this.connection.connectionCount) return;
    const identity = await readIdentity(this.connection);
    if (identity.serial !== this.options.expectedSerial) {
      throw new WrongGatewayError(this.options.expectedSerial, identity.serial);
    }
    this.identityConnection = this.connection.connectionCount;
    const changed = JSON.stringify(identity) !== JSON.stringify(this.identity);
    if (changed && this.identity && this.identity.firmwareVersion !== identity.firmwareVersion) this.gridStateCheck = null;
    this.identity = identity;
    if (changed) this.emit('identity', identity);
  }

  /** Logs enum values the spec does not document, once per value. */
  private reportUndocumented(status: Status): void {
    const unknown: Array<[string, number]> = [];
    if (status.stationFault === null) unknown.push(['station status (60066)', status.raw.stationStatus]);
    if (status.storageStatus === null) unknown.push(['storage status (60067)', status.raw.storageStatus]);
    if (status.storageMode === null) unknown.push(['storage mode (60068)', status.raw.storageMode]);
    for (const [name, value] of unknown) {
      const key = `${name}=${value}`;
      if (this.reportedCodes.has(key)) continue;
      this.reportedCodes.add(key);
      this.options.logger.log(`Undocumented ${name} value ${value}`);
    }
  }

}
