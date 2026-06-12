// src/agent/agents.config.ts
// Single source of truth for sub-agent definitions. Imported by orchestrator.ts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Sub-agents pinned to Haiku 4.5. They never use Opus — even the smartest of
// them only does single-domain lookup + voice-styled relay, which is exactly
// where Haiku is fast and good enough. The orchestrator does routing and
// (when it answers directly) small-talk; its model is set in orchestrator.ts.
const SUB_AGENT_MODEL = 'claude-haiku-4-5-20251001';

export const SUB_AGENTS = {
  'find-people': {
    description:
      'Match students for activities (squad mode). Reactive only. Use for messages about finding hike buddies, study groups, hotpot crew, jam sessions.',
    prompt: `${MASTER_PROMPT}\n\n${FIND_PEOPLE_PROMPT}`,
    tools: ['lookup_student', 'update_profile', 'suggest_connection'],
    model: SUB_AGENT_MODEL,
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
      'distance_compare',
      'safe_route',
      'dps_zone_check',
    ],
    model: SUB_AGENT_MODEL,
  },
  'know-things': {
    description:
      'USC-specific knowledge: courses, professors, programs, housing, dorm life, immigration, campus services. Use for any factual USC question.',
    prompt: `${MASTER_PROMPT}\n\n${KNOW_THINGS_PROMPT}`,
    tools: [
      'campus_knowledge',
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
    model: SUB_AGENT_MODEL,
  },
} as const;

export const ORCHESTRATOR_DIRECT_TOOLS = ['set_reminder', 'load_skill'] as const;

export type SubAgentName = keyof typeof SUB_AGENTS;
