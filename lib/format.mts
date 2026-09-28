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

/** Date and time in Homey's time zone, e.g. "28/09/2026, 14:02". */
export function formatTime(timestamp: number, language: string, timeZone: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short', timeZone }).format(timestamp);
}
