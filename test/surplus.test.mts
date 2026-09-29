import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SurplusTracker } from '../lib/surplus.mts';

const POLL_MS = 10_000;
const MIN = 60_000;

const BATTERY_FIRST = { pollIntervalMs: POLL_MS, chargeCountsFromPercent: 100 };

/** Feeds `minutes` of polls with a fixed grid/battery power (Homey signs); returns the new time. */
function feed(tracker: SurplusTracker, from: number, minutes: number, gridW: number, batteryW = 0, socPercent = 50, options = BATTERY_FIRST): number {
  let at = from;
  for (let i = 0; i < (minutes * MIN) / POLL_MS; i++) {
    at += POLL_MS;
    tracker.add({
      at, gridW, batteryW, socPercent,
    }, options);
  }
  return at;
}

/** Like feed, but counts the polls at which `check` is true (how often a trigger would fire). */
function countFires(tracker: SurplusTracker, from: number, minutes: number, gridW: number, batteryW: number, check: () => boolean): { at: number; fires: number } {
  let at = from;
  let fires = 0;
  for (let i = 0; i < (minutes * MIN) / POLL_MS; i++) {
    at += POLL_MS;
    tracker.add({
      at, gridW, batteryW, socPercent: 50,
    }, BATTERY_FIRST);
    if (check()) fires += 1;
  }
  return { at, fires };
}

describe('SurplusTracker', () => {
  it('fires "surplus held" exactly once, after the full duration', () => {
    const tracker = new SurplusTracker();
    const { fires } = countFires(tracker, 0, 45, -2500, 0, () => tracker.surplusStarted(30, 2200));
    assert.equal(fires, 1);
    assert.equal(tracker.surplusHeld(30, 2200), true);
    assert.equal(tracker.current?.surplusW, 2500);
  });

  it('does not fire before the duration has passed', () => {
    const tracker = new SurplusTracker();
    feed(tracker, 0, 29, -2500);
    assert.equal(tracker.surplusHeld(30, 2200), false);
  });

  it('a short cloud does not reset the timer, a longer drop does', () => {
    const tracker = new SurplusTracker();
    let at = feed(tracker, 0, 20, -2500);
    at = feed(tracker, at, 0.5, -1500); // 30 s dip, the 2-minute average stays above 2200
    at = feed(tracker, at, 10, -2500);
    assert.equal(tracker.surplusHeld(30, 2200), true);
    at = feed(tracker, at, 3, 0); // 3 minutes without export
    feed(tracker, at, 20, -2500);
    assert.equal(tracker.surplusHeld(30, 2200), false);
  });

  it('battery charging is not surplus: only what reaches the grid counts', () => {
    const tracker = new SurplusTracker();
    feed(tracker, 0, 40, 0, 3000);
    assert.equal(tracker.surplusHeld(30, 200), false);
  });

  it('surplus ended: a full battery covering the home counts, not only grid import', () => {
    const tracker = new SurplusTracker();
    const at = feed(tracker, 0, 30, -2500);
    const { fires } = countFires(tracker, at, 10, 0, -600, () => tracker.surplusEnded(5));
    assert.equal(fires, 1);
  });

  it('surplus ended: grid import', () => {
    const tracker = new SurplusTracker();
    const { fires } = countFires(tracker, 0, 10, 300, 0, () => tracker.surplusEnded(5));
    assert.equal(fires, 1);
  });

  it('ignores battery noise below the deficit threshold', () => {
    const tracker = new SurplusTracker();
    feed(tracker, 0, 20, 9, -8);
    assert.equal(tracker.surplusEnded(5), false);
  });

  it('a gap in the data (gateway offline) breaks "held for"', () => {
    const tracker = new SurplusTracker();
    const at = feed(tracker, 0, 20, -2500);
    feed(tracker, at + 5 * MIN, 12, -2500);
    assert.equal(tracker.surplusHeld(30, 2200), false);
    assert.equal(tracker.surplusHeld(10, 2200), true);
  });

  it('0 minutes checks the current average only', () => {
    const tracker = new SurplusTracker();
    feed(tracker, 0, 3, -1000);
    assert.equal(tracker.surplusHeld(0, 900), true);
    assert.equal(tracker.surplusHeld(0, 1100), false);
  });

  it('supports the longest duration', () => {
    const tracker = new SurplusTracker();
    feed(tracker, 0, 250, -3000);
    assert.equal(tracker.surplusHeld(240, 2000), true);
  });
});

