/**
 * Atmoce gateway register map and decoders.
 *
 * Sources: "Atmoce Gateway Modbus Protocol Interface Description" V1.2 (2025-10-23) and
 * "Atmoce Gateway and SCU Modbus Protocol Interface Description" V1.6 (2026-04-18), both in
 * docs/. "#n" refers to the "Serial Number" column of table 3.1 in V1.2; registers added
 * later say "V1.x". V1.6 gates some registers on a minimum gateway firmware
 * (see FIRMWARE and firmwareAtLeast).
 *
 * - All registers are holding registers (read with 0x03), big-endian, word order
 *   high word first (§1.1).
 * - Addresses are used on the wire exactly as printed (60000 = 0xEA60).
 * - "Multiplier" means raw = value × multiplier, so a "kW × 1000" register is raw watts.
 * - Blocks below only span registers the spec lists; reserved rows are never read.
 *
 * Everything in this file is pure so it can be unit-tested without a gateway.
 */

export interface RegisterBlock {
  readonly start: number;
  readonly length: number;
}

/** Contiguous read blocks. The spec allows up to 125 registers per read (§4.4). */
export const BLOCKS = {
  /** #1–#7: SN … storage capacity. Static, read once per connection. */
  identity: { start: 60000, length: 33 },
  /** #12–#19: station status … storage reactive power. */
  status: { start: 60066, length: 13 },
  /** #21–#27: phase voltages/currents and SOC. */
  phases: { start: 60089, length: 7 },
  /** #29–#38: lifetime and daily energy counters. */
  energy: { start: 60160, length: 30 },
  /** #40–#41: max charge/discharge power limits. */
  limits: { start: 60200, length: 4 },
  /** #43–#45: communication control mode and active power regulation. */
  control: { start: 60301, length: 4 },
  /** #47–#52: forced charge/discharge and dispatch power. */
  forced: { start: 60310, length: 8 },
  /** V1.5: on/off-grid status 60096, (reserved 60097), running status 60098. Firmware ≥ .25. */
  gridState: { start: 60096, length: 3 },
  /** V1.3: max charge 60318, max discharge 60320, PV max 60322, export max 60324, import max 60326. */
  powerLimits: { start: 60318, length: 10 },
} as const satisfies Record<string, RegisterBlock>;

/** Minimum gateway firmware per feature, from the notes in spec V1.6. */
export const FIRMWARE = {
  gridState: '01.01.00.25',
  /** 60318–60326; the gateway only accepts them while 60301 = 1 or 60310 ≠ 2. */
  powerLimits: '01.01.00.29',
} as const;

/**
 * Compares dotted firmware versions numerically ("01.01.00.23.10" ≥ "01.01.00.25"?).
 * Missing trailing parts count as 0; an unparsable version never qualifies.
 */
