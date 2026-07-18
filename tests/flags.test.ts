// tests/flags.test.ts
// Unit tests for the centralized flags snapshot: per-call env re-read (so the flip-env
// test pattern keeps working), individual flag mapping, and the GEORGE_AGENT_MODE
// topology selector with legacy back-compat + precedence.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getFlags } from '../src/flags.js';

const TOPOLOGY_VARS = ['GEORGE_AGENT_MODE', 'GEORGE_TRUNK_HYBRID', 'SINGLE_AGENT'];
const FEATURE_VARS = [
  'GEORGE_DISABLE_FAST_PATH', 'GEORGE_ROUTER_ENABLED', 'GEORGE_RECALL_ENABLED', 'GEORGE_RECALL_TOOL_ENABLED',
  'GEORGE_UPDATE_MEMORY_TOOL_ENABLED', 'MEMORY_CAPTURE_ENABLED', 'GEORGE_OBSERVE_ENABLED',
  'GEORGE_MEMORY_PROACTIVE_ENABLED', 'GEORGE_REFLECT_ENABLED', 'GEORGE_ACTIVITY_STATE_ENABLED',
  'WORLD_STATE_ENABLED', 'GEORGE_VOICE_EXAMPLES_ENABLED', 'GEORGE_RELATIONSHIP_EVAL_ENABLED',
  'GEORGE_NOREPLY_ENABLED', 'GEORGE_READRECEIPT_DELAY_ENABLED', 'GROUNDED_PROACTIVE_ENABLED',
  'GEORGE_CRISIS_RADAR_ENABLED', 'SQUAD_COORDINATION_ENABLED', 'SQUAD_REREACH_EVAL_ENABLED',
  'SPECTRUM_BURST_GUARD_ENABLED', 'GEORGE_PACING_ENABLED', 'ADMIN_DASHBOARD_ENABLED',
];
const ALL = [...TOPOLOGY_VARS, ...FEATURE_VARS];

describe('getFlags', () => {
  const saved = { ...process.env };
  beforeEach(() => { for (const k of ALL) delete process.env[k]; });
  afterEach(() => { process.env = { ...saved }; });

  it('every feature flag defaults false; topology defaults to multi', () => {
    const f = getFlags();
    for (const key of Object.keys(f) as (keyof typeof f)[]) {
      if (key === 'agentMode') continue;
      expect(f[key]).toBe(false);
    }
    expect(f.agentMode).toBe('multi');
  });

  it('maps each env var to its typed field', () => {
    process.env.GEORGE_RECALL_ENABLED = 'true';
    process.env.SPECTRUM_BURST_GUARD_ENABLED = 'true';
    process.env.ADMIN_DASHBOARD_ENABLED = 'true';
    const f = getFlags();
    expect(f.recallEnabled).toBe(true);
    expect(f.burstGuardEnabled).toBe(true);
    expect(f.adminDashboardEnabled).toBe(true);
    expect(f.pacingEnabled).toBe(false);
  });

  it('re-reads process.env on every call (no snapshot cached at import)', () => {
    expect(getFlags().worldStateEnabled).toBe(false);
    process.env.WORLD_STATE_ENABLED = 'true';
    expect(getFlags().worldStateEnabled).toBe(true);
    delete process.env.WORLD_STATE_ENABLED;
    expect(getFlags().worldStateEnabled).toBe(false);
  });

  it('only "true" enables a flag (any other value is off)', () => {
    process.env.GEORGE_RECALL_ENABLED = '1';
    expect(getFlags().recallEnabled).toBe(false);
    process.env.GEORGE_RECALL_ENABLED = 'TRUE';
    expect(getFlags().recallEnabled).toBe(false);
  });

  describe('GEORGE_AGENT_MODE topology', () => {
    it('mode=trunk → trunkHybrid, not singleAgent', () => {
      process.env.GEORGE_AGENT_MODE = 'trunk';
      const f = getFlags();
      expect(f.agentMode).toBe('trunk');
      expect(f.trunkHybrid).toBe(true);
      expect(f.singleAgent).toBe(false);
    });

    it('mode=single → singleAgent, not trunkHybrid', () => {
      process.env.GEORGE_AGENT_MODE = 'single';
      const f = getFlags();
      expect(f.agentMode).toBe('single');
      expect(f.singleAgent).toBe(true);
      expect(f.trunkHybrid).toBe(false);
    });

    it('mode=multi → neither topology flag', () => {
      process.env.GEORGE_AGENT_MODE = 'multi';
      const f = getFlags();
      expect(f.agentMode).toBe('multi');
      expect(f.trunkHybrid).toBe(false);
      expect(f.singleAgent).toBe(false);
    });

    it('mode wins over the legacy flags when set', () => {
      process.env.GEORGE_AGENT_MODE = 'multi';
      process.env.GEORGE_TRUNK_HYBRID = 'true';
      process.env.SINGLE_AGENT = 'true';
      const f = getFlags();
      expect(f.trunkHybrid).toBe(false);
      expect(f.singleAgent).toBe(false);
    });

    it('back-compat: legacy GEORGE_TRUNK_HYBRID honored when mode unset', () => {
      process.env.GEORGE_TRUNK_HYBRID = 'true';
      const f = getFlags();
      expect(f.trunkHybrid).toBe(true);
      expect(f.agentMode).toBe('trunk');
    });

    it('back-compat: legacy SINGLE_AGENT honored when mode unset', () => {
      process.env.SINGLE_AGENT = 'true';
      const f = getFlags();
      expect(f.singleAgent).toBe(true);
      expect(f.agentMode).toBe('single');
    });

    it('an invalid mode falls back to the legacy flags', () => {
      process.env.GEORGE_AGENT_MODE = 'bogus';
      process.env.GEORGE_TRUNK_HYBRID = 'true';
      const f = getFlags();
      expect(f.trunkHybrid).toBe(true);
      expect(f.agentMode).toBe('trunk');
    });
  });
});
