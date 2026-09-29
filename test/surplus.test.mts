import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SurplusTracker } from '../lib/surplus.mts';

const POLL_MS = 10_000;
const MIN = 60_000;

/** Feeds `minutes` of polls with a fixed grid/battery power (Homey signs); returns the new time. */
function feed(tracker: SurplusTracker, from: number, minutes: number, gridW: number, batteryW = 0): number {
  let at = from;
  for (let i = 0; i < (minutes * MIN) / POLL_MS; i++) {
    at += POLL_MS;
    tracker.add(at, gridW, batteryW, POLL_MS);
  }
  return at;
}

/** Like feed, but counts the polls at which `check` is true (how often a trigger would fire). */
function countFires(tracker: SurplusTracker, from: number, minutes: number, gridW: number, batteryW: number, check: () => boolean): { at: number; fires: number } {
  let at = from;
  let fires = 0;
  for (let i = 0; i < (minutes * MIN) / POLL_MS; i++) {
    at += POLL_MS;
    tracker.add(at, gridW, batteryW, POLL_MS);
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
