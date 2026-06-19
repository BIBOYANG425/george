// tests/agent/world-state.test.ts
//
// Unit tests for the World Info timed-state core (src/agent/world-state.ts).
// All pure / deterministic — no LLM, no DB, no timers. Exercises trigger
// detection, the per-user warm/cool decay over a turn counter, rendering, and
// the default-OFF flag gate.

import { describe, it, expect, afterEach } from 'vitest';
import {
  detectTriggers,
  renderWorldStateBlock,
  WorldStateStore,
  worldStateEnabled,
  WORLD_TOPICS,
  DEFAULT_WARM_TURNS,
} from '../../src/agent/world-state.js';

describe('detectTriggers', () => {
  it('matches a keyword case-insensitively, in any language', () => {
    expect(detectTriggers('my VISA got stuck in admin processing')).toEqual(['visa']);
    expect(detectTriggers('签证又出问题了')).toEqual(['visa']);
  });

  it('returns [] when nothing matches', () => {
    expect(detectTriggers('what dorm should i pick lol')).toEqual([]);
  });

  it('can match multiple topics and returns them in table (priority) order', () => {
    // mentions job-hunt ("interview") AND finals ("期末") — table order is
    // visa, finals, homesick, job-hunt, so finals must come before job-hunt.
    const keys = detectTriggers('期末 and i also have an interview tomorrow');
    expect(keys).toEqual(['finals', 'job-hunt']);
  });

  it('de-duplicates when several keywords hit the same topic', () => {
    expect(detectTriggers('opt and cpt and my i-20')).toEqual(['visa']);
  });

  it('honors a custom topic table', () => {
    const topics = [{ key: 'pizza', triggers: ['pizza'], note: 'n' }];
    expect(detectTriggers('i want pizza', topics)).toEqual(['pizza']);
    expect(detectTriggers('i want visa', topics)).toEqual([]);
  });

  // Boundary matching: short acronym triggers must not fire inside larger words.
  it('does NOT fire a short acronym trigger inside a larger word', () => {
    expect(detectTriggers('what are my menu options here')).toEqual([]); // 'opt' ⊄ options
    expect(detectTriggers('i adopted a cat')).toEqual([]); // 'opt' ⊄ adopted
    expect(detectTriggers('we took the boat to catalina')).toEqual([]); // 'oa' ⊄ boat
    expect(detectTriggers('i bought a new laptop')).toEqual([]); // 'opt' ⊄ laptop
  });

  it('still fires a short acronym trigger as a whole token', () => {
    expect(detectTriggers('applying for opt soon')).toEqual(['visa']);
    expect(detectTriggers('did you finish the oa yet')).toEqual(['job-hunt']);
    expect(detectTriggers('my f1 status is fine')).toEqual(['visa']);
  });

  it('keeps inflection recall for longer word triggers (left-boundary only)', () => {
    expect(detectTriggers('i got two offers today')).toEqual(['job-hunt']); // offer -> offers
    expect(detectTriggers('summer internships are brutal')).toEqual(['job-hunt']);
  });

  it('still substring-matches CJK triggers (no word boundaries)', () => {
    expect(detectTriggers('最近一直在想家')).toEqual(['homesick']); // 想家 inside a run
  });
});

describe('renderWorldStateBlock', () => {
  it('returns empty string when no topics are active (append-unconditionally contract)', () => {
    expect(renderWorldStateBlock([])).toBe('');
  });

  it('renders a header plus one bullet per known topic note', () => {
    const block = renderWorldStateBlock(['visa']);
    expect(block).toContain('# WHAT THIS STUDENT IS CARRYING RIGHT NOW');
    const visaNote = WORLD_TOPICS.find((t) => t.key === 'visa')!.note;
    expect(block).toContain(`- ${visaNote}`);
  });

  it('reassures that it never overrides voice / anti-fabrication', () => {
    const block = renderWorldStateBlock(['finals']);
    expect(block.toLowerCase()).toContain('never overrides your voice');
    expect(block.toLowerCase()).toContain('no-invented-facts');
  });

  it('skips unknown keys and returns empty if all are unknown', () => {
    expect(renderWorldStateBlock(['nope', 'also-nope'])).toBe('');
    const block = renderWorldStateBlock(['nope', 'visa']);
    expect(block).toContain('# WHAT THIS STUDENT IS CARRYING RIGHT NOW');
    // exactly one bullet (only visa resolved)
    expect(block.match(/\n- /g)?.length).toBe(1);
  });
});

