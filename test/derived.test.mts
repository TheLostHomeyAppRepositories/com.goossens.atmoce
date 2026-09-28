import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Hysteresis,
  consumptionTodayKwh,
  crossed,
  equivalentFullCycles,
  homeConsumptionW,
  minutesToEmpty,
  minutesToFull,
  selfSufficiencyTodayPercent,
  storedEnergyKwh,
} from '../lib/derived.mts';
import { LimitLearner } from '../lib/limit-learner.mts';
import type { Energy } from '../lib/registers.mts';

const energy = (overrides: Partial<Energy>): Energy => ({
  pvTotalKwh: 0,
  pvTodayKwh: 0,
  chargedTotalKwh: 0,
  chargedTodayKwh: 0,
  dischargedTotalKwh: 0,
  dischargedTodayKwh: 0,
  exportedTotalKwh: 0,
  exportedTodayKwh: 0,
  importedTotalKwh: 0,
  importedTodayKwh: 0,
  ...overrides,
});

describe('home consumption', () => {
  it('matches the first reading of a real MC100 (PV 5494, battery −4127, grid 0)', () => {
    assert.equal(homeConsumptionW({ pvPowerW: 5494, storagePowerW: -4127, gridPowerW: 0 }), 1367);
  });

  it('includes import and battery discharge, and never goes negative', () => {
    assert.equal(homeConsumptionW({ pvPowerW: 0, storagePowerW: 800, gridPowerW: 300 }), 1100);
    assert.equal(homeConsumptionW({ pvPowerW: 100, storagePowerW: 0, gridPowerW: -150 }), 0);
  });

  it('computes today from the daily counters', () => {
    const today = energy({
      pvTodayKwh: 3.82, importedTodayKwh: 2.35, exportedTodayKwh: 0.02, chargedTodayKwh: 2.68, dischargedTodayKwh: 0.04,
    });
    assert.equal(consumptionTodayKwh(today), 3.51);
  });
});

describe('self-sufficiency', () => {
  it('is the share not taken from the grid', () => {
    assert.equal(selfSufficiencyTodayPercent(energy({ pvTodayKwh: 8, importedTodayKwh: 2, exportedTodayKwh: 2 })), 75);
    assert.equal(selfSufficiencyTodayPercent(energy({ importedTodayKwh: 5 })), 0);
    assert.equal(selfSufficiencyTodayPercent(energy({ pvTodayKwh: 6, exportedTodayKwh: 2 })), 100);
  });

  it('is null before anything was consumed', () => {
    assert.equal(selfSufficiencyTodayPercent(energy({})), null);
  });
});

describe('battery estimates', () => {
  it('stored energy from SOC and capacity', () => {
    assert.equal(storedEnergyKwh(45, 14), 6.3);
  });

  it('time to full while charging, null otherwise', () => {
    assert.equal(minutesToFull(45, 14, 4127), 112); // 7.7 kWh / 4.127 kW
    assert.equal(minutesToFull(45, 14, 20), null);
    assert.equal(minutesToFull(45, 14, -2000), null);
  });

  it('time to empty while discharging, null otherwise', () => {
    assert.equal(minutesToEmpty(50, 14, -1400), 300);
    assert.equal(minutesToEmpty(50, 14, 1400), null);
  });

  it('respects the charge and discharge limits from Atmozen', () => {
    assert.equal(minutesToEmpty(50, 14, -1400, 10), 240); // 40 % usable instead of 50 %
    assert.equal(minutesToEmpty(8, 14, -1400, 10), 0); // already below the reserve
    assert.equal(minutesToFull(45, 14, 4127, 95), 102);
    assert.equal(minutesToFull(97, 14, 4127, 95), 0);
  });
});

describe('battery cycles', () => {
  it('counts equivalent full cycles from the lifetime discharge', () => {
    assert.equal(equivalentFullCycles(0, 14), 0);
    assert.equal(equivalentFullCycles(7, 14), 0.5);
    assert.equal(equivalentFullCycles(1234.56, 14), 88.2);
  });

  it('is unknown without a capacity', () => {
    assert.equal(equivalentFullCycles(100, 0), null);
  });
});

describe('crossed', () => {
  it('detects a crossing once', () => {
    assert.equal(crossed(19, 21, 20, 'above'), true);
    assert.equal(crossed(21, 22, 20, 'above'), false);
    assert.equal(crossed(21, 19, 20, 'below'), true);
    assert.equal(crossed(null, 19, 20, 'below'), false);
  });
});

describe('Hysteresis', () => {
  it('reports transitions only, ignoring values inside the band', () => {
    const exporting = new Hysteresis((w) => w >= 50, (w) => w < 20);
    assert.equal(exporting.update(0), null); // initial state: off
    assert.equal(exporting.update(40), null);
    assert.equal(exporting.update(60), 'started');
    assert.equal(exporting.update(30), null); // inside the band: still on
    assert.equal(exporting.active, true);
    assert.equal(exporting.update(10), 'stopped');
    assert.equal(exporting.update(45), null);
  });

  it('starts in the state of the first value without triggering', () => {
    const producing = new Hysteresis((w) => w >= 20, (w) => w < 5);
    assert.equal(producing.update(5000), null);
    assert.equal(producing.active, true);
  });
});

describe('LimitLearner', () => {
  const at = (socPercent: number, maxChargePowerW: number, maxDischargePowerW: number, commanded = false) => ({
    socPercent, maxChargePowerW, maxDischargePowerW, commanded,
  });

  it('learns the discharge limit after it holds for 6 polls', () => {
    const learner = new LimitLearner();
    const results = Array.from({ length: 7 }, () => learner.observe(at(10, 7500, 0)));
    assert.deepEqual(results.slice(0, 5), [null, null, null, null, null]);
    assert.deepEqual(results[5], { kind: 'discharge', percent: 10 });
    assert.equal(results[6], null); // reported once
  });

  it('learns a charge limit below 100 %', () => {
    const learner = new LimitLearner();
    let result = null;
    for (let i = 0; i < 6; i += 1) result = learner.observe(at(95, 0, 9940));
    assert.deepEqual(result, { kind: 'charge', percent: 95 });
  });

  it('ignores the both-zero pause seen on a real MC100, commanded periods and interruptions', () => {
    const learner = new LimitLearner();
    for (let i = 0; i < 10; i += 1) assert.equal(learner.observe(at(71, 0, 0)), null);
    for (let i = 0; i < 10; i += 1) assert.equal(learner.observe(at(10, 7500, 0, true)), null);
    for (let i = 0; i < 5; i += 1) learner.observe(at(10, 7500, 0));
    assert.equal(learner.observe(at(10, 7500, 9940)), null); // discharge allowed again: reset
    assert.equal(learner.observe(at(10, 7500, 0)), null);
  });

  it('ignores normal operation and a full battery', () => {
    const learner = new LimitLearner();
    for (let i = 0; i < 10; i += 1) assert.equal(learner.observe(at(75, 7500, 9940)), null);
    for (let i = 0; i < 10; i += 1) assert.equal(learner.observe(at(100, 0, 9940)), null);
  });
});
