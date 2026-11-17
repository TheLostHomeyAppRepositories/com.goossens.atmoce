import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type ForcedRun, controlBeforeRun, forcedRunEnded, forcedRunState, overridesDispatch,
} from '../lib/battery-control.mts';

const RUN: ForcedRun = {
  direction: 'charge', powerW: 2500, previous: { mode: 'device', targetW: 0 }, startedAt: 1_000,
};

describe('battery control', () => {
  it('a forced run shows as Homey control at ±P', () => {
    assert.deepEqual(forcedRunState({ direction: 'charge', powerW: 2500 }), { mode: 'homey', targetW: 2500 });
    assert.deepEqual(forcedRunState({ direction: 'discharge', powerW: 1500 }), { mode: 'homey', targetW: -1500 });
  });

  it('a snapshot from before the write says nothing about the run', () => {
    assert.equal(forcedRunEnded(RUN, 900, 'exit'), false);
    assert.equal(forcedRunEnded(RUN, 1_000, 'exit'), false);
  });

  it('the run goes on while the gateway shows it', () => {
    assert.equal(forcedRunEnded(RUN, 2_000, 'charge'), false);
  });

  it('the run is over when the gateway ended it (measured: 2 after the target SOC or duration, 4 with limits)', () => {
    assert.equal(forcedRunEnded(RUN, 2_000, 'exit'), true);
    assert.equal(forcedRunEnded(RUN, 2_000, 'self_consumption'), true);
  });

  it('the run is over when something else replaced it', () => {
    assert.equal(forcedRunEnded(RUN, 2_000, 'discharge'), true);
    assert.equal(forcedRunEnded(RUN, 2_000, 'standby'), true);
    assert.equal(forcedRunEnded(RUN, 2_000, null), true);
  });

  it('only charge, discharge and standby override dispatch, not the limit mode', () => {
    assert.equal(overridesDispatch('charge'), true);
    assert.equal(overridesDispatch('discharge'), true);
    assert.equal(overridesDispatch('standby'), true);
    assert.equal(overridesDispatch('self_consumption'), false);
    assert.equal(overridesDispatch('exit'), false);
    assert.equal(overridesDispatch(null), false);
  });

  it('a run started during another remembers the control from before the first', () => {
    const current = { mode: 'homey' as const, targetW: 2500 };
    assert.deepEqual(controlBeforeRun(null, current), current);
    assert.deepEqual(controlBeforeRun({ ...RUN, previous: { mode: 'homey', targetW: 0 } }, current), { mode: 'homey', targetW: 0 });
  });
});
