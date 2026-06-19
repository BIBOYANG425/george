// tests/agent/activity-state.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getActivityState,
  renderActivityBlock,
  renderDelayContext,
} from '../../src/agent/activity-state.js';

const FLAG = 'GEORGE_ACTIVITY_STATE_ENABLED';

describe('activity-state', () => {
  let prevFlag: string | undefined;
  beforeEach(() => {
    prevFlag = process.env[FLAG];
  });
  afterEach(() => {
    if (prevFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prevFlag;
  });

  describe('getActivityState (pure classifier — flag-independent)', () => {
    it('classifies deep-night hours as sleeping', () => {
      // 04:00 LA
      const s = getActivityState(new Date('2026-06-15T04:00:00-07:00'));
      expect(s?.phase).toBe('sleeping');
    });

    it('classifies just-past-midnight as late-night (still up)', () => {
      // 00:30 LA
      const s = getActivityState(new Date('2026-06-15T00:30:00-07:00'));
      expect(s?.phase).toBe('late-night');
    });

    it('classifies a weekday late morning as in-class', () => {
      // Mon 10:00 LA
      const s = getActivityState(new Date('2026-06-15T10:00:00-07:00'));
      expect(s?.phase).toBe('in-class');
    });

    it('classifies a weekday afternoon as in-class', () => {
      // Mon 14:00 LA
      const s = getActivityState(new Date('2026-06-15T14:00:00-07:00'));
      expect(s?.phase).toBe('in-class');
    });

    it('does NOT mark a weekend late morning as in-class', () => {
      // Sat 10:00 LA -> normal awake, no overlay
      expect(getActivityState(new Date('2026-06-13T10:00:00-07:00'))).toBeNull();
      // Sun 10:00 LA
      expect(getActivityState(new Date('2026-06-14T10:00:00-07:00'))).toBeNull();
    });

    it('classifies the early evening as busy', () => {
      // 19:00 LA
      const s = getActivityState(new Date('2026-06-15T19:00:00-07:00'));
      expect(s?.phase).toBe('busy');
    });

    it('returns null for a normal mid-day awake stretch', () => {
      // Noon LA, no overlay
      expect(getActivityState(new Date('2026-06-15T12:00:00-07:00'))).toBeNull();
    });
  });

  describe('renderActivityBlock (flag-gated)', () => {
    it('returns "" when the flag is unset (default-off)', () => {
      delete process.env[FLAG];
      // 04:00 LA would classify as sleeping, but the flag is off.
      const block = renderActivityBlock(getActivityState(new Date('2026-06-15T04:00:00-07:00')));
      expect(block).toBe('');
    });

    it('returns "" when the flag is set to anything but "true"', () => {
      process.env[FLAG] = '1';
      const block = renderActivityBlock(getActivityState(new Date('2026-06-15T04:00:00-07:00')));
      expect(block).toBe('');
    });

    it('renders a block when the flag is on and there is a state', () => {
      process.env[FLAG] = 'true';
      const block = renderActivityBlock(getActivityState(new Date('2026-06-15T04:00:00-07:00')));
      expect(block).toContain('# RIGHT NOW');
      expect(block.length).toBeGreaterThan(0);
    });

    it('returns "" when the flag is on but the state is null', () => {
      process.env[FLAG] = 'true';
      const block = renderActivityBlock(getActivityState(new Date('2026-06-15T12:00:00-07:00')));
      expect(block).toBe('');
    });
  });

  describe('renderDelayContext (flag-gated)', () => {
    const NINE_HOURS = 9 * 60 * 60 * 1000;

    it('returns "" when the flag is off, regardless of gap', () => {
      delete process.env[FLAG];
      expect(renderDelayContext(NINE_HOURS)).toBe('');
    });

    it('returns "" for a short gap even with the flag on', () => {
      process.env[FLAG] = 'true';
      expect(renderDelayContext(30 * 60 * 1000)).toBe(''); // 30 min
    });

    it('returns "" for a non-finite gap', () => {
      process.env[FLAG] = 'true';
      expect(renderDelayContext(Number.NaN)).toBe('');
    });

    it('renders a gap note for a long gap with the flag on', () => {
      process.env[FLAG] = 'true';
      const note = renderDelayContext(NINE_HOURS, new Date('2026-06-15T04:00:00-07:00'));
      expect(note).toContain('# GAP SINCE YOUR LAST REPLY');
      expect(note).toContain('9h');
      // Asleep-through-the-gap reason at 04:00 LA.
      expect(note).toContain('asleep');
    });

    it('uses a neutral reason outside the sleep window', () => {
      process.env[FLAG] = 'true';
      // Noon LA: not sleeping/late-night -> busy-and-away reason on the reason line.
      const note = renderDelayContext(NINE_HOURS, new Date('2026-06-15T12:00:00-07:00'));
      const reasonLine = note.split('\n').find((l) => l.startsWith("It's been")) ?? '';
      expect(reasonLine).toContain('busy and away from your phone');
      expect(reasonLine).not.toContain('asleep');
    });
  });
});