export function firmwareAtLeast(version: string, minimum: string): boolean {
  const parse = (v: string) => v.split('.').map((part) => Number.parseInt(part, 10));
  const a = parse(version);
  const b = parse(minimum);
  if (a.length === 0 || a.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Writable registers (RW / WO in table 3.1). */
export const WRITE = {
  /** #43 U16. 0 = local (self-consumption / TOU as set in Atmozen), 1 = remote communication. */
  communicationControlMode: 60301,
  /** #47 U16. 0 = forced charging, 1 = forced discharging, 2 = exit. */
  forcedCommand: 60310,
  /** #48 U16. 0 = until target SOC, 1 = for a duration. */
  forcedMode: 60311,
  /** #49 U16 %, [0, 100]. */
  forcedTargetSoc: 60312,
  /** #50 U16 minutes, [0, 1440]. */
  forcedDuration: 60313,
  /** #51 U32 kW × 1000 (= W). */
  forcedPower: 60314,
  /** #52 I32 kW × 1000 (= W). < 0 charging, > 0 discharging, 0 idle. */
  dispatchPower: 60316,
  /** V1.3, U32 kW × 1000 (= W); 0xFFFFFFFF = no limit. */
  maxChargePower: 60318,
  maxDischargePower: 60320,
  maxPvPower: 60322,
  maxExportPower: 60324,
  maxImportPower: 60326,
} as const;

/** 60310 values. 4 and 99 were added in spec V1.3. */
export const FORCED_COMMAND = {
  charge: 0, discharge: 1, exit: 2, selfConsumption: 4, standby: 99,
} as const;
/** 0xFFFFFFFF in a V1.3 power limit register means "no limit". */
export const NO_LIMIT = 0xffffffff;
export const FORCED_MODE = { targetSoc: 0, duration: 1 } as const;
export const FORCED_DURATION_MAX_MIN = 1440;

export type StorageStatus = 'charging' | 'discharging' | 'idle';
export type StorageMode = 'self_consumption' | 'time_of_use' | 'remote';
export type ForcedCommand = 'charge' | 'discharge' | 'exit' | 'self_consumption' | 'standby';

// ---------------------------------------------------------------------------
// Primitive decoders. `words` is the register block; `offset` is relative to it.
// ---------------------------------------------------------------------------

function word(words: readonly number[], offset: number): number {
  const value = words[offset];
  if (value === undefined) {
    throw new RangeError(`Register offset ${offset} outside block of ${words.length}`);
  }
  return value & 0xffff;
}

export function u16(words: readonly number[], offset: number): number {
  return word(words, offset);
}

export function i16(words: readonly number[], offset: number): number {
  const value = word(words, offset);
  return value >= 0x8000 ? value - 0x10000 : value;
}

export function u32(words: readonly number[], offset: number): number {
  return word(words, offset) * 0x10000 + word(words, offset + 1);
}

export function i32(words: readonly number[], offset: number): number {
  const value = u32(words, offset);
  return value >= 0x80000000 ? value - 0x100000000 : value;
}

/** U64 as a Number. Energy counters (kWh × 100) stay far below 2^53. */
export function u64(words: readonly number[], offset: number): number {
  let value = 0n;
  for (let i = 0; i < 4; i += 1) {
    value = (value << 16n) | BigInt(word(words, offset + i));
  }
  return Number(value);
}

/** ASCII string, two characters per register, high byte first; trailing NUL/space trimmed. */
export function str(words: readonly number[], offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const value = word(words, offset + i);
    out += String.fromCharCode(value >> 8, value & 0xff);
  }
  // eslint-disable-next-line no-control-regex
  return out.replace(/[\u0000\s]+$/u, '').replace(/\u0000/gu, '');
}

/** 0x0200 → "2.0", 0x0101 → "1.1" (examples from #2 and #4). */
export function byteVersion(value: number): string {
  return `${value >> 8}.${value & 0xff}`;
}

/** Scaled value rounded to the register's resolution, avoiding float noise like 0.30000000000000004. */
function scale(raw: number, divisor: number): number {
  return Math.round(raw) / divisor;
}

// ---------------------------------------------------------------------------
// Block decoders
// ---------------------------------------------------------------------------

export interface Identity {
  serial: string;
  hardwareVersion: string;
  firmwareVersion: string;
  protocolVersion: string;
  /** Sum of rated power of all microinverters (#5). */
  ratedPvPowerW: number;
  /** Sum of rated power of all batteries (#6). */
  ratedStoragePowerW: number;
  /** Sum of capacity of all batteries (#7). */
  storageCapacityKwh: number;
}

export function decodeIdentity(words: readonly number[]): Identity {
  const o = (address: number) => address - BLOCKS.identity.start;
  return {
    serial: str(words, o(60000), 10),
    hardwareVersion: byteVersion(u16(words, o(60010))),
    firmwareVersion: str(words, o(60011), 15),
    protocolVersion: byteVersion(u16(words, o(60026))),
    ratedPvPowerW: u32(words, o(60027)),
    ratedStoragePowerW: u32(words, o(60029)),
    storageCapacityKwh: scale(u32(words, o(60031)), 1000),
  };
}

export interface Status {
  /** #12: 0 normal, 1 fault. null when the gateway reports an undocumented value. */
  stationFault: boolean | null;
  /** #13 */
  storageStatus: StorageStatus | null;
  /** #14 */
  storageMode: StorageMode | null;
  /** #15 */
  pvPowerW: number;
  /** #16, gateway sign convention (see batteryPowerForHomey). */
  storagePowerW: number;
  /** #17, gateway sign convention (see gridPowerForHomey). */
  gridPowerW: number;
  /** #18 */
  pvReactivePowerVar: number;
  /** #19 */
  storageReactivePowerVar: number;
  /** Raw enum values, kept for logging undocumented codes. */
  raw: { stationStatus: number; storageStatus: number; storageMode: number };
}

const STATION_FAULT: Readonly<Record<number, boolean>> = { 0: false, 1: true };
const STORAGE_STATUS: Readonly<Record<number, StorageStatus>> = { 1: 'charging', 2: 'discharging', 99: 'idle' };
const STORAGE_MODE: Readonly<Record<number, StorageMode>> = { 1: 'self_consumption', 2: 'time_of_use', 10: 'remote' };

export function decodeStatus(words: readonly number[]): Status {
  const o = (address: number) => address - BLOCKS.status.start;
  const stationStatus = u16(words, o(60066));
  const storageStatus = u16(words, o(60067));
  const storageMode = u16(words, o(60068));
  return {
    stationFault: STATION_FAULT[stationStatus] ?? null,
    storageStatus: STORAGE_STATUS[storageStatus] ?? null,
    storageMode: STORAGE_MODE[storageMode] ?? null,
    pvPowerW: u32(words, o(60069)),
    storagePowerW: i32(words, o(60071)),
    gridPowerW: i32(words, o(60073)),
    pvReactivePowerVar: i32(words, o(60075)),
    storageReactivePowerVar: i32(words, o(60077)),
    raw: { stationStatus, storageStatus, storageMode },
  };
}

export interface PhaseReading {
  voltageV: number;
  currentA: number;
}

export interface Phases {
  /** Phase A (or the single phase), B, C (#21–#26). */
  phases: [PhaseReading, PhaseReading, PhaseReading];
  /** #27, [0, 100] %. */
  socPercent: number;
}

export function decodePhases(words: readonly number[]): Phases {
  const o = (address: number) => address - BLOCKS.phases.start;
  const phase = (voltageAddress: number): PhaseReading => ({
    voltageV: scale(u16(words, o(voltageAddress)), 10),
    currentA: scale(i16(words, o(voltageAddress + 1)), 100),
  });
  return {
    phases: [phase(60089), phase(60091), phase(60093)],
    socPercent: u16(words, o(60095)),
  };
}

export interface Energy {
  pvTotalKwh: number;
  pvTodayKwh: number;
  chargedTotalKwh: number;
  chargedTodayKwh: number;
  dischargedTotalKwh: number;
  dischargedTodayKwh: number;
  /** "Electricity sales volume" (#35/#36). */
  exportedTotalKwh: number;
  exportedTodayKwh: number;
  /** "Electricity purchase volume" (#37/#38). */
  importedTotalKwh: number;
  importedTodayKwh: number;
}

export function decodeEnergy(words: readonly number[]): Energy {
  const o = (address: number) => address - BLOCKS.energy.start;
  const total = (address: number) => scale(u64(words, o(address)), 100);
  const today = (address: number) => scale(u32(words, o(address)), 100);
  return {
    pvTotalKwh: total(60160),
    pvTodayKwh: today(60164),
    chargedTotalKwh: total(60166),
    chargedTodayKwh: today(60170),
    dischargedTotalKwh: total(60172),
    dischargedTodayKwh: today(60176),
    exportedTotalKwh: total(60178),
    exportedTodayKwh: today(60182),
    importedTotalKwh: total(60184),
    importedTodayKwh: today(60188),
  };
}

export interface Limits {
  maxChargePowerW: number;
  maxDischargePowerW: number;
}

/** #40/#41 are kW × 100 (not × 1000 like the power registers), so W = raw × 10. */
export function decodeLimits(words: readonly number[]): Limits {
  const o = (address: number) => address - BLOCKS.limits.start;
  return {
    maxChargePowerW: u32(words, o(60200)) * 10,
    maxDischargePowerW: u32(words, o(60202)) * 10,
  };
}

export interface Control {
  /** #43: true when the gateway follows remote (Modbus) commands. */
  remoteControl: boolean;
  /** #44 */
  activePowerFixedW: number;
  /** #45 */
  activePowerPercent: number;
  /** #47: last forced command. */
  forcedCommand: ForcedCommand | null;
  /** #48 */
  forcedMode: 'target_soc' | 'duration' | null;
  /** #49 */
  forcedTargetSoc: number;
  /** #50 */
  forcedDurationMin: number;
  /** #51 */
  forcedPowerW: number;
  /** #52, gateway sign convention: < 0 charging, > 0 discharging. */
  dispatchPowerW: number;
}

const FORCED_COMMANDS: Readonly<Record<number, ForcedCommand>> = {
  0: 'charge', 1: 'discharge', 2: 'exit', 4: 'self_consumption', 99: 'standby',
};
const FORCED_MODES: Readonly<Record<number, 'target_soc' | 'duration'>> = { 0: 'target_soc', 1: 'duration' };

export function decodeControl(control: readonly number[], forced: readonly number[]): Control {
  const c = (address: number) => address - BLOCKS.control.start;
  const f = (address: number) => address - BLOCKS.forced.start;
  const command = u16(forced, f(60310));
  const mode = u16(forced, f(60311));
  return {
    remoteControl: u16(control, c(60301)) === 1,
    activePowerFixedW: i32(control, c(60302)),
    activePowerPercent: scale(u16(control, c(60304)), 10),
    forcedCommand: FORCED_COMMANDS[command] ?? null,
    forcedMode: FORCED_MODES[mode] ?? null,
    forcedTargetSoc: u16(forced, f(60312)),
    forcedDurationMin: u16(forced, f(60313)),
    forcedPowerW: u32(forced, f(60314)),
    dispatchPowerW: i32(forced, f(60316)),
  };
}

export type PowerLimitKind = 'charge' | 'discharge' | 'pv' | 'export' | 'import';

/** V1.3 power limits in W; null = no limit (0xFFFFFFFF). */
export type PowerLimits = Record<PowerLimitKind, number | null>;

export const POWER_LIMIT_REGISTER: Readonly<Record<PowerLimitKind, number>> = {
  charge: WRITE.maxChargePower,
  discharge: WRITE.maxDischargePower,
  pv: WRITE.maxPvPower,
  export: WRITE.maxExportPower,
  import: WRITE.maxImportPower,
};

export function decodePowerLimits(words: readonly number[]): PowerLimits {
  const o = (address: number) => address - BLOCKS.powerLimits.start;
  const limit = (address: number) => {
    const raw = u32(words, o(address));
    return raw === NO_LIMIT ? null : raw;
  };
  return {
    charge: limit(60318), discharge: limit(60320), pv: limit(60322), export: limit(60324), import: limit(60326),
  };
}

export function hasActiveLimit(limits: PowerLimits | null): boolean {
  return limits !== null && Object.values(limits).some((value) => value !== null);
}

export type RunningStatus = 'idle' | 'charging' | 'discharging' | 'shutdown' | 'faulty';

export interface GridState {
  /** V1.5 60096: 0 on grid, 1 off grid. */
  offGrid: boolean | null;
  /** V1.5 60098, appendix 1. */
  runningStatus: RunningStatus | null;
}

const OFF_GRID: Readonly<Record<number, boolean>> = { 0: false, 1: true };
const RUNNING_STATUS: Readonly<Record<number, RunningStatus>> = {
  0: 'idle', 1: 'charging', 2: 'discharging', 3: 'shutdown', 4: 'faulty',
};

export function decodeGridState(words: readonly number[]): GridState {
  const o = (address: number) => address - BLOCKS.gridState.start;
  return {
    offGrid: OFF_GRID[u16(words, o(60096))] ?? null,
    runningStatus: RUNNING_STATUS[u16(words, o(60098))] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Encoders for writes
// ---------------------------------------------------------------------------

export function encodeU32(value: number): [number, number] {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`U32 out of range: ${value}`);
  }
  return [Math.floor(value / 0x10000), value % 0x10000];
}

export function encodeI32(value: number): [number, number] {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new RangeError(`I32 out of range: ${value}`);
  }
  return encodeU32(value < 0 ? value + 0x100000000 : value);
}

