// src/agent/activity-state.ts
//
// "Activity state" is the time-of-day sibling of calendar-mood.ts: where the
// calendar mood injects the academic-season tone, this injects a plausible
// guess at what George — a real USC senior — would be doing right now in LA
// time (awake / late-night / asleep / probably-in-class / probably-busy). It's
// a cheap PURE function, not an LLM classifier (per the plan's cut list), and
// returns an append-or-empty-string block so orchestrator.ts can inject it
// unconditionally, exactly like renderMoodBlock().
//
// This does NOT add response delays and never makes George claim he is asleep
// when he is plainly replying — it only colors HOW he replies (a 3am ping can
// be met at the hour, an early-morning ping can be a little slower-energy). The
// existing late-night-activity-is-real voice rule (AGENT.md) is the anchor.
//
// Gated by GEORGE_ACTIVITY_STATE_ENABLED. When the flag is unset, render()
// returns '' so prompt assembly is byte-for-byte unchanged.

import { tzHourMinute } from './la-time.js';

export type ActivityPhase = 'late-night' | 'sleeping' | 'in-class' | 'busy' | 'awake';

export interface ActivityState {
  phase: ActivityPhase;
  // A short, in-voice note appended to the system prompt. Describes George's
  // own plausible state so he can let it color tone — never a hard instruction
  // to behave a certain way, never a script to read out.
  directive: string;
}

function flagOn(): boolean {
  return process.env.GEORGE_ACTIVITY_STATE_ENABLED === 'true';
}

// Classify a plausible state from the LA wall-clock hour. Windows are
// deliberately coarse and a touch generous on the awake side — George is a
// night owl who organizes the group chat, so "asleep" is a narrow band and
// late-night is real, matching the founder voice.
//
// Returns null on a normal mid-day awake stretch (no overlay needed), so the
// injected note stays the exception, not the default. Always computable; only
// the render gate is flagged, so the classifier itself is easy to unit-test.
export function getActivityState(now: Date = new Date()): ActivityState | null {
  const { hours } = tzHourMinute(now);

  // 02:00–07:00 LA: deep sleep band. Narrow on purpose — George stays up late.
  if (hours >= 2 && hours < 7) {
    return {
      phase: 'sleeping',
      directive:
        "It's the middle of the night in LA and you'd normally be asleep. If you reply, " +
        "it's fine to sound like you just woke up or are half-awake; keep it short and low-energy. " +
        "Don't fake being a morning person.",
    };
  }
  // 00:00–02:00 LA: late-night, still up. The 3am-snack energy from your voice.
  if (hours >= 0 && hours < 2) {
    return {
      phase: 'late-night',
      directive:
        "It's deep into the night in LA and you're still up — that's normal for you. " +
        "You can match the late hour (the 宵夜 / still-grinding energy) instead of pretending you turn in early.",
    };
  }
  // 09:00–11:00 and 13:00–16:00 LA on weekdays: likely in or around class.
  const day = now.getUTCDay(); // good-enough weekday signal; exact LA day not needed for tone
  const weekday = day >= 1 && day <= 5;
  if (weekday && ((hours >= 9 && hours < 11) || (hours >= 13 && hours < 16))) {
    return {
      phase: 'in-class',
      directive:
        "It's the middle of a weekday in LA — you might be in or near class, so a slightly clipped, " +
        "between-things tone is natural. Still help fully; just don't sound like you're sitting around waiting.",
    };
  }
  // 18:00–21:00 LA: evening — out, eating, busy with stuff. Warm but unhurried.
  if (hours >= 18 && hours < 21) {
    return {
      phase: 'busy',
      directive:
        "It's evening in LA — you're probably out, eating, or in the middle of something. " +
        "A relaxed, off-the-cuff tone fits; you don't have to sound at-your-desk.",
    };
  }
  // 07:00–09:00 LA: just up, lower energy. (Folded into the broad awake bucket
  // below to keep the table small — only return a note when it actually shifts
  // tone.) Everything else is a normal awake stretch: no overlay.
  return null;
}

// Render the activity state as a prompt section, or '' when the flag is off or
// there is no active state — so callers append unconditionally (same contract
// as renderMoodBlock()). The block is small and in-voice and adds NO new rules.
export function renderActivityBlock(state: ActivityState | null = flagOn() ? getActivityState() : null): string {
  if (!flagOn()) return '';
  if (!state) return '';
  return ['# RIGHT NOW (your own state)', state.directive].join('\n');
}

// Below this gap, a delay is just normal back-and-forth — no context injected.
const DELAY_CONTEXT_MIN_MS = 6 * 60 * 60 * 1000; // 6h

// Per-turn delay context: when the user pinged and there was a long gap since
// George's last reply, hand the model a tiny note so it CAN acknowledge the gap
// naturally ("sorry just saw this, was asleep") if it fits — in line with the
// late-hour state. This is CONTEXT, not a delay: George still replies fast (the
// plan explicitly forbids artificial response delays). Prepended to the turn's
// user text by the caller (spectrum.ts), not a system block, so it reads as
// situational awareness for this one message.
//
// Returns '' when the flag is off, the gap is short, or the gap is unknown — so
// the caller can prepend unconditionally and the default is byte-for-byte
// unchanged. `now` defaults to the current time and is used only to pick a
// plausible reason for the gap (asleep / late-night / busy).
export function renderDelayContext(gapMs: number, now: Date = new Date()): string {
  if (!flagOn()) return '';
  if (!Number.isFinite(gapMs) || gapMs < DELAY_CONTEXT_MIN_MS) return '';
  const hours = Math.round(gapMs / (60 * 60 * 1000));
  const state = getActivityState(now);
  // If George was plausibly asleep through the gap, give him that as the reason;
  // otherwise keep it neutral (busy / just-saw-it). Never fabricate a specific
  // excuse — the model decides whether and how to acknowledge it.
  const reason =
    state?.phase === 'sleeping'
      ? "you were probably asleep"
      : state?.phase === 'late-night'
        ? "it's late and you were up doing your own thing"
        : "you were busy and away from your phone";
  return [
    '# GAP SINCE YOUR LAST REPLY',
    `It's been roughly ${hours}h since you last replied to this person — ${reason}.`,
    "If it feels natural, you can briefly own the gap in your own voice (e.g. just-saw-this / was-asleep).",
    "Keep it light and don't over-apologize. If it doesn't fit, just answer their message normally.",
  ].join('\n');
}
