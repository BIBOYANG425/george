// tests/jobs/heartbeat-scheduler.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  selectDueUsers,
  dispatchHeartbeats,
  isWithinActiveHours,
  runWithConcurrency,
  makeProactiveSender,
  type ConfigRow,
} from '../../src/jobs/heartbeat-scheduler.js';

// A ConfigRow whose only relevant fields for isWithinActiveHours are the timezone +
// active-hours window; the rest are filled with inert defaults.
function activeHoursRow(start: string, end: string, timezone = 'America/Los_Angeles'): ConfigRow {
  return {
    user_id: 'u',
    cadence: '12 hours',
    last_heartbeat_at: null,
    active_hours_start: start,
    active_hours_end: end,
    timezone,
    paused: false,
    pause_until: null,
  };
}

// LA is PDT (-07:00) in July, so an ISO with -07:00 pins a specific LA wall-clock.
const laAt = (hhmm: string) => new Date(`2026-07-07T${hhmm}:00-07:00`);

describe('selectDueUsers', () => {
  it('returns users whose last_heartbeat_at + cadence is past', async () => {
    const now = new Date('2026-06-07T15:00:00-07:00');
    const rows = [
      {
        user_id: 'u1',
        cadence: '12 hours',
        last_heartbeat_at: '2026-06-07T02:00:00-07:00', // 13h ago - due
        active_hours_start: '09:00',
        active_hours_end: '22:00',
        timezone: 'America/Los_Angeles',
        paused: false,
        pause_until: null,
      },
      {
        user_id: 'u2',
        cadence: '12 hours',
        last_heartbeat_at: '2026-06-07T12:00:00-07:00', // 3h ago - not due
        active_hours_start: '09:00',
        active_hours_end: '22:00',
        timezone: 'America/Los_Angeles',
        paused: false,
        pause_until: null,
      },
    ];
    const due = selectDueUsers(rows, now);
    expect(due.map((r) => r.user_id)).toEqual(['u1']);
  });

  it('skips paused users', async () => {
    const now = new Date('2026-06-07T15:00:00-07:00');
    const due = selectDueUsers(
      [
        {
          user_id: 'u1',
          cadence: '12 hours',
          last_heartbeat_at: null,
          active_hours_start: '09:00',
          active_hours_end: '22:00',
          timezone: 'America/Los_Angeles',
          paused: true,
          pause_until: null,
        },
      ],
      now
    );
    expect(due).toHaveLength(0);
  });

  it('auto-resumes when pause_until is past', async () => {
    const now = new Date('2026-06-07T15:00:00-07:00');
    const due = selectDueUsers(
      [
        {
          user_id: 'u1',
          cadence: '12 hours',
          last_heartbeat_at: null,
          active_hours_start: '09:00',
          active_hours_end: '22:00',
          timezone: 'America/Los_Angeles',
          paused: true,
          pause_until: '2026-06-06T00:00:00-07:00',
        },
      ],
      now
    );
    expect(due).toHaveLength(1);
  });

  it('skips outside active_hours', async () => {
    const now = new Date('2026-06-07T07:00:00-07:00'); // 07:00, before 09:00
    const due = selectDueUsers(
      [
        {
          user_id: 'u1',
          cadence: '12 hours',
          last_heartbeat_at: null,
          active_hours_start: '09:00',
          active_hours_end: '22:00',
          timezone: 'America/Los_Angeles',
          paused: false,
          pause_until: null,
        },
      ],
      now
    );
    expect(due).toHaveLength(0);
  });
});

describe('dispatchHeartbeats', () => {
  it('runs heartbeat for each user with 60s timeout', async () => {
    const fired: string[] = [];
    await dispatchHeartbeats(['u1', 'u2'], async (uid) => {
      fired.push(uid);
    });
    expect(fired.sort()).toEqual(['u1', 'u2']);
  });

  it('isolates failures (one user error does not stop others)', async () => {
    const fired: string[] = [];
    await dispatchHeartbeats(['u1', 'u2', 'u3'], async (uid) => {
      if (uid === 'u2') throw new Error('boom');
      fired.push(uid);
    });
    expect(fired.sort()).toEqual(['u1', 'u3']);
  });

  it('passes an AbortSignal to each run', async () => {
    const signals: boolean[] = [];
    await dispatchHeartbeats(['u1', 'u2'], async (_uid, signal) => {
      signals.push(signal instanceof AbortSignal && !signal.aborted);
    });
    expect(signals).toEqual([true, true]);
  });
});

