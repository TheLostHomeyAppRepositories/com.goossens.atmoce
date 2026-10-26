import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatClockIn, formatDuration, formatTime } from '../lib/format.mts';

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

describe('formatClockIn', () => {
  const now = Date.UTC(2026, 8, 30, 13, 2); // Wed 30 Sep, 15:02 in Paris (CEST)
  it('uses the 24-hour clock in Dutch and the 12-hour clock in English', () => {
    assert.equal(formatClockIn(137, now, 'nl', 'Europe/Paris').time, '17:20');
    assert.match(formatClockIn(137, now, 'en', 'Europe/Paris').time, /^5:20\s?PM$/);
  });

  it('follows Homey\'s time zone and rounds to 5 minutes', () => {
    assert.equal(formatClockIn(137, now, 'nl', 'UTC').time, '15:20');
    assert.equal(formatClockIn(139, now, 'nl', 'Europe/Paris').time, '17:20');
  });

  it('later today is today', () => {
    assert.deepEqual(formatClockIn(137, now, 'nl', 'Europe/Paris'), { time: '17:20', dayOffset: 0, day: null });
  });

  it('after midnight is tomorrow, even less than 24 hours ahead (seen 2026-10-25: 22:52 → 20:25)', () => {
    const evening = Date.UTC(2026, 9, 25, 21, 52); // Sun 25 Oct, 22:52 in Paris (CET, after the DST change)
    assert.deepEqual(formatClockIn(21 * 60 + 33, evening, 'nl', 'Europe/Paris'), { time: '20:25', dayOffset: 1, day: null });
    assert.deepEqual(formatClockIn(30, evening, 'nl', 'Europe/Paris'), { time: '23:20', dayOffset: 0, day: null });
    assert.equal(formatClockIn(70, evening, 'nl', 'Europe/Paris').dayOffset, 1); // 00:00 is tomorrow
  });

  it('names the weekday 2 to 6 days ahead and the date a week or more ahead', () => {
    const later = formatClockIn(50 * 60, now, 'nl', 'Europe/Paris'); // Fri 2 Oct, 17:00
    assert.equal(later.dayOffset, 2);
    assert.equal(later.day, 'vrijdag');
    const week = formatClockIn(8 * 24 * 60, now, 'nl', 'Europe/Paris'); // Thu 8 Oct
    assert.equal(week.dayOffset, 8);
    assert.match(week.day ?? '', /^8 okt\.?$/);
  });
});
