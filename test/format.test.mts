import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatDuration, formatTime } from '../lib/format.mts';

const MIN = 60_000;

describe('formatDuration', () => {
  it('uses minutes, then hours, then days', () => {
    assert.equal(formatDuration(12 * MIN, 'en'), '12 min');
    assert.equal(formatDuration(125 * MIN, 'en'), '2 hr 5 min');
    assert.equal(formatDuration(120 * MIN, 'en'), '2 hr');
    assert.equal(formatDuration((3 * 24 + 4) * 60 * MIN, 'en'), '3 days 4 hr');
  });

  it('never shows zero', () => {
    assert.equal(formatDuration(5_000, 'en'), '1 min');
  });

  it('follows the Homey language', () => {
    assert.equal(formatDuration(125 * MIN, 'nl'), '2 uur 5 min');
    assert.notEqual(formatDuration(12 * MIN, 'ru'), formatDuration(12 * MIN, 'en'));
  });
});

describe('formatTime', () => {
  it('shows Homey time zone time', () => {
    const at = Date.UTC(2026, 8, 28, 12, 2);
    assert.match(formatTime(at, 'en-GB', 'Europe/Paris'), /28\/09\/2026, 14:02/);
    assert.match(formatTime(at, 'en-GB', 'UTC'), /12:02/);
  });
});
