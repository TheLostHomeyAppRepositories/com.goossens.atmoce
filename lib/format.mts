/**
 * Localised durations and times for timeline notifications and diagnostics settings.
 * Uses the Intl API of Homey's Node.js (full ICU), so every Homey language is covered.
 */

const MINUTE_MS = 60_000;
const HOUR_MIN = 60;
const DAY_MIN = 24 * HOUR_MIN;

function unit(value: number, name: 'minute' | 'hour' | 'day', language: string): string {
  return new Intl.NumberFormat(language, { style: 'unit', unit: name, unitDisplay: 'short' }).format(value);
}

/** "12 min", "2 hr 5 min", "3 days 4 hr" (in `language`); at least one minute. */
export function formatDuration(ms: number, language: string): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  if (minutes < HOUR_MIN) return unit(minutes, 'minute', language);
  if (minutes < DAY_MIN) {
    const rest = minutes % HOUR_MIN;
    const hours = unit(Math.floor(minutes / HOUR_MIN), 'hour', language);
    return rest ? `${hours} ${unit(rest, 'minute', language)}` : hours;
  }
  const rest = Math.floor((minutes % DAY_MIN) / HOUR_MIN);
  const days = unit(Math.floor(minutes / DAY_MIN), 'day', language);
  return rest ? `${days} ${unit(rest, 'hour', language)}` : days;
}

/** A clock time and the calendar day it falls on, as seen from today in Homey's time zone. */
export interface ClockTime {
  /** "20:25" or "8:25 PM". */
  time: string;
  /** 0 today, 1 tomorrow, 2 the day after, … */
  dayOffset: number;
  /** The weekday 2–6 days ahead ("woensdag"), the date a week or more ahead ("3 nov."); null today or tomorrow. */
  day: string | null;
}

const DAY_MS = 24 * 3_600_000;

/** Whole calendar days from `from` to `to` in `timeZone` (DST-proof: compares dates, not hours). */
function calendarDays(from: number, to: number, timeZone: string): number {
  const date = (at: number) => {
    const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(at).split('-').map(Number);
    return Date.UTC(year as number, (month as number) - 1, day as number);
  };
  return Math.round((date(to) - date(from)) / DAY_MS);
}

/**
 * Clock time `minutes` from `now`, rounded to 5 minutes, in Homey's language and time zone,
 * with the calendar day it falls on: 20:25 later tonight is today, 20:25 after midnight is
 * tomorrow, whatever the number of hours. Formatted on Homey rather than in the widget, so it
 * never follows a phone set to another language.
 */
export function formatClockIn(minutes: number, now: number, language: string, timeZone: string): ClockTime {
  const step = 5 * MINUTE_MS;
  const at = Math.round((now + minutes * MINUTE_MS) / step) * step;
  const time = new Intl.DateTimeFormat(language, { hour: 'numeric', minute: '2-digit', timeZone }).format(at);
  const dayOffset = calendarDays(now, at, timeZone);
  let day: string | null = null;
  if (dayOffset >= 7) day = new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short', timeZone }).format(at);
  else if (dayOffset >= 2) day = new Intl.DateTimeFormat(language, { weekday: 'long', timeZone }).format(at);
  return { time, dayOffset, day };
}

/** Date and time in Homey's time zone, e.g. "28/09/2026, 14:02". */
export function formatTime(timestamp: number, language: string, timeZone: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short', timeZone }).format(timestamp);
}
