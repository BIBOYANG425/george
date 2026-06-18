// src/agent/agents.config.ts
// Single source of truth for sub-agent definitions. Imported by orchestrator.ts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(__dirname, '../../prompts');

function readPrompt(name: string): string {
  return fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf-8');
}

export const MASTER_PROMPT = readPrompt('master');
export const ORCHESTRATOR_PROMPT = readPrompt('orchestrator');
const FIND_PEOPLE_PROMPT = readPrompt('find-people');
const WHATS_HAPPENING_PROMPT = readPrompt('whats-happening');
const KNOW_THINGS_PROMPT = readPrompt('know-things');

// Single-agent mode: all three specializations merged into one prompt so ONE
// agent (no orchestrator→sub-agent dispatch) can handle every domain. The agent
// picks the relevant tools per message. Headed sections keep the domains legible.
export const UNIFIED_DOMAIN_PROMPT = [
  '# DOMAINS YOU HANDLE',
  'You handle all of the following yourself. Read the message, pick the right tools,',
  'and answer. Do not announce which "mode" you are in.',
  '',
  '## Finding people / 找搭子 (squad organizing + joining)',
  FIND_PEOPLE_PROMPT,
  '',
  "## What's happening — events, places, safety, walkability",
  WHATS_HAPPENING_PROMPT,
  '',
  '## Knowing things — courses, professors, programs, housing, immigration, campus',
  KNOW_THINGS_PROMPT,
].join('\n');

// Sub-agents are TIERED by how much reasoning the domain needs (resolved from
// config.models, env-overridable):
//   FAST  — find-people / whats-happening: single-domain lookup + voice relay.
//   SMART — know-things: high-stakes course / immigration / housing advice that
//           needs real reasoning, not just relay.
// (Previously all three were pinned to one Haiku const, AND that pin was silently
// dropped by buildAgentsConfig so they ran on whatever the env model was. Both
// fixed — buildAgentsConfig now forwards this model field.)
const FAST_MODEL = config.models.fast;
const SMART_MODEL = config.models.smart;
// The orchestrator's own turns (routing + direct small-talk) run on the fast tier.
// Exported so orchestrator.ts can pin query() options.model — without this the main
// session silently uses the CLI/ANTHROPIC_MODEL default and GEORGE_MODEL_FAST never
// reaches the orchestrator (codex review P2).
export const ORCHESTRATOR_MODEL = FAST_MODEL;

export const SUB_AGENTS = {
  'find-people': {
    description:
      '找搭子 organizer (squad mode). Reactive only. Use for ANY message about organizing/posting a group activity ("想组个局", "找几个人去吃韩烤", "发个帖"), finding open 局s to join, or joining one. Drafts the post, gets approval, posts it, and brings people together.',
    prompt: `${MASTER_PROMPT}\n\n${FIND_PEOPLE_PROMPT}`,
    tools: ['lookup_student', 'update_profile', 'suggest_connection', 'create_squad_post', 'find_squad_posts', 'join_squad_post', 'squad_rsvp'],
    model: FAST_MODEL,
  },
  'whats-happening': {
    description:
      'Discover events and places at USC. Reactive search for parties, club events, weekend ideas, study spots, safe places to go, late-night walkability and DPS-zone safety questions.',
    prompt: `${MASTER_PROMPT}\n\n${WHATS_HAPPENING_PROMPT}`,
    tools: [
      'search_events',
      'submit_event',
      'get_event_details',
      'travel_time',
      'find_places',
      'distance_compare',
      'safe_route',
      'dps_zone_check',
    ],
    model: FAST_MODEL,
  },
  'know-things': {
    description:
      'USC-specific knowledge: courses, professors, programs, housing, dorm life, immigration, campus services. Use for any factual USC question.',
    prompt: `${MASTER_PROMPT}\n\n${KNOW_THINGS_PROMPT}`,
    tools: [
      'campus_knowledge',
      'find_places',
      'freshman_faq',
      'describe_course',
      'recommend_courses',
      'get_rmp_ratings',
      'search_courses',
      'search_ge_courses',
      'search_programs',
      'plan_schedule',
      'get_student_academic_state',
      'course_tips',
      'get_course_reviews',
      'search_roommates',
      'search_sublets',
      'post_sublet',
      'dps_zone_check',
    ],
    model: SMART_MODEL,
  },
} as const;

export const ORCHESTRATOR_DIRECT_TOOLS = ['set_reminder', 'load_skill'] as const;

export type SubAgentName = keyof typeof SUB_AGENTS;
