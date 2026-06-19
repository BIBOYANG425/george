// src/agent/calendar-mood.ts
//
// Provides the "calendar mood" that master.md's "Calendar mood overlay" section
// references ("The current calendar mood is provided to the agent via system
// metadata"). Until now nothing actually injected it, so the headline
// calendar-aware-mood feature was dead. This module computes the mood from the
// current date in USC's timezone and orchestrator.ts injects it into the prompt.
//
// Windows are approximate USC academic-calendar ranges, kept as an easy-to-edit
// table (month*100 + day). Tune the dates per the official USC calendar each year.

import { tzMonthDay } from './la-time.js';

export interface CalendarMood {
  phase: 'finals' | 'orientation' | 'midterms' | 'break';
  directive: string;
}

// {month, day} in America/Los_Angeles for the given instant (USC is in LA).
// Thin wrapper over the shared la-time helper so this module reads the same way.
function laMonthDay(now: Date): { month: number; day: number } {
  return tzMonthDay(now);
}

// Returns the current mood, or null for a normal period (no overlay injected).
export function getCalendarMood(now: Date = new Date()): CalendarMood | null {
  const { month, day } = laMonthDay(now);
  const md = month * 100 + day; // Aug 20 -> 820

  // Finals: early May (spring), early Dec (fall).
  if ((md >= 501 && md <= 512) || (md >= 1201 && md <= 1215)) {
    return {
      phase: 'finals',
      directive:
        'It is finals season. Be terse, calm, and sympathetic — get out of their way. ' +
        'Fast useful answers, no chit-chat, no profile nudges. Meet their stress with steadiness, not energy.',
    };
  }
  // Orientation / start of term: mid-Aug (fall), mid-Jan (spring).
  if ((md >= 815 && md <= 901) || (md >= 108 && md <= 122)) {
    return {
      phase: 'orientation',
      directive:
        'It is orientation / start of semester. Be warm, welcoming, and a bit more talkative; ' +
        'slightly longer messages are fine. Many people are brand new and finding their feet — make them feel held.',
    };
  }
  // Midterms: mid-Oct (fall), early-mid Mar (spring).
  if ((md >= 1008 && md <= 1022) || (md >= 305 && md <= 320)) {
    return {
      phase: 'midterms',
      directive:
        'It is midterm season. Be encouraging and efficient — practical answers, a little extra warmth, no fluff.',
    };
  }
  // Summer break (Jun-Jul) and winter break (late Dec).
  if (month === 6 || month === 7 || (md >= 1216 && md <= 1231)) {
    return {
      phase: 'break',
      directive: 'It is break — campus is quiet and the energy is relaxed. Keep it casual and low-key.',
    };
  }
  return null; // normal period
}

// Renders the mood as a prompt section, or '' when there is no active mood, so
// callers can append unconditionally (same pattern as the profile/onboarding blocks).
export function renderMoodBlock(mood: CalendarMood | null = getCalendarMood()): string {
  if (!mood) return '';
  return ['# CURRENT MOOD', `Academic calendar phase: ${mood.phase}.`, mood.directive].join('\n');
}
