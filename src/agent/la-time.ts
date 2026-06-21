// src/agent/la-time.ts
//
// Small shared helper for "what time is it in LA" math. USC lives in
// America/Los_Angeles, and three places needed the same Intl.DateTimeFormat
// dance to read the local wall-clock from a Date: calendar-mood.ts (month/day
// for academic-calendar windows), heartbeat-scheduler.ts (hour/minute for
// active-hours gating), and now activity-state.ts (hour for awake/sleeping
// buckets). DRY-ing the formatting into one place keeps the timezone string and
// the part-extraction in a single, testable spot.

export const LA_TIMEZONE = 'America/Los_Angeles';

// {month, day} on the wall clock of the given timezone (default LA) for `now`.
export function tzMonthDay(now: Date, timeZone: string = LA_TIMEZONE): { month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  const month = Number(parts.find((p) => p.type === 'month')?.value ?? '0');
  const day = Number(parts.find((p) => p.type === 'day')?.value ?? '0');
  return { month, day };
}

// {hours, minutes} (24h) on the wall clock of the given timezone (default LA).
export function tzHourMinute(now: Date, timeZone: string = LA_TIMEZONE): { hours: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  // Intl can emit '24' for midnight in some runtimes; normalize to 0-23.
  const hours = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10) % 24;
  const minutes = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  return { hours, minutes };
}

// Full human date on the wall clock of the timezone (default LA), e.g.
// "Saturday, June 20, 2026". Used to anchor the agent's sense of "now" in the
// system prompt so it does not treat its training cutoff as the present.
export function tzFullDate(now: Date, timeZone: string = LA_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now);
}
