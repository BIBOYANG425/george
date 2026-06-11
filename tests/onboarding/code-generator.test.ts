// tests/onboarding/code-generator.test.ts
import { describe, it, expect } from 'vitest';
import { generateCode, isValidCodeFormat } from '../../src/onboarding/code-generator.js';

describe('generateCode', () => {
  it('returns a 6-char lowercase alphanumeric string', () => {
    const code = generateCode();
    expect(code).toMatch(/^[a-z0-9]{6}$/);
  });

  it('generates unique codes across many calls', () => {
    const codes = new Set(Array.from({ length: 1000 }, () => generateCode()));
    expect(codes.size).toBeGreaterThan(990);
  });
});

describe('isValidCodeFormat', () => {
  it('accepts valid 6-char codes', () => {
    expect(isValidCodeFormat('g7k2m4')).toBe(true);
  });
  it('rejects shorter codes', () => {
    expect(isValidCodeFormat('g7k2m')).toBe(false);
  });
  it('rejects uppercase', () => {
    expect(isValidCodeFormat('G7K2M4')).toBe(false);
  });
  it('rejects symbols', () => {
    expect(isValidCodeFormat('g7k2m@')).toBe(false);
  });
});
