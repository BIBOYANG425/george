// tests/admin/growth.test.ts
// PR-4 growth — the testable pure logic behind getRetention: day math + the
// at-risk classifier (was active, now quiet but still reachable).
import { describe, it, expect } from 'vitest';
import { daysBetween, classifyAtRisk } from '../../src/admin/analytics';

const NOW = Date.parse('2026-06-25T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe('daysBetween', () => {
  it('floors elapsed days', () => {
    expect(daysBetween(daysAgo(10), NOW)).toBe(10);
    expect(daysBetween(daysAgo(0), NOW)).toBe(0);
  });
  it('never negative (future timestamp) and 0 on garbage', () => {
    expect(daysBetween(new Date(NOW + 5 * 86_400_000).toISOString(), NOW)).toBe(0);
    expect(daysBetween('not-a-date', NOW)).toBe(0);
  });
});

describe('classifyAtRisk', () => {
  it('flags a real user gone quiet 7-45 days', () => {
    expect(classifyAtRisk(daysAgo(10), 8, NOW)).toEqual({ daysSince: 10, atRisk: true });
  });
  it('does NOT flag a still-active user (< 7 days silent)', () => {
    expect(classifyAtRisk(daysAgo(2), 20, NOW).atRisk).toBe(false);
  });
  it('does NOT flag a long-churned user (> 45 days — not recoverable now)', () => {
    expect(classifyAtRisk(daysAgo(90), 50, NOW).atRisk).toBe(false);
  });
  it('does NOT flag a barely-there user (< minMessages — never really onboarded)', () => {
    expect(classifyAtRisk(daysAgo(10), 1, NOW).atRisk).toBe(false);
  });
  it('honors custom thresholds', () => {
    expect(classifyAtRisk(daysAgo(3), 5, NOW, { silentMin: 2, silentMax: 30, minMessages: 1 }).atRisk).toBe(true);
  });
});
