// tests/jobs/heartbeat-scheduler.test.ts
import { describe, it, expect, vi } from 'vitest';
import { selectDueUsers, dispatchHeartbeats } from '../../src/jobs/heartbeat-scheduler.js';

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
});