describe('WorldStateStore decay', () => {
  it('warms a topic on trigger and reports it active', () => {
    const store = new WorldStateStore();
    expect(store.observe('u1', 'my visa is stuck')).toEqual(['visa']);
    expect(store.getActive('u1')).toEqual(['visa']);
  });

  it('keeps a topic warm for warmTurns of unrelated messages, then cools it', () => {
    const store = new WorldStateStore({ warmTurns: 3 });
    store.observe('u1', 'my visa is stuck'); // turn 1: warm until turn 4
    // turns 2, 3, 4: still warm (unrelated chatter)
    expect(store.observe('u1', 'what dorm is good')).toEqual(['visa']); // turn 2
    expect(store.observe('u1', 'where do i eat')).toEqual(['visa']); // turn 3
    // turn 4 == expiresAtTurn -> cools off this turn
    expect(store.observe('u1', 'thanks 学长')).toEqual([]); // turn 4
    expect(store.getActive('u1')).toEqual([]);
  });

  it('re-warms a topic when it is mentioned again, extending the window', () => {
    const store = new WorldStateStore({ warmTurns: 2 });
    store.observe('u1', 'visa stress'); // turn 1: expires turn 3
    expect(store.observe('u1', 'visa again')).toEqual(['visa']); // turn 2: re-warm, expires turn 4
    expect(store.observe('u1', 'unrelated')).toEqual(['visa']); // turn 3: still warm (4 > 3)
    expect(store.observe('u1', 'unrelated')).toEqual([]); // turn 4: cools
  });

  it('isolates state per user', () => {
    const store = new WorldStateStore();
    store.observe('alice', 'homesick tonight');
    store.observe('bob', 'finals week 期末');
    expect(store.getActive('alice')).toEqual(['homesick']);
    expect(store.getActive('bob')).toEqual(['finals']);
  });

  it('tracks several concurrent warm topics and returns them in table order', () => {
    const store = new WorldStateStore();
    store.observe('u1', 'visa issue'); // visa
    const active = store.observe('u1', 'plus an interview tomorrow'); // job-hunt
    expect(active).toEqual(['visa', 'job-hunt']);
  });

  it('render() mirrors getActive() and is empty for an unknown user', () => {
    const store = new WorldStateStore();
    expect(store.render('ghost')).toBe('');
    store.observe('u1', 'my visa');
    expect(store.render('u1')).toContain('# WHAT THIS STUDENT IS CARRYING RIGHT NOW');
  });

  it('clear() drops a user entirely', () => {
    const store = new WorldStateStore();
    store.observe('u1', 'homesick');
    expect(store.getActive('u1')).toEqual(['homesick']);
    store.clear('u1');
    expect(store.getActive('u1')).toEqual([]);
  });

  it('uses DEFAULT_WARM_TURNS when none is configured', () => {
    const store = new WorldStateStore();
    store.observe('u1', 'homesick'); // turn 1, expires turn 1 + DEFAULT_WARM_TURNS
    for (let i = 0; i < DEFAULT_WARM_TURNS - 1; i++) {
      expect(store.observe('u1', 'chat')).toEqual(['homesick']);
    }
    // the next observe lands exactly on the expiry turn
    expect(store.observe('u1', 'chat')).toEqual([]);
  });
});

describe('worldStateEnabled flag (default-OFF)', () => {
  const original = process.env.WORLD_STATE_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.WORLD_STATE_ENABLED;
    else process.env.WORLD_STATE_ENABLED = original;
  });

  it('is off when unset', () => {
    delete process.env.WORLD_STATE_ENABLED;
    expect(worldStateEnabled()).toBe(false);
  });

  it('is off for any value other than the exact string "true"', () => {
    process.env.WORLD_STATE_ENABLED = 'TRUE';
    expect(worldStateEnabled()).toBe(false);
    process.env.WORLD_STATE_ENABLED = '1';
    expect(worldStateEnabled()).toBe(false);
    process.env.WORLD_STATE_ENABLED = 'yes';
    expect(worldStateEnabled()).toBe(false);
  });

  it('is on only when exactly "true"', () => {
    process.env.WORLD_STATE_ENABLED = 'true';
    expect(worldStateEnabled()).toBe(true);
  });
});
