// src/admin/crisis.ts
//
// Crisis radar — the highest-stakes detector in the dashboard. The asymmetry that
// shapes every choice here:
//   - a FALSE NEGATIVE means a student in real distress goes unseen;
//   - a FALSE POSITIVE means alarm fatigue that erodes trust in the whole queue.
// So distress detection is CURATED + hyperbole-aware, not a broad keyword sweep,
// and it only SURFACES candidates — a human acts on each one per the operational
// SOP. The radar is GATED OFF until that SOP exists (see getDistressQueue).

// Live switch. The crisis radar must NOT run live until the crisis-response SOP is
// defined (who watches, how often, escalation path, off-hours). Default OFF; set
// GEORGE_CRISIS_RADAR_ENABLED=true only once the SOP is in place. Read at call time
// (same pattern as MEMORY_CAPTURE_ENABLED) so it flips without a code change.
import { getFlags } from '../flags.js';

export function crisisRadarEnabled(): boolean {
  return getFlags().crisisRadarEnabled;
}

// Hyperbole / intensifier patterns that must NEVER count as distress. Chinese uses
// "X死了" as a casual intensifier (累死了 = exhausted, 饿死了 = starving, 笑死 =
// hilarious, 被这门课搞死了 = this class is brutal) — none are crisis. English has
// "dying to", "this is killing me", "dead tired". We neutralize these FIRST so a
// casual "死" can't trip a distress pattern.
const HYPERBOLE: RegExp[] = [
  /[笑饿累困热冷烦美吓气忙穷馋甜萌乏]死/g, // <intensifier>死 (笑死/饿死/累死…)
  /搞死|整死|作死|累垮|累成狗|忙成狗/g,
  /得想死|到想死/g, // "累得想死 / 困到想死" — intensifier, not ideation
  /dying to\b|killing me\b|dead tired|to die for|i could die\b/gi,
];

// Genuine distress / self-harm ideation (ZH + EN). High-precision: phrases that are
// rarely casual. Bare "想死" is deliberately EXCLUDED — it's overwhelmingly
// hyperbolic ("累得想死") and the unambiguous phrases below carry the real signal.
const DISTRESS: Array<{ sig: string; re: RegExp }> = [
  { sig: 'suicidal_zh', re: /不想活|活不下去|活着没(意思|意义)|没法活下去|想结束(自己|生命|这一切|一切)|结束自己|了结自己|轻生|自杀/ },
  { sig: 'selfharm_zh', re: /自残|伤害自己|割腕|跳楼|不如死了|消失算了|没人在乎我|撑不下去了|熬不下去了/ },
  {
    sig: 'suicidal_en',
    re: /\b(kill(ing)? myself|end(ing)? (my life|it all)|don'?t want to (live|be here|exist)|want to (be dead|die)|better off dead|no reason to live|suicidal|suicide|self[-\s]?harm|harm myself|hurt myself|cut myself)\b/i,
  },
];

// Return the distress signal names present in `text`, AFTER stripping hyperbole.
// Empty array = no distress detected. Pure + side-effect-free so it's unit-tested
// against a curated true/false corpus (the only way to trust a crisis heuristic).
export function distressSignals(text: string): string[] {
  if (!text) return [];
  let t = text;
  for (const h of HYPERBOLE) t = t.replace(h, ' '); // neutralize intensifiers first
  const hits: string[] = [];
  for (const d of DISTRESS) if (d.re.test(t)) hits.push(d.sig);
  return hits;
}
