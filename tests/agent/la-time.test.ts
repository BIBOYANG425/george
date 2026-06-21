// tests/agent/la-time.test.ts
import { describe, it, expect } from 'vitest';
import { tzMonthDay, tzHourMinute, tzFullDate, LA_TIMEZONE } from '../../src/agent/la-time.js';
import { renderDateBlock } from '../../src/agent/calendar-mood.js';

describe('la-time', () => {
  describe('tzMonthDay', () => {
    it('reads the LA wall-clock month/day from an instant', () => {
      // 2026-08-20 10:00 LA (PDT, -07:00)
      const now = new Date('2026-08-20T10:00:00-07:00');
      expect(tzMonthDay(now)).toEqual({ month: 8, day: 20 });
    });

    it('rolls the LA day back across the UTC date boundary', () => {
      // 2026-01-01 02:00 UTC is still 2025-12-31 18:00 in LA (PST, -08:00).
      const now = new Date('2026-01-01T02:00:00Z');
      expect(tzMonthDay(now)).toEqual({ month: 12, day: 31 });
    });

    it('honors an explicit non-LA timezone', () => {
      const now = new Date('2026-01-01T02:00:00Z');
      // Same instant is already Jan 1 in Shanghai (+08:00).
      expect(tzMonthDay(now, 'Asia/Shanghai')).toEqual({ month: 1, day: 1 });
    });
  });

  describe('tzHourMinute', () => {
    it('reads the LA wall-clock hour/minute from an instant', () => {
      const now = new Date('2026-06-15T14:30:00-07:00');
      expect(tzHourMinute(now)).toEqual({ hours: 14, minutes: 30 });
    });

    it('normalizes midnight to hour 0, not 24', () => {
      const now = new Date('2026-06-15T00:00:00-07:00');
      expect(tzHourMinute(now).hours).toBe(0);
    });

    it('honors an explicit non-LA timezone', () => {
      // 2026-06-15 14:30 LA (-07:00) == 05:30 the next day in Shanghai (+08:00).
      const now = new Date('2026-06-15T14:30:00-07:00');
      expect(tzHourMinute(now, 'Asia/Shanghai')).toEqual({ hours: 5, minutes: 30 });
    });

    it('exposes the LA timezone constant', () => {
      expect(LA_TIMEZONE).toBe('America/Los_Angeles');
    });
  });

  describe('tzFullDate', () => {
    it('formats the LA wall-clock full date with weekday + year', () => {
      const now = new Date('2026-06-20T12:00:00-07:00');
      expect(tzFullDate(now)).toBe('Saturday, June 20, 2026');
    });

    it('uses the LA day across the UTC boundary', () => {
      // 2026-01-01 02:00 UTC is still Dec 31, 2025 in LA.
      const now = new Date('2026-01-01T02:00:00Z');
      expect(tzFullDate(now)).toBe('Wednesday, December 31, 2025');
    });
  });
});

describe('renderDateBlock', () => {
  it('injects the real current year + date and a recency rule', () => {
    const block = renderDateBlock(new Date('2026-06-20T12:00:00-07:00'));
    expect(block).toContain('# TODAY');
    expect(block).toContain('June 20, 2026');
    expect(block).toContain('2026');
    // The anti-stale rule: a prior-year release is not "current".
    expect(block).toMatch(/PRIOR year/);
  });

  it('is always non-empty (callers append unconditionally)', () => {
    expect(renderDateBlock(new Date('2026-06-20T12:00:00-07:00')).length).toBeGreaterThan(0);
  });
});