describe('isWithinActiveHours', () => {
  describe('same-day window (09:00–22:00)', () => {
    const row = activeHoursRow('09:00', '22:00');
    it('before start → false', () => expect(isWithinActiveHours(laAt('07:00'), row)).toBe(false));
    it('at start → true', () => expect(isWithinActiveHours(laAt('09:00'), row)).toBe(true));
    it('mid-window → true', () => expect(isWithinActiveHours(laAt('15:00'), row)).toBe(true));
    it('one minute before end → true', () => expect(isWithinActiveHours(laAt('21:59'), row)).toBe(true));
    it('at end → false (end is exclusive)', () => expect(isWithinActiveHours(laAt('22:00'), row)).toBe(false));
  });

  describe('overnight window (22:00–06:00)', () => {
    const row = activeHoursRow('22:00', '06:00');
    it('at start → true', () => expect(isWithinActiveHours(laAt('22:00'), row)).toBe(true));
    it('late night → true', () => expect(isWithinActiveHours(laAt('23:30'), row)).toBe(true));
    it('after midnight → true', () => expect(isWithinActiveHours(laAt('02:00'), row)).toBe(true));
    it('one minute before end → true', () => expect(isWithinActiveHours(laAt('05:59'), row)).toBe(true));
    it('at end → false (end is exclusive)', () => expect(isWithinActiveHours(laAt('06:00'), row)).toBe(false));
    it('daytime (outside the wrap) → false', () => expect(isWithinActiveHours(laAt('12:00'), row)).toBe(false));
    it('just before start → false', () => expect(isWithinActiveHours(laAt('21:59'), row)).toBe(false));
  });

  describe('degenerate window (start == end)', () => {
    const row = activeHoursRow('09:00', '09:00');
    it('is never active', () => {
      expect(isWithinActiveHours(laAt('09:00'), row)).toBe(false);
      expect(isWithinActiveHours(laAt('15:00'), row)).toBe(false);
    });
  });

  it('selectDueUsers respects an overnight window (fires at 02:00 for a 22:00–06:00 user)', () => {
    const rows: ConfigRow[] = [activeHoursRow('22:00', '06:00')];
    expect(selectDueUsers(rows, laAt('02:00'))).toHaveLength(1);
    expect(selectDueUsers(rows, laAt('12:00'))).toHaveLength(0);
  });
});

describe('runWithConcurrency', () => {
  it('processes every item exactly once', async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    await runWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5)); // hold the slot so overlap is observable
      active -= 1;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThan(1); // it really did run in parallel
  });

  it('clamps a limit below 1 up to 1 (serial), still covers all items', async () => {
    let active = 0;
    let maxActive = 0;
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3], 0, async (n) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 1));
      seen.push(n);
      active -= 1;
    });
    expect(maxActive).toBe(1);
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('empty items → resolves immediately, no worker calls', async () => {
    const worker = vi.fn(async () => {});
    await runWithConcurrency([], 4, worker);
    expect(worker).not.toHaveBeenCalled();
  });
});

describe('makeProactiveSender', () => {
  it('routes through the live Spectrum client when connected', async () => {
    const sendProactive = vi.fn(async () => {});
    const enqueueLegacy = vi.fn(async () => {});
    const send = makeProactiveSender({
      getSpectrumClient: () => ({ sendProactive }),
      enqueueLegacy,
    });
    await send({ to: '+15551234567', text: 'hey, saw your visa appt is coming up' });
    expect(sendProactive).toHaveBeenCalledWith('+15551234567', ['hey, saw your visa appt is coming up']);
    expect(enqueueLegacy).not.toHaveBeenCalled();
  });

  it('falls back to the legacy queue when there is no client (legacy transport / reconnecting)', async () => {
    const enqueueLegacy = vi.fn(async () => {});
    const send = makeProactiveSender({
      getSpectrumClient: () => null,
      enqueueLegacy,
    });
    await send({ to: '+15551234567', text: 'proactive nudge' });
    expect(enqueueLegacy).toHaveBeenCalledWith('+15551234567', 'proactive nudge');
  });
});
