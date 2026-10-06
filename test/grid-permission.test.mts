import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GridPermissionCheck, type PermissionSample } from '../lib/grid-permission.mts';

const POLL_MS = 10_000;
const MIN = 60_000;

const BASE: Omit<PermissionSample, 'at'> = {
  requestedW: 3000,
  batteryW: 0,
  pvW: 0,
  homeW: 400,
  socPercent: 40,
  maxChargeW: 7400,
  maxDischargeW: 9700,
  stopSocPercent: 100,
};

/** Feeds `minutes` of identical polls; returns what the check reported. */
function run(sample: Partial<PermissionSample>, minutes = 5, check = new GridPermissionCheck()): (string | null)[] {
  const reports: (string | null)[] = [];
  for (let at = 0; at <= minutes * MIN; at += POLL_MS) {
    const result = check.add({ ...BASE, ...sample, at }, POLL_MS);
    if (result) reports.push(result);
  }
  return reports;
}

describe('GridPermissionCheck', () => {
  it('grid recharging off, measured 2026-10-06: forced 3000 W, battery follows the sun', () => {
    // 09:41 on an MC100: PV 1711 W, home ±600 W, battery 1110 W, grid 0.
    assert.deepEqual(run({ pvW: 1711, homeW: 601, batteryW: 1110 }), ['grid_recharging']);
  });

  it('grid recharging off at night: nothing charges', () => {
    assert.deepEqual(run({ pvW: 0, homeW: 400, batteryW: 0 }), ['grid_recharging']);
  });

  it('grid recharging on, measured: 2995 W with the grid adding ±1220 W', () => {
    assert.deepEqual(run({ pvW: 2595, homeW: 825, batteryW: 2995 }), []);
  });

  it('enough sun to deliver the request: no way to tell, so no report', () => {
    assert.deepEqual(run({ pvW: 3159, homeW: 608, batteryW: 2524 }), []);
  });

  it('battery (nearly) at its target or limited by its own live limit: no report', () => {
    assert.deepEqual(run({ socPercent: 99 }), []);
    assert.deepEqual(run({ maxChargeW: 1000 }), []);
  });

  it('export off, measured 2026-10-06: forced discharge 3000 W stays at 0 W in the sun', () => {
    assert.deepEqual(run({
      requestedW: -3000, pvW: 3716, homeW: 597, batteryW: 0, stopSocPercent: 5,
    }), ['export_power']);
  });

  it('export off at night: the battery only covers the home', () => {
    assert.deepEqual(run({
      requestedW: -3000, pvW: 0, homeW: 500, batteryW: -500, stopSocPercent: 5,
    }), ['export_power']);
  });

  it('export on: discharging at the requested power', () => {
    assert.deepEqual(run({
      requestedW: -3000, pvW: 0, homeW: 500, batteryW: -2990, stopSocPercent: 5,
    }), []);
  });

  it('needs three minutes, reports once per episode, and again after the request changes', () => {
    assert.deepEqual(run({}, 2.5), []);
    const check = new GridPermissionCheck();
    assert.deepEqual(run({}, 10, check), ['grid_recharging']);
    check.add({ ...BASE, requestedW: null, at: 11 * MIN }, POLL_MS);
    const again: (string | null)[] = [];
    for (let at = 11 * MIN + POLL_MS; at <= 15 * MIN; at += POLL_MS) {
      const result = check.add({ ...BASE, at }, POLL_MS);
      if (result) again.push(result);
    }
    assert.deepEqual(again, ['grid_recharging']);
  });

  it('a gap in the data (gateway offline) restarts the three minutes', () => {
    const check = new GridPermissionCheck();
    const results: (string | null)[] = [];
    for (const at of [0, 60_000, 120_000, 600_000, 660_000]) results.push(check.add({ ...BASE, at }, POLL_MS));
    assert.deepEqual(results.filter(Boolean), []);
  });

  it('nothing asked or a small request: no report', () => {
    assert.deepEqual(run({ requestedW: null }), []);
    assert.deepEqual(run({ requestedW: 300 }), []);
  });
});
