import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BLOCKS,
  batteryPowerForHomey,
  byteVersion,
  decodeControl,
  decodeEnergy,
  decodeIdentity,
  decodeLimits,
  decodePhases,
  decodeStatus,
  dispatchFromTargetPower,
  encodeI32,
  encodeU32,
  firmwareAtLeast,
  decodeGridState,
  decodePowerLimits,
  hasActiveLimit,
  i16,
  i32,
  str,
  targetPowerFromDispatch,
  u32,
  u64,
} from '../lib/registers.mts';

/** Builds a register block, filling the given absolute addresses. */
function block(start: number, length: number, values: Record<number, number | number[]>): number[] {
  const words = new Array<number>(length).fill(0);
  for (const [address, value] of Object.entries(values)) {
    const list = Array.isArray(value) ? value : [value];
    list.forEach((v, i) => {
      words[Number(address) - start + i] = v;
    });
  }
  return words;
}

function ascii(text: string, registers: number): number[] {
  const padded = text.padEnd(registers * 2, '\0');
  return Array.from({ length: registers }, (_, i) => (padded.charCodeAt(i * 2) << 8) | padded.charCodeAt(i * 2 + 1));
}

describe('primitive decoders', () => {
  it('decodes signed and unsigned values big-endian, high word first', () => {
    assert.equal(i16([0xffff], 0), -1);
    assert.equal(i16([0x7fff], 0), 32767);
    assert.equal(u32([0x0001, 0x0000], 0), 65536);
    assert.equal(i32([0xffff, 0xfc18], 0), -1000);
    assert.equal(i32([0x0000, 0x03e8], 0), 1000);
    assert.equal(u64([0, 0, 0x0001, 0x86a0], 0), 100000);
  });

  it('reads strings and trims padding', () => {
    assert.equal(str(ascii('MG1234567', 10), 0, 10), 'MG1234567');
    assert.equal(str(ascii('01.01.00.28', 15), 0, 15), '01.01.00.28');
  });

  it('formats byte versions like the spec examples', () => {
    assert.equal(byteVersion(0x0200), '2.0');
    assert.equal(byteVersion(0x0101), '1.1');
  });

  it('throws when an offset is outside the block', () => {
    assert.throws(() => u32([1], 0), RangeError);
  });
});

describe('encoders', () => {
  it('round-trips I32 and U32', () => {
    for (const value of [0, 1, -1, 3500, -3500, 0x7fffffff, -0x80000000]) {
      assert.equal(i32(encodeI32(value), 0), value);
    }
    assert.equal(u32(encodeU32(7500), 0), 7500);
  });

  it('rejects out-of-range and fractional values', () => {
    assert.throws(() => encodeU32(-1), RangeError);
    assert.throws(() => encodeU32(1.5), RangeError);
    assert.throws(() => encodeI32(0x80000000), RangeError);
  });
});

describe('decodeIdentity', () => {
  it('decodes 60000–60032', () => {
    const words = block(BLOCKS.identity.start, BLOCKS.identity.length, {
      60000: ascii('MC100TEST01', 10),
      60010: 0x0200,
      60011: ascii('01.01.00.28.15', 15),
      60026: 0x0101,
      60027: [0x0000, 0x0fa0], // 4.000 kW
      60029: [0x0000, 0x1d4c], // 7.500 kW
      60031: [0x0000, 0x36b0], // 14.000 kWh
    });
    assert.deepEqual(decodeIdentity(words), {
      serial: 'MC100TEST01',
      hardwareVersion: '2.0',
      firmwareVersion: '01.01.00.28.15',
      protocolVersion: '1.1',
      ratedPvPowerW: 4000,
      ratedStoragePowerW: 7500,
      storageCapacityKwh: 14,
    });
  });
});

describe('decodeStatus', () => {
  it('maps documented enum values', () => {
    const words = block(BLOCKS.status.start, BLOCKS.status.length, {
      60066: 1,
      60067: 1,
      60068: 10,
      60069: [0, 2500],
      60071: encodeI32(-1800),
      60073: encodeI32(-650),
    });
    const status = decodeStatus(words);
    assert.equal(status.stationFault, true);
    assert.equal(status.storageStatus, 'charging');
    assert.equal(status.storageMode, 'remote');
    assert.equal(status.pvPowerW, 2500);
    assert.equal(status.storagePowerW, -1800);
    assert.equal(status.gridPowerW, -650);
  });

  it('returns null for undocumented enum values and keeps the raw value', () => {
    const words = block(BLOCKS.status.start, BLOCKS.status.length, { 60066: 7, 60067: 3, 60068: 4 });
    const status = decodeStatus(words);
    assert.equal(status.stationFault, null);
    assert.equal(status.storageStatus, null);
    assert.equal(status.storageMode, null);
    assert.deepEqual(status.raw, { stationStatus: 7, storageStatus: 3, storageMode: 4 });
  });

  it('maps idle (99) and the local modes', () => {
    const words = block(BLOCKS.status.start, BLOCKS.status.length, { 60067: 99, 60068: 2 });
    assert.equal(decodeStatus(words).storageStatus, 'idle');
    assert.equal(decodeStatus(words).storageMode, 'time_of_use');
    assert.equal(decodeStatus(words).stationFault, false);
  });
});

