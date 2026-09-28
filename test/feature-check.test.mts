import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import GridStateCheck from '../lib/feature-check.mts';
import type { GridState } from '../lib/registers.mts';

const state = (runningStatus: GridState['runningStatus'], offGrid = false): GridState => ({ offGrid, runningStatus });

describe('GridStateCheck', () => {
  it('trusts gateways at the documented firmware immediately', () => {
    const check = new GridStateCheck(true);
    assert.deepEqual(check.check(state('idle'), 'idle'), state('idle'));
  });

  it('trusts older firmware after the running status followed the charging state', () => {
    const check = new GridStateCheck(false);
    assert.equal(check.check(state('charging'), 'charging'), null);
    assert.equal(check.check(state('idle'), 'idle'), null); // idle proves nothing
    assert.equal(check.check(state('charging'), 'charging'), null);
    assert.deepEqual(check.check(state('discharging'), 'discharging'), state('discharging'));
    assert.equal(check.trusted, true);
  });

  it('never trusts registers that contradict the charging state', () => {
    const check = new GridStateCheck(false);
    for (let i = 0; i < 10; i += 1) assert.equal(check.check(state('idle'), 'charging'), null);
    for (let i = 0; i < 10; i += 1) check.check(state('discharging'), 'charging');
    assert.equal(check.trusted, false);
  });

  it('tolerates a rare mismatch from reading the registers a moment apart', () => {
    const check = new GridStateCheck(false);
    for (let i = 0; i < 20; i += 1) check.check(state('charging'), 'charging');
    check.check(state('charging'), 'discharging');
    assert.equal(check.trusted, true);
  });
});
