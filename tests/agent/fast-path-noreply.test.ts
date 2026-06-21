// tests/agent/fast-path-noreply.test.ts
//
// The fast path is where pure acks ("收到", "ok", a lone 👍) and automated texts
// land, so for the NO_REPLY feature to actually fire, the fast responder must be
// allowed to emit {{NO_REPLY}} — gated on GEORGE_NOREPLY_ENABLED. (The eval A/B
// showed NO_REPLY scored 0/2 before this, because the fast path always answered.)

import { describe, it, expect, afterEach } from 'vitest';
import { buildFastInstruction } from '../../src/agent/fast-path.js';

describe('fast path NO_REPLY gating', () => {
  afterEach(() => {
    delete process.env.GEORGE_NOREPLY_ENABLED;
  });

  it('offers the {{NO_REPLY}} option only when the flag is on', () => {
    delete process.env.GEORGE_NOREPLY_ENABLED;
    expect(buildFastInstruction()).not.toContain('{{NO_REPLY}}');

    process.env.GEORGE_NOREPLY_ENABLED = 'true';
    const on = buildFastInstruction();
    expect(on).toContain('{{NO_REPLY}}');
    expect(on).toMatch(/pure acknowledgement|stay silent/i);
  });

  it('always keeps the NEEDS_AGENT bail (anti-fabrication) in both modes', () => {
    delete process.env.GEORGE_NOREPLY_ENABLED;
    expect(buildFastInstruction()).toContain('NEEDS_AGENT');
    process.env.GEORGE_NOREPLY_ENABLED = 'true';
    expect(buildFastInstruction()).toContain('NEEDS_AGENT');
  });
});