describe('decodePhases', () => {
  it('scales voltage ×10 and current ×100', () => {
    const words = block(BLOCKS.phases.start, BLOCKS.phases.length, {
      60089: 2312,
      60090: 0xfe0c, // -5.00 A
      60095: 57,
    });
    const phases = decodePhases(words);
    assert.deepEqual(phases.phases[0], { voltageV: 231.2, currentA: -5 });
    assert.deepEqual(phases.phases[1], { voltageV: 0, currentA: 0 });
    assert.equal(phases.socPercent, 57);
  });
});

describe('decodeEnergy', () => {
  it('scales kWh ×100 for U64 totals and U32 daily values', () => {
    const words = block(BLOCKS.energy.start, BLOCKS.energy.length, {
      60160: [0, 0, 0x0001, 0x2345], // 74565 → 745.65 kWh
      60164: [0, 1234],
      60166: [0, 0, 0, 500],
      60170: [0, 5],
      60172: [0, 0, 0, 400],
      60176: [0, 4],
      60178: [0, 0, 0, 300],
      60182: [0, 3],
      60184: [0, 0, 0, 200],
      60188: [0, 2],
    });
    assert.deepEqual(decodeEnergy(words), {
      pvTotalKwh: 745.65,
      pvTodayKwh: 12.34,
      chargedTotalKwh: 5,
      chargedTodayKwh: 0.05,
      dischargedTotalKwh: 4,
      dischargedTodayKwh: 0.04,
      exportedTotalKwh: 3,
      exportedTodayKwh: 0.03,
      importedTotalKwh: 2,
      importedTodayKwh: 0.02,
    });
  });
});

describe('decodeLimits', () => {
  it('treats 60200/60202 as kW ×100', () => {
    const words = block(BLOCKS.limits.start, BLOCKS.limits.length, { 60200: [0, 750], 60202: [0, 900] });
    assert.deepEqual(decodeLimits(words), { maxChargePowerW: 7500, maxDischargePowerW: 9000 });
  });
});

describe('decodeControl', () => {
  it('decodes 60301–60304 and 60310–60317', () => {
    const control = block(BLOCKS.control.start, BLOCKS.control.length, { 60301: 1, 60304: 505 });
    const forced = block(BLOCKS.forced.start, BLOCKS.forced.length, {
      60310: 2,
      60311: 1,
      60312: 90,
      60313: 60,
      60314: [0, 2000],
      60316: encodeI32(-2500),
    });
    const decoded = decodeControl(control, forced);
    assert.equal(decoded.remoteControl, true);
    assert.equal(decoded.activePowerPercent, 50.5);
    assert.equal(decoded.forcedCommand, 'exit');
    assert.equal(decoded.forcedMode, 'duration');
    assert.equal(decoded.forcedTargetSoc, 90);
    assert.equal(decoded.forcedDurationMin, 60);
    assert.equal(decoded.forcedPowerW, 2000);
    assert.equal(decoded.dispatchPowerW, -2500);
  });
});

describe('firmware gating (spec V1.6 notes)', () => {
  it('compares dotted versions numerically', () => {
    assert.equal(firmwareAtLeast('01.01.00.23.10', '01.01.00.25'), false); // real MC100, 2026-09-28
    assert.equal(firmwareAtLeast('01.01.00.25', '01.01.00.25'), true);
    assert.equal(firmwareAtLeast('01.01.00.28.15', '01.01.00.25'), true);
    assert.equal(firmwareAtLeast('01.01.01.00', '01.01.00.29'), true);
    assert.equal(firmwareAtLeast('', '01.01.00.25'), false);
    assert.equal(firmwareAtLeast('garbage', '01.01.00.25'), false);
  });
});

describe('decodePowerLimits (V1.3)', () => {
  it('reads W and maps 0xFFFFFFFF to no limit (as seen on a real MC100)', () => {
    const none = decodePowerLimits(new Array(10).fill(0xffff));
    assert.deepEqual(none, {
      charge: null, discharge: null, pv: null, export: null, import: null,
    });
    assert.equal(hasActiveLimit(none), false);
    const some = decodePowerLimits([0xffff, 0xffff, 0, 400, 0xffff, 0xffff, 0, 0, 0xffff, 0xffff]);
    assert.deepEqual(some, {
      charge: null, discharge: 400, pv: null, export: 0, import: null,
    });
    assert.equal(hasActiveLimit(some), true);
  });
});

describe('decodeGridState (V1.5)', () => {
  it('maps on/off grid and running status', () => {
    assert.deepEqual(decodeGridState([0, 0, 1]), { offGrid: false, runningStatus: 'charging' });
    assert.deepEqual(decodeGridState([1, 0, 4]), { offGrid: true, runningStatus: 'faulty' });
    assert.deepEqual(decodeGridState([7, 0, 9]), { offGrid: null, runningStatus: null });
  });
});

describe('sign conventions', () => {
  it('inverts battery power for Homey (charging positive)', () => {
    assert.equal(batteryPowerForHomey(-1800), 1800);
    assert.equal(batteryPowerForHomey(1200), -1200);
    assert.equal(Object.is(batteryPowerForHomey(0), 0), true);
  });

  it('maps target_power to the dispatch register and back', () => {
    assert.equal(dispatchFromTargetPower(3000), -3000);
    assert.equal(dispatchFromTargetPower(-2000), 2000);
    assert.equal(Object.is(dispatchFromTargetPower(0), 0), true);
    assert.equal(targetPowerFromDispatch(-3000), 3000);
  });
});
