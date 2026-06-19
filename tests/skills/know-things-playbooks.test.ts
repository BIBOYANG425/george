// tests/skills/know-things-playbooks.test.ts
// Step 6: the 4 additive know-things skill playbooks must parse, validate (every
// referenced tool exists in ALL_TOOLS), and surface in getFullCatalog() under their
// course/housing/campus buckets. They are flag-independent (always loaded at boot)
// and inert on the OFF path because only the trunk / single-agent prompts append
// getFullCatalog().

import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { _resetForTest, buildRegistry, getFullCatalog, getSkillBody } from '../../src/skills/index.js';
import { walkSkillsDirectory } from '../../src/skills/loader.js';
import { ALL_TOOLS } from '../../src/tools/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = join(__dirname, '../../src/skills');

const NEW_SKILLS = [
  'course-recommendation',
  'ge-category-picker',
  'find-housing',
  'campus-knowledge-fallback',
];

describe('know-things skill playbooks (additive, flag-independent)', () => {
  beforeAll(async () => {
    _resetForTest();
    // Boot exactly as src/index.ts does: validate against the real registered tools.
    const skills = await walkSkillsDirectory(SKILLS_ROOT);
    buildRegistry(skills, new Set(Object.keys(ALL_TOOLS)));
  });

  it('all 4 new playbooks parse and load (boot fail-fast would catch a typo)', () => {
    for (const name of NEW_SKILLS) {
      expect(getSkillBody(name)).not.toBeNull();
    }
  });

  it('every new playbook surfaces in getFullCatalog()', () => {
    const catalog = getFullCatalog();
    for (const name of NEW_SKILLS) {
      expect(catalog).toContain(name);
    }
  });

  it('catalog buckets them under course / housing / campus', () => {
    const catalog = getFullCatalog();
    expect(catalog).toMatch(/^course:/m);
    expect(catalog).toMatch(/^housing:/m);
    expect(catalog).toMatch(/^campus:/m);
  });

  it('the housing playbook body carries the never-invent-prices + DPS safety-circle rules', () => {
    const body = getSkillBody('find-housing') ?? '';
    expect(body).toMatch(/NEVER invent prices/);
    expect(body).toMatch(/free share-Lyft zone 20:00-03:00/);
    expect(body).toMatch(/Parkside/);
  });

  it('the course playbook body carries the recommend_courses-first order + WRIT 150 5.0-tier + RMP thresholds', () => {
    const body = getSkillBody('course-recommendation') ?? '';
    expect(body).toMatch(/recommend_courses` FIRST/);
    expect(body).toMatch(/ge_candidates` ONCE/);
    expect(body).toMatch(/WRIT 150/);
    expect(body).toMatch(/RMP 4\.8\+/);
    expect(body).toMatch(/RMP > 4\.0/);
  });

  it('the campus playbook body carries meal-plan + study-spot specifics', () => {
    const body = getSkillBody('campus-knowledge-fallback') ?? '';
    expect(body).toMatch(/dining dollars/);
    expect(body).toMatch(/Leavey 3rd floor/);
  });

  it('boot does not throw — buildRegistry validated every referenced tool against ALL_TOOLS', () => {
    // If any new playbook referenced a tool not in ALL_TOOLS, the beforeAll
    // buildRegistry() would have thrown and failed the suite. Reaching here proves
    // it loaded cleanly. Re-assert defensively that the registry is non-empty.
    expect(getSkillBody('course-recommendation')).not.toBeNull();
  });
});