describe('SurplusTracker without a battery', () => {
  it('surplus is export and the stop signal is grid import', () => {
    const tracker = new SurplusTracker();
    const at = feed(tracker, 0, 35, -2500, 0);
    assert.equal(tracker.surplusHeld(30, 2200), true);
    const low = countFires(tracker, at, 2, -100, 0, () => tracker.surplusEnded(5));
    const importing = countFires(tracker, low.at, 8, 400, 0, () => tracker.surplusEnded(5));
    assert.equal(low.fires + importing.fires, 1);
  });
});

describe('SurplusTracker battery-first dial', () => {
  const FROM_80 = { pollIntervalMs: POLL_MS, chargeCountsFromPercent: 80 };

  it('below the dial the battery charges first: charging is not surplus', () => {
    const tracker = new SurplusTracker();
    feed(tracker, 0, 35, 0, 3000, 70, FROM_80);
    assert.equal(tracker.surplusHeld(30, 2200), false);
  });

  it('from the dial on, charging power counts as surplus too', () => {
    const tracker = new SurplusTracker();
    feed(tracker, 0, 35, -500, 2500, 85, FROM_80);
    assert.equal(tracker.current?.surplusW, 3000);
    assert.equal(tracker.surplusHeld(30, 2200), true);
  });

  it('at 100 % (default) only export counts, whatever the battery level', () => {
    const tracker = new SurplusTracker();
    feed(tracker, 0, 35, 0, 3000, 99);
    assert.equal(tracker.surplusHeld(30, 200), false);
  });

  it('has no effect without a battery', () => {
    const withDial = new SurplusTracker();
    const without = new SurplusTracker();
    feed(withDial, 0, 35, -2500, 0, 0, { pollIntervalMs: POLL_MS, chargeCountsFromPercent: 0 });
    feed(without, 0, 35, -2500, 0, 0);
    assert.deepEqual(withDial.current, without.current);
  });
});

describe('SurplusTracker triggers', () => {
  it('a Flow created or changed while the surplus already holds fires at the next poll', () => {
    const tracker = new SurplusTracker();
    const at = feed(tracker, 0, 40, -1300);
    // Nobody asked for 1000 W / 15 min until now (threshold was changed from 2500).
    const { fires } = countFires(tracker, at, 5, -1300, 0, () => tracker.surplusStarted(15, 1000));
    assert.equal(fires, 1);
  });

  it('Flows with the same arguments all fire at the same poll, and only once', () => {
    const tracker = new SurplusTracker();
    let firstFlow = 0;
    let secondFlow = 0;
    countFires(tracker, 0, 40, -2500, 0, () => {
      const a = tracker.surplusStarted(30, 2200);
      const b = tracker.surplusStarted(30, 2200);
      if (a) firstFlow += 1;
      if (b) secondFlow += 1;
      return a;
    });
    assert.equal(firstFlow, 1);
    assert.equal(secondFlow, 1);
  });

  it('fires again after the surplus was gone and came back', () => {
    const tracker = new SurplusTracker();
    let { at } = countFires(tracker, 0, 40, -2500, 0, () => tracker.surplusStarted(30, 2200));
    at = feed(tracker, at, 10, 500);
    const again = countFires(tracker, at, 40, -2500, 0, () => tracker.surplusStarted(30, 2200));
    assert.equal(again.fires, 1);
  });
});