// ---------------------------------------------------------------------------
// Sign conventions
// ---------------------------------------------------------------------------

/**
 * Homey home batteries report positive power while charging and negative while
 * discharging (Homey Energy docs, "Home batteries").
 *
 * The Modbus spec does not state the sign of #16 (60071). It does state the sign of
 * the dispatch register #52 (60316): "< 0 indicates charging, > 0 indicates
 * discharging", and the Atmoce-Cloud API Reference V1.2.5 (battery data, `power`) documents battery
 * power as "Positive number: battery being discharged". Both point to the same
 * convention for 60071, so it is inverted here.
 * VERIFY on hardware (tools/probe.mts compares the sign with #13 storage status).
 */
export function batteryPowerForHomey(storagePowerW: number): number {
  return storagePowerW === 0 ? 0 : -storagePowerW;
}

/**
 * Homey cumulative meters report positive power while importing from the grid.
 * No Atmoce document states the sign of #17 (60073). Existing third-party
 * integrations (evcc's atmoce template, the Home Assistant Atmoce_battery_HA
 * integration) treat positive as import, so it is passed through unchanged.
 * VERIFY on hardware (tools/probe.mts compares it with the import/export counters).
 */
export function gridPowerForHomey(gridPowerW: number): number {
  return gridPowerW;
}

/** Homey target_power (+ charge) → dispatch register #52 (< 0 charge). */
export function dispatchFromTargetPower(targetPowerW: number): number {
  return targetPowerW === 0 ? 0 : -Math.round(targetPowerW);
}

/** Dispatch register #52 (< 0 charge) → Homey target_power (+ charge). */
export function targetPowerFromDispatch(dispatchPowerW: number): number {
  return dispatchPowerW === 0 ? 0 : -dispatchPowerW;
}
