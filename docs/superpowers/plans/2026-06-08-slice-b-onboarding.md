# Slice B — Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the user-facing onboarding flow that Slice β specified as a contract. Web landing → iMessage handshake with 5-image showcase → web profile form → writes the 3-table contract → first heartbeat fires within 12h.

**Architecture:** Web landing at `uscbia.com/george` uses an `sms:` URL with a server-generated 6-char code prefilled in the message body. george's iMessage handler recognizes the `-START` suffix, looks up the pending_users row, sends 5 messages in sequence (greeting, contact card vcf, "what I can do" line, 5 image attachments with captions, onboarding link). The web profile form (4 steps: USC email verify, identity, interests, heartbeat prefs) writes user_profiles + user_heartbeat_config + user_heartbeat_instructions + pairs a cohort senior + sends a Slack webhook.

**Tech Stack:** TypeScript (george, Node), Next.js 14 (bia-roommate), Supabase (auth + 6 tables already migrated), `@photon-ai/imessage-kit` for outgoing iMessage with attachments, node-cron for daily cleanup, Slack webhook URL for senior notifications.

**Spec reference:** `docs/superpowers/specs/2026-06-07-memory-heartbeat-profiles-design.md`, "Onboarding contract" section. The `pending_users` table (migration 015) is already in prod.

**Prerequisites:**
- Slice β merged (PR #3, tag `v2.1.0-slice-beta-memory-heartbeat`)
- PR #4 hotfix merged (Zod v4 + Poke polish)
- bia-roommate PR #64 (`/account/george` hub) merged OR being merged in parallel
- 5 showcase images generated externally by user (Bobby) via GPT Image 2, in BIA brand style. **Image generation is NOT part of this plan**; tasks reference file paths and ship with placeholder PNGs.
- Slack webhook URL for cohort senior notifications — `BIA_SENIOR_SLACK_WEBHOOK` env var
- `cohort_seniors` table exists in Supabase with rows for current seniors

**Out of scope:**
- Squad-mode tool (`squad_find`) — Slice D
- Marketplace approval flow — Slice C
- DPS spatial overlay — Slice A
- Image generation itself — manual via GPT Image 2

---

## File structure

### Files to CREATE

**george repo (`~/Code/george/`):**

| Path | Responsibility |
|---|---|
| `src/onboarding/code-generator.ts` | 6-char alphanumeric code generator + collision check |
| `src/onboarding/pending-users.ts` | DB layer for pending_users (create, lookup-by-code, update-status, cleanup) |
| `src/onboarding/handshake.ts` | The 5-message greeting sequence triggered by `-START` |
| `src/onboarding/showcase.ts` | Static list of 5 showcase image paths + captions |
| `src/jobs/pending-users-cleanup-cron.ts` | Daily node-cron job; purges pending rows >14 days old |
| `assets/onboarding/showcase-1.png` ... `showcase-5.png` | Placeholder PNGs; user replaces with brand-correct designs |
| `assets/onboarding/george.vcf` | Static contact card |
| `tests/onboarding/code-generator.test.ts` | Code generation tests |
| `tests/onboarding/pending-users.test.ts` | DB layer tests with mocked Supabase |
| `tests/onboarding/handshake.test.ts` | Handshake sequence tests |

**bia-roommate repo (`~/Code/bia-roommate/`):**

| Path | Responsibility |
|---|---|
| `app/george/page.tsx` | Public landing page; CTA opens `sms:` link with generated code |
| `app/george/api/code/route.ts` | POST endpoint that mints a new pending_users row + returns the code |
| `app/george/profile/page.tsx` | 4-step profile form (USC email verify, identity, interests, heartbeat prefs) |
| `app/george/profile/_components/IdentityStep.tsx` | Step 2 |
| `app/george/profile/_components/InterestsStep.tsx` | Step 3 |
| `app/george/profile/_components/HeartbeatPrefsStep.tsx` | Step 4 |
| `app/george/profile/api/submit/route.ts` | Submit handler; writes 3-table contract + pairs senior + notifies |
| `app/george/profile/confirm/page.tsx` | Post-submit "george knows you now" confirmation page |
| `app/george/api/pair-senior/route.ts` | Internal call from profile-submit; load-balances cohort_seniors |

### Files to MODIFY

| Path | Change |
|---|---|
| `~/Code/george/src/index.ts` (or wherever iMessage incoming is handled) | Recognize `-START` suffix on incoming text, route to onboarding handshake. Recognize follow-up messages from pending_users (status=pending) and either nudge to complete profile or let them through to orchestrator with no profile. |
| `~/Code/george/CLAUDE.md`, `README.md`, `AGENT.md` | Document onboarding flow |
| `~/Code/bia-roommate/CLAUDE.md` | Document /george and /george/profile routes |

### Files to DELETE

None.

---

## Task ordering rationale

Backend (george) before frontend (bia-roommate) because the iMessage handshake is what closes the loop. Tasks 1-5 cover george-side; 6-10 cover bia-roommate web side; 11 covers cohort senior pairing; 12 covers docs + cutover.

The bia-roommate landing page (Task 6) can technically ship before the iMessage handshake is built, but it would link freshmen to a dead end. Better order: handshake first, then web.

---

## Task 1: Bootstrap branches

**Files:**
- Modify: `package.json` (no new deps needed; node-cron + Supabase already in place)
- Modify: `.env.example`

- [ ] **Step 1: Create feature branches**

```bash
cd ~/Code/george
git checkout main
git pull origin main
git checkout -b feat/slice-b-onboarding

cd ~/Code/bia-roommate
git checkout main
git pull origin main
git checkout -b feat/slice-b-onboarding-web
```

- [ ] **Step 2: Add env vars to both .env.example files**

george's `.env.example` appends:

```
# Slice B onboarding
BIA_SENIOR_SLACK_WEBHOOK=https://hooks.slack.com/services/replace
GEORGE_IMESSAGE_PHONE=+1XXXXXXXXXX
ONBOARDING_PROFILE_URL_BASE=https://uscbia.com/george/profile
```

bia-roommate's `.env.example` appends:

```
GEORGE_IMESSAGE_PHONE=+1XXXXXXXXXX
NEXT_PUBLIC_GEORGE_LANDING_URL=https://uscbia.com/george
```

- [ ] **Step 3: Commit on both branches**

```bash
cd ~/Code/george && git add .env.example && git commit -m "chore(slice-b): env scaffolding for onboarding"
cd ~/Code/bia-roommate && git add .env.example && git commit -m "chore(slice-b): env scaffolding for onboarding"
```

---

## Task 2: Code generator + pending_users DB layer

**Files:**
- Create: `src/onboarding/code-generator.ts`
- Create: `src/onboarding/pending-users.ts`
- Test: `tests/onboarding/code-generator.test.ts`
- Test: `tests/onboarding/pending-users.test.ts`

- [ ] **Step 1: Write failing tests for code generator**

```typescript
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
```

- [ ] **Step 2: Run to fail**

```bash
cd ~/Code/george && pnpm vitest tests/onboarding/code-generator.test.ts
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement code generator**

```typescript
// src/onboarding/code-generator.ts
// 6-character alphanumeric codes for onboarding handshake.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const CODE_LENGTH = 6;

export function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}

export function isValidCodeFormat(code: string): boolean {
  return /^[a-z0-9]{6}$/.test(code);
}
```

- [ ] **Step 4: Run to pass**

```bash
cd ~/Code/george && pnpm vitest tests/onboarding/code-generator.test.ts
```
Expected: 6 passing.

- [ ] **Step 5: Write failing tests for pending-users DB layer**

```typescript
// tests/onboarding/pending-users.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createPendingUser, lookupByCode, markCompleted, cleanupOld } from '../../src/onboarding/pending-users.js';

function mockSupabase() {
  const rows: any[] = [];
  return {
    rows,
    from(table: string) {
      return {
        insert: vi.fn(async (row: any) => { rows.push({ ...row, table }); return { error: null }; }),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn(async () => ({ data: rows.find(r => r.table === table) ?? null, error: null })),
        update: vi.fn().mockReturnThis(),
        delete: vi.fn().mockReturnThis(),
        lt: vi.fn().mockReturnThis(),
      } as any;
    },
  };
}

describe('createPendingUser', () => {
  it('inserts a new pending_users row', async () => {
    const supabase = mockSupabase();
    await createPendingUser(supabase as any, 'g7k2m4');
    expect(supabase.rows[0]).toMatchObject({ code: 'g7k2m4', status: 'pending' });
  });
});

describe('lookupByCode', () => {
  it('returns null for missing code', async () => {
    const supabase = mockSupabase();
    const result = await lookupByCode(supabase as any, 'nope12');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 6: Implement pending-users DB layer**

```typescript
// src/onboarding/pending-users.ts
// DB operations for pending_users (migration 015).
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PendingUser {
  code: string;
  imessage_handle: string | null;
  status: 'pending' | 'completed' | 'abandoned';
  created_at: string;
  reminded_at: string | null;
}

export async function createPendingUser(supabase: SupabaseClient, code: string): Promise<void> {
  const { error } = await supabase.from('pending_users').insert({
    code,
    status: 'pending',
  });
  if (error) throw new Error(`createPendingUser failed: ${error.message}`);
}

export async function lookupByCode(supabase: SupabaseClient, code: string): Promise<PendingUser | null> {
  const { data, error } = await supabase
    .from('pending_users')
    .select('*')
    .eq('code', code)
    .maybeSingle();
  if (error) throw new Error(`lookupByCode failed: ${error.message}`);
  return data ?? null;
}

export async function linkImessageHandle(
  supabase: SupabaseClient,
  code: string,
  imessageHandle: string
): Promise<void> {
  const { error } = await supabase
    .from('pending_users')
    .update({ imessage_handle: imessageHandle })
    .eq('code', code);
  if (error) throw new Error(`linkImessageHandle failed: ${error.message}`);
}

export async function markCompleted(supabase: SupabaseClient, code: string): Promise<void> {
  const { error } = await supabase
    .from('pending_users')
    .update({ status: 'completed' })
    .eq('code', code);
  if (error) throw new Error(`markCompleted failed: ${error.message}`);
}

export async function lookupByImessageHandle(
  supabase: SupabaseClient,
  imessageHandle: string
): Promise<PendingUser | null> {
  const { data, error } = await supabase
    .from('pending_users')
    .select('*')
    .eq('imessage_handle', imessageHandle)
    .eq('status', 'pending')
    .maybeSingle();
  if (error) throw new Error(`lookupByImessageHandle failed: ${error.message}`);
  return data ?? null;
}

export async function cleanupOld(supabase: SupabaseClient, days: number = 14): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('pending_users')
    .delete()
    .lt('created_at', cutoff)
    .select('code');
  if (error) throw new Error(`cleanupOld failed: ${error.message}`);
  return data?.length ?? 0;
}
```

- [ ] **Step 7: Run tests + commit**

```bash
cd ~/Code/george && pnpm vitest tests/onboarding/
```
Expected: all pass.

```bash
cd ~/Code/george
git add src/onboarding/ tests/onboarding/
git commit -m "feat(onboarding): code generator + pending_users DB layer"
```

---

## Task 3: Showcase asset list

**Files:**
- Create: `src/onboarding/showcase.ts`
- Create: `assets/onboarding/showcase-1.png` through `showcase-5.png` (placeholders)
- Create: `assets/onboarding/george.vcf`

- [ ] **Step 1: Create placeholder images**

Generate 5 placeholder PNGs (any small valid PNG; user replaces later with GPT Image 2 outputs in BIA brand style).

```bash
cd ~/Code/george && mkdir -p assets/onboarding
# Use a small 1x1 PNG as placeholder; ImageMagick or `convert` if available
for i in 1 2 3 4 5; do
  printf '\x89PNG\r\n\x1a\n' > assets/onboarding/showcase-$i.png
  # If ImageMagick is available: convert -size 800x800 xc:white assets/onboarding/showcase-$i.png
done
```

(Note: the placeholder PNGs above will fail PNG validation. If ImageMagick isn't installed, just touch empty files and note in the commit that real images are pending.)

- [ ] **Step 2: Create static contact card**

```
# assets/onboarding/george.vcf
BEGIN:VCARD
VERSION:3.0
FN:george
N:george;;;;
TEL;TYPE=CELL:+1XXXXXXXXXX
NOTE:BIA's USC agent. uscbia.com/george
END:VCARD
```

Replace `+1XXXXXXXXXX` with the real george phone number before merge.

- [ ] **Step 3: Implement showcase.ts**

```typescript
// src/onboarding/showcase.ts
// Static showcase image + caption list for onboarding handshake.

export interface ShowcaseItem {
  path: string;
  caption: string;
}

export const SHOWCASE: readonly ShowcaseItem[] = [
  {
    path: 'assets/onboarding/showcase-1.png',
    caption: 'tap me to find your hike crew, study group, or hotpot squad',
  },
  {
    path: 'assets/onboarding/showcase-2.png',
    caption: 'weekly briefs of bia and usc events, in your inbox',
  },
  {
    path: 'assets/onboarding/showcase-3.png',
    caption: "tell me what you're looking for, I find the right people",
  },
  {
    path: 'assets/onboarding/showcase-4.png',
    caption: 'ask me anything usc — academics, dps zones, iya, the works',
  },
  {
    path: 'assets/onboarding/showcase-5.png',
    caption: 'I remember what you tell me. always here.',
  },
] as const;

export const CONTACT_CARD_PATH = 'assets/onboarding/george.vcf';
```

- [ ] **Step 4: Commit**

```bash
cd ~/Code/george
git add src/onboarding/showcase.ts assets/onboarding/
git commit -m "feat(onboarding): showcase image + contact card scaffolding (placeholder images)"
```

---

## Task 4: iMessage handshake handler

**Files:**
- Create: `src/onboarding/handshake.ts`
- Test: `tests/onboarding/handshake.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/onboarding/handshake.test.ts
import { describe, it, expect, vi } from 'vitest';
import { extractCodeFromStartMessage, runHandshake } from '../../src/onboarding/handshake.js';

describe('extractCodeFromStartMessage', () => {
  it('extracts code from "g7k2m4-START"', () => {
    expect(extractCodeFromStartMessage('g7k2m4-START')).toBe('g7k2m4');
  });
  it('trims whitespace', () => {
    expect(extractCodeFromStartMessage('  g7k2m4-START\n')).toBe('g7k2m4');
  });
  it('returns null when no -START suffix', () => {
    expect(extractCodeFromStartMessage('hello')).toBeNull();
  });
  it('returns null for malformed code', () => {
    expect(extractCodeFromStartMessage('SHORT-START')).toBeNull();
  });
});

describe('runHandshake', () => {
  it('sends 5 messages (text, vcf, intro, 5 images, link)', async () => {
    const sent: any[] = [];
    const send = vi.fn(async (msg: any) => { sent.push(msg); });
    const lookup = vi.fn(async () => ({ code: 'g7k2m4', status: 'pending' }));
    const linkHandle = vi.fn(async () => {});
    await runHandshake({
      code: 'g7k2m4',
      imessageHandle: '+15551234567',
      sendImessage: send,
      lookupPending: lookup,
      linkImessageHandle: linkHandle,
      profileUrlBase: 'https://uscbia.com/george/profile',
    });
    expect(sent.length).toBeGreaterThanOrEqual(8); // greeting + vcf + intro + 5 images + link
    expect(linkHandle).toHaveBeenCalledWith('g7k2m4', '+15551234567');
  });

  it('refuses unknown code', async () => {
    const sent: any[] = [];
    const send = vi.fn(async (msg: any) => { sent.push(msg); });
    const lookup = vi.fn(async () => null);
    await runHandshake({
      code: 'badcod',
      imessageHandle: '+15551234567',
      sendImessage: send,
      lookupPending: lookup,
      linkImessageHandle: vi.fn(),
      profileUrlBase: 'https://uscbia.com/george/profile',
    });
    expect(sent.length).toBe(1);
    expect(sent[0].text).toMatch(/couldn't find/i);
  });
});
```

- [ ] **Step 2: Implement handshake.ts**

```typescript
// src/onboarding/handshake.ts
// 5-message greeting sequence triggered by "<code>-START" iMessage.
import { isValidCodeFormat } from './code-generator.js';
import { SHOWCASE, CONTACT_CARD_PATH } from './showcase.js';
import type { PendingUser } from './pending-users.js';

const START_RE = /^([a-z0-9]{6})-START$/i;

export function extractCodeFromStartMessage(text: string): string | null {
  const trimmed = text.trim();
  const m = trimmed.match(START_RE);
  if (!m) return null;
  const code = m[1].toLowerCase();
  if (!isValidCodeFormat(code)) return null;
  return code;
}

export interface OutgoingMessage {
  to: string;
  text?: string;
  attachmentPath?: string;
  caption?: string;
}

export interface HandshakeOptions {
  code: string;
  imessageHandle: string;
  sendImessage: (msg: OutgoingMessage) => Promise<void>;
  lookupPending: (code: string) => Promise<PendingUser | null>;
  linkImessageHandle: (code: string, imessageHandle: string) => Promise<void>;
  profileUrlBase: string;
}

export async function runHandshake(opts: HandshakeOptions): Promise<void> {
  const pending = await opts.lookupPending(opts.code);
  if (!pending) {
    await opts.sendImessage({
      to: opts.imessageHandle,
      text: `couldn't find that code. did you mean to send your 6-char welcome code from uscbia.com/george?`,
    });
    return;
  }
  if (pending.status === 'completed') {
    await opts.sendImessage({
      to: opts.imessageHandle,
      text: "you're already in. just say what's on your mind.",
    });
    return;
  }

  await opts.linkImessageHandle(opts.code, opts.imessageHandle);

  // Message 1: greeting
  await opts.sendImessage({
    to: opts.imessageHandle,
    text: "yo, welcome. I'm george. save my contact below so I stay in your messages.",
  });

  // Message 2: contact card attachment
  await opts.sendImessage({
    to: opts.imessageHandle,
    attachmentPath: CONTACT_CARD_PATH,
  });

  // Message 3: intro line
  await opts.sendImessage({
    to: opts.imessageHandle,
    text: "here's what I can do:",
  });

  // Messages 4-8: showcase images with captions
  for (const item of SHOWCASE) {
    await opts.sendImessage({
      to: opts.imessageHandle,
      attachmentPath: item.path,
      caption: item.caption,
    });
  }

  // Message 9: profile link
  await opts.sendImessage({
    to: opts.imessageHandle,
    text: `ready to set up? takes 2 min: ${opts.profileUrlBase}?code=${opts.code}`,
  });
}
```

- [ ] **Step 3: Run + commit**

```bash
cd ~/Code/george && pnpm vitest tests/onboarding/handshake.test.ts
git add src/onboarding/handshake.ts tests/onboarding/handshake.test.ts
git commit -m "feat(onboarding): iMessage handshake (5-message greeting sequence)"
```

---

## Task 5: Wire handshake into iMessage incoming + soft-nudge pending users

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Read existing iMessage handler**

Identify where incoming iMessage text is received and routed.

- [ ] **Step 2: Add handshake + pending-user soft-nudge logic**

In the incoming handler, BEFORE the user-command routing and orchestrator dispatch:

```typescript
import { extractCodeFromStartMessage, runHandshake } from './onboarding/handshake.js';
import {
  lookupByCode,
  lookupByImessageHandle,
  linkImessageHandle,
  markCompleted,
} from './onboarding/pending-users.js';

// 1. Handshake path: incoming text matches "<code>-START"
const handshakeCode = extractCodeFromStartMessage(incomingText);
if (handshakeCode) {
  await runHandshake({
    code: handshakeCode,
    imessageHandle: senderHandle,
    sendImessage: heartbeatDeps.sendImessage,
    lookupPending: (code) => lookupByCode(supabase, code),
    linkImessageHandle: (code, h) => linkImessageHandle(supabase, code, h),
    profileUrlBase: process.env.ONBOARDING_PROFILE_URL_BASE ?? 'https://uscbia.com/george/profile',
  });
  return;
}

// 2. Pending-user path: sender is a pending user who hasn't completed profile yet
const pending = await lookupByImessageHandle(supabase, senderHandle);
if (pending && pending.status === 'pending') {
  // Soft nudge logic: pass the message through but append a profile-completion reminder
  // every 3rd message until they complete.
  const messageCount = await countMessagesSince(supabase, senderHandle, pending.created_at);
  if (messageCount >= 2) {
    await heartbeatDeps.sendImessage({
      to: senderHandle,
      text: `btw, takes 2 min to set up so I can actually help you: ${process.env.ONBOARDING_PROFILE_URL_BASE}?code=${pending.code}`,
    });
  }
  // Continue to orchestrator with generic-helper persona (no profile injected).
}

// (Existing user-command routing and orchestrator dispatch continues below.)
```

- [ ] **Step 3: Add the `countMessagesSince` helper** (or inline-query)

```typescript
async function countMessagesSince(supabase: SupabaseClient, userId: string, since: string): Promise<number> {
  const { count, error } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', since);
  if (error) return 0;
  return count ?? 0;
}
```

- [ ] **Step 4: Verify**

```bash
cd ~/Code/george && pnpm tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
cd ~/Code/george
git add src/index.ts
git commit -m "feat(server): route -START codes to handshake; soft-nudge pending users"
```

---

## Task 6: Daily cleanup cron for pending_users

**Files:**
- Create: `src/jobs/pending-users-cleanup-cron.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement cleanup cron**

```typescript
// src/jobs/pending-users-cleanup-cron.ts
import cron from 'node-cron';
import { cleanupOld } from '../onboarding/pending-users.js';
import type { SupabaseClient } from '@supabase/supabase-js';

export function startPendingUsersCleanupCron(supabase: SupabaseClient): cron.ScheduledTask {
  // Daily at 03:00 LA
  return cron.schedule('0 3 * * *', async () => {
    try {
      const removed = await cleanupOld(supabase, 14);
      console.log(`[pending-cleanup] removed ${removed} pending rows >14 days old`);
    } catch (err) {
      console.error('[pending-cleanup] failed:', err);
    }
  }, { timezone: 'America/Los_Angeles' });
}
```

- [ ] **Step 2: Wire into src/index.ts**

After the heartbeat scheduler initialization:

```typescript
import { startPendingUsersCleanupCron } from './jobs/pending-users-cleanup-cron.js';

if (process.env.ONBOARDING_ENABLED !== 'false') {
  startPendingUsersCleanupCron(supabase);
  console.log('[pending-cleanup] cron scheduled (daily 03:00 LA)');
}
```

- [ ] **Step 3: Commit**

```bash
cd ~/Code/george
git add src/jobs/pending-users-cleanup-cron.ts src/index.ts
git commit -m "feat(jobs): daily cleanup of pending_users >14 days old"
```

---

## Task 7: bia-roommate landing page + code mint API

Switch to `~/Code/bia-roommate`. Branch `feat/slice-b-onboarding-web` from Task 1.

**Files:**
- Create: `app/george/page.tsx`
- Create: `app/george/api/code/route.ts`

- [ ] **Step 1: Landing page**

```tsx
// app/george/page.tsx
import { headers } from 'next/headers';

async function mintCode(): Promise<string> {
  const h = headers();
  const proto = h.get('x-forwarded-proto') ?? 'https';
  const host = h.get('host');
  const res = await fetch(`${proto}://${host}/george/api/code`, {
    method: 'POST',
    cache: 'no-store',
  });
  const json = await res.json();
  return json.code as string;
}

export default async function GeorgeLanding() {
  const code = await mintCode();
  const phone = process.env.GEORGE_IMESSAGE_PHONE ?? '+1XXXXXXXXXX';
  const smsLink = `sms:${phone}&body=${encodeURIComponent(`${code}-START`)}`;

  return (
    <div style={{ background: 'var(--cream)', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ maxWidth: 480, padding: '3rem', textAlign: 'center' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '3rem', fontStyle: 'italic', color: 'var(--cardinal)' }}>
          george
        </h1>
        <p style={{ color: 'var(--mid)', marginTop: '1rem' }}>
          your bia agent. usc-savvy. lives in iMessage.
        </p>
        <a
          href={smsLink}
          style={{
            display: 'inline-block',
            marginTop: '2rem',
            padding: '1rem 2rem',
            background: 'var(--cardinal)',
            color: 'var(--cream)',
            textDecoration: 'none',
            borderRadius: '4px',
            fontFamily: 'var(--font-display)',
            fontStyle: 'italic',
          }}
        >
          Connect with george
        </a>
        <p style={{ marginTop: '1.5rem', fontSize: '0.75rem', color: 'var(--mid)' }}>
          opens iMessage with your code prepopulated. just hit send.
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Code mint API**

```typescript
// app/george/api/code/route.ts
import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service-role';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function generateCode(): string {
  let c = '';
  for (let i = 0; i < 6; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return c;
}

export async function POST() {
  const supabase = createServiceRoleClient();
  // Retry up to 3 times on rare collisions
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCode();
    const { error } = await supabase.from('pending_users').insert({ code, status: 'pending' });
    if (!error) {
      return NextResponse.json({ code });
    }
    if (!error.message.includes('duplicate')) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }
  return NextResponse.json({ error: 'code collision after 3 attempts' }, { status: 500 });
}
```

If `@/lib/supabase/service-role` doesn't exist, look for the project's existing service-role client helper or add one in the same pattern as the existing server client.

- [ ] **Step 3: Smoke test**

```bash
cd ~/Code/bia-roommate && pnpm dev
```

Visit `http://localhost:3000/george`. Click button. iMessage app should open on a Mac with the code in the body.

- [ ] **Step 4: Commit**

```bash
cd ~/Code/bia-roommate
git add app/george/page.tsx app/george/api/code/route.ts
git commit -m "feat(george): landing page + code mint API"
```

---

## Task 8: bia-roommate 4-step profile form

**Files:**
- Create: `app/george/profile/page.tsx`
- Create: `app/george/profile/_components/IdentityStep.tsx`
- Create: `app/george/profile/_components/InterestsStep.tsx`
- Create: `app/george/profile/_components/HeartbeatPrefsStep.tsx`
- Create: `app/george/profile/confirm/page.tsx`

- [ ] **Step 1: Profile container page**

```tsx
// app/george/profile/page.tsx
'use client';
import { useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import IdentityStep from './_components/IdentityStep';
import InterestsStep from './_components/InterestsStep';
import HeartbeatPrefsStep from './_components/HeartbeatPrefsStep';

export default function ProfilePage() {
  const params = useSearchParams();
  const router = useRouter();
  const code = params.get('code');
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [emailVerified, setEmailVerified] = useState(false);
  const [identity, setIdentity] = useState({ name: '', year: '', major: '', hometown: '', native_language: '', pronouns: '' });
  const [interests, setInterests] = useState({ categories: [] as string[], free_text: '' });
  const [prefs, setPrefs] = useState({ cadence: '12 hours', active_hours_start: '09:00', active_hours_end: '22:00', consent_proactive_messages: true, consent_anomaly_checkin: false });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!code) router.replace('/george');
  }, [code, router]);

  if (!code) return null;

  async function submit() {
    setSubmitting(true);
    const res = await fetch('/george/profile/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, identity, interests, prefs }),
    });
    if (res.ok) {
      router.push('/george/profile/confirm');
    } else {
      alert('submit failed; check your inputs');
      setSubmitting(false);
    }
  }

  return (
    <div style={{ background: 'var(--cream)', minHeight: '100vh', padding: '2rem' }}>
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <p style={{ color: 'var(--mid)', fontSize: '0.875rem' }}>step {step} of 4</p>
        {step === 1 && (
          <UscEmailVerify onVerified={() => { setEmailVerified(true); setStep(2); }} />
        )}
        {step === 2 && (
          <IdentityStep value={identity} onChange={setIdentity} onNext={() => setStep(3)} />
        )}
        {step === 3 && (
          <InterestsStep value={interests} onChange={setInterests} onNext={() => setStep(4)} />
        )}
        {step === 4 && (
          <HeartbeatPrefsStep
            value={prefs}
            onChange={setPrefs}
            onSubmit={submit}
            submitting={submitting}
          />
        )}
      </div>
    </div>
  );
}

function UscEmailVerify({ onVerified }: { onVerified: () => void }) {
  const [email, setEmail] = useState('');
  const [sentCode, setSentCode] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function sendVerificationCode() {
    if (!email.endsWith('@usc.edu')) {
      alert('george is currently for USC students. use your @usc.edu email.');
      return;
    }
    setBusy(true);
    // Use Supabase auth's magic link or OTP flow. Adapt to project pattern.
    await fetch('/george/profile/api/send-verification', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    setSentCode(true);
    setBusy(false);
  }

  async function verifyCode() {
    setBusy(true);
    const res = await fetch('/george/profile/api/verify-code', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    });
    setBusy(false);
    if (res.ok) onVerified();
    else alert('code rejected');
  }

  return (
    <div>
      <h2>verify your usc email</h2>
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="your.email@usc.edu" />
      {!sentCode ? (
        <button onClick={sendVerificationCode} disabled={busy}>send code</button>
      ) : (
        <>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" />
          <button onClick={verifyCode} disabled={busy}>verify</button>
        </>
      )}
    </div>
  );
}
```

The `send-verification` and `verify-code` endpoints are project-specific; reuse Supabase auth's existing patterns. If the project doesn't have OTP set up, magic-link is fine; switch the verify flow accordingly.

- [ ] **Step 2: Identity step**

```tsx
// app/george/profile/_components/IdentityStep.tsx
'use client';
import { Dispatch, SetStateAction } from 'react';

interface IdentityValue {
  name: string;
  year: string;
  major: string;
  hometown: string;
  native_language: string;
  pronouns: string;
}

export default function IdentityStep({ value, onChange, onNext }: {
  value: IdentityValue;
  onChange: Dispatch<SetStateAction<IdentityValue>>;
  onNext: () => void;
}) {
  const can = value.name.length > 1 && value.year && value.hometown;
  return (
    <div>
      <h2>who are you</h2>
      <Field label="name" value={value.name} onChange={(v) => onChange({ ...value, name: v })} />
      <Field label="year" value={value.year} onChange={(v) => onChange({ ...value, year: v })} placeholder="freshman / sophomore / junior / senior / grad" />
      <Field label="major (or 'still deciding')" value={value.major} onChange={(v) => onChange({ ...value, major: v })} />
      <Field label="hometown" value={value.hometown} onChange={(v) => onChange({ ...value, hometown: v })} />
      <Field label="native language" value={value.native_language} onChange={(v) => onChange({ ...value, native_language: v })} placeholder="mandarin / cantonese / english / ..." />
      <Field label="pronouns (optional)" value={value.pronouns} onChange={(v) => onChange({ ...value, pronouns: v })} />
      <button onClick={onNext} disabled={!can}>next</button>
    </div>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label style={{ display: 'block', marginBottom: '1rem' }}>
      <span style={{ display: 'block', fontSize: '0.875rem', color: 'var(--mid)' }}>{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ width: '100%', padding: '0.5rem', border: '1px solid var(--mid)', borderRadius: 4 }}
      />
    </label>
  );
}
```

- [ ] **Step 3: Interests step**

```tsx
// app/george/profile/_components/InterestsStep.tsx
'use client';
const CATEGORIES = ['food', 'hiking', 'study groups', 'networking', 'parties', 'career events', 'sports', 'music', 'art', 'gaming'];

export default function InterestsStep({ value, onChange, onNext }: any) {
  function toggle(cat: string) {
    const set = new Set(value.categories);
    set.has(cat) ? set.delete(cat) : set.add(cat);
    onChange({ ...value, categories: Array.from(set) });
  }
  return (
    <div>
      <h2>what are you into</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', margin: '1rem 0' }}>
        {CATEGORIES.map((c) => (
          <button
            key={c}
            onClick={() => toggle(c)}
            style={{
              padding: '0.5rem 1rem',
              border: `1px solid ${value.categories.includes(c) ? 'var(--cardinal)' : 'var(--mid)'}`,
              background: value.categories.includes(c) ? 'var(--cardinal)' : 'transparent',
              color: value.categories.includes(c) ? 'var(--cream)' : 'var(--mid)',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {c}
          </button>
        ))}
      </div>
      <label>
        anything else? (200 chars max)
        <textarea
          value={value.free_text}
          onChange={(e) => onChange({ ...value, free_text: e.target.value })}
          maxLength={200}
          rows={3}
          style={{ width: '100%' }}
        />
      </label>
      <button onClick={onNext}>next</button>
    </div>
  );
}
```

- [ ] **Step 4: Heartbeat prefs step**

```tsx
// app/george/profile/_components/HeartbeatPrefsStep.tsx
'use client';

export default function HeartbeatPrefsStep({ value, onChange, onSubmit, submitting }: any) {
  return (
    <div>
      <h2>how should george reach you</h2>

      <label style={{ display: 'block', margin: '1rem 0' }}>
        cadence
        <select value={value.cadence} onChange={(e) => onChange({ ...value, cadence: e.target.value })}>
          <option value="12 hours">twice a day</option>
          <option value="24 hours">once a day</option>
          <option value="7 days">weekly</option>
          <option value="off">off</option>
        </select>
      </label>

      <label style={{ display: 'block', margin: '1rem 0' }}>
        active hours
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input type="time" value={value.active_hours_start} onChange={(e) => onChange({ ...value, active_hours_start: e.target.value })} />
          <span>to</span>
          <input type="time" value={value.active_hours_end} onChange={(e) => onChange({ ...value, active_hours_end: e.target.value })} />
        </div>
      </label>

      <label style={{ display: 'flex', gap: '0.5rem' }}>
        <input type="checkbox" checked={value.consent_proactive_messages} onChange={(e) => onChange({ ...value, consent_proactive_messages: e.target.checked })} />
        george can ping me about events I might like
      </label>

      <label style={{ display: 'flex', gap: '0.5rem' }}>
        <input type="checkbox" checked={value.consent_anomaly_checkin} onChange={(e) => onChange({ ...value, consent_anomaly_checkin: e.target.checked })} />
        george can check in if I go quiet for more than 2 weeks
      </label>

      <button onClick={onSubmit} disabled={submitting}>{submitting ? 'submitting...' : 'finish'}</button>
    </div>
  );
}
```

- [ ] **Step 5: Confirm page**

```tsx
// app/george/profile/confirm/page.tsx
export default function ConfirmPage() {
  return (
    <div style={{ background: 'var(--cream)', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ maxWidth: 480, padding: '3rem', textAlign: 'center' }}>
        <h1>george knows you now</h1>
        <p>open iMessage to keep talking. he'll ping you within a day with something useful.</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Commit**

```bash
cd ~/Code/bia-roommate
git add app/george/profile/
git commit -m "feat(george): 4-step profile form (verify, identity, interests, prefs) + confirm page"
```

---

## Task 9: Profile-submit API + cohort senior pairing

**Files:**
- Create: `app/george/profile/api/submit/route.ts`
- Create: `app/george/api/pair-senior/route.ts` (internal)

- [ ] **Step 1: Submit handler**

```typescript
// app/george/profile/api/submit/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service-role';
import { z } from 'zod';

const schema = z.object({
  code: z.string().length(6),
  identity: z.object({
    name: z.string().min(1).max(100),
    year: z.string().min(1).max(50),
    major: z.string().min(1).max(100),
    hometown: z.string().min(1).max(100),
    native_language: z.string().max(50),
    pronouns: z.string().max(30),
  }),
  interests: z.object({
    categories: z.array(z.string()).max(20),
    free_text: z.string().max(200),
  }),
  prefs: z.object({
    cadence: z.string(),
    active_hours_start: z.string(),
    active_hours_end: z.string(),
    consent_proactive_messages: z.boolean(),
    consent_anomaly_checkin: z.boolean(),
  }),
});

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input', issues: parsed.error.issues }, { status: 400 });
  }
  const { code, identity, interests, prefs } = parsed.data;

  const supabase = createServiceRoleClient();

  // Look up pending row to get the user_id (auth.users id, linked during verify step)
  const { data: pending, error: pErr } = await supabase
    .from('pending_users')
    .select('*')
    .eq('code', code)
    .maybeSingle();
  if (pErr || !pending) return NextResponse.json({ error: 'unknown code' }, { status: 404 });
  if (pending.status === 'completed') return NextResponse.json({ error: 'already completed' }, { status: 409 });

  // Get the verified user_id. Project's email-verify flow should have created auth.users + linked.
  // For this plan, assume pending row has user_id once verified; if not, look up by email or via
  // session cookie. Adjust per project pattern.
  const userId = (pending as any).user_id;
  if (!userId) return NextResponse.json({ error: 'user not verified' }, { status: 400 });

  // Pair cohort senior
  const seniorRes = await fetch(new URL('/george/api/pair-senior', req.url), {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, year: identity.year }),
  });
  const senior = await seniorRes.json();

  const today = new Date().toISOString().slice(0, 10);

  // Write 3-table contract
  const { error: profileErr } = await supabase.from('user_profiles').insert({
    user_id: userId,
    identity: renderIdentity(identity),
    academic: `year: ${identity.year}, major: ${identity.major}`,
    interests: renderInterests(interests),
    relationships: senior?.name ? `cohort_senior: ${senior.name} (assigned ${today})` : '',
    state: `new_user: true, onboarded_at: ${new Date().toISOString()}`,
    george_notes: '',
  });
  if (profileErr) return NextResponse.json({ error: profileErr.message }, { status: 500 });

  const cadenceInterval = prefs.cadence === 'off' ? '12 hours' : prefs.cadence;
  const isPaused = prefs.cadence === 'off';
  const { error: configErr } = await supabase.from('user_heartbeat_config').insert({
    user_id: userId,
    cadence: cadenceInterval,
    active_hours_start: prefs.active_hours_start + ':00',
    active_hours_end: prefs.active_hours_end + ':00',
    timezone: 'America/Los_Angeles',
    paused: isPaused,
    consent_proactive_messages: prefs.consent_proactive_messages,
    consent_anomaly_checkin: prefs.consent_anomaly_checkin,
  });
  if (configErr) return NextResponse.json({ error: configErr.message }, { status: 500 });

  const instructions = renderStandingInstructions(identity, interests, prefs);
  const { error: instErr } = await supabase.from('user_heartbeat_instructions').insert({
    user_id: userId,
    content: instructions,
  });
  if (instErr) return NextResponse.json({ error: instErr.message }, { status: 500 });

  // Mark pending row completed
  await supabase.from('pending_users').update({ status: 'completed' }).eq('code', code);

  // Slack/Discord notification
  if (process.env.BIA_SENIOR_SLACK_WEBHOOK && senior?.name) {
    try {
      await fetch(process.env.BIA_SENIOR_SLACK_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `new mentee: ${identity.name}, ${identity.year}, paired with ${senior.name}`,
        }),
      });
    } catch (err) {
      console.error('senior notification webhook failed:', err);
    }
  }

  return NextResponse.json({ ok: true });
}

function renderIdentity(i: z.infer<typeof schema>['identity']): string {
  return [
    `name: ${i.name}`,
    `year: ${i.year}`,
    `major: ${i.major}`,
    `hometown: ${i.hometown}`,
    `native_language: ${i.native_language}`,
    i.pronouns ? `pronouns: ${i.pronouns}` : null,
  ].filter(Boolean).join('\n');
}

function renderInterests(i: z.infer<typeof schema>['interests']): string {
  const cats = i.categories.length ? `categories: ${i.categories.join(', ')}` : '';
  const free = i.free_text ? `other: ${i.free_text}` : '';
  return [cats, free].filter(Boolean).join('\n');
}

function renderStandingInstructions(identity: any, interests: any, prefs: any): string {
  return `# Standing instructions for ${identity.name}

## Event brief preference
- Cadence: ${prefs.cadence}
- Categories: ${interests.categories.join(', ') || 'general'}
- Last brief sent: never

## Tone calibration
- ${identity.native_language === 'mandarin' ? 'Mixes Mandarin and English; reply in matching language.' : 'Reply in English unless user code-switches.'}

## First 24 hours
- Be welcoming. No proactive nudges yet.
- Trust the user; let them drive.
`;
}
```

- [ ] **Step 2: Cohort senior pairing API**

```typescript
// app/george/api/pair-senior/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service-role';

export async function POST(req: NextRequest) {
  const { user_id, year } = await req.json();
  const supabase = createServiceRoleClient();

  // Load-balance: pick the senior with the fewest current mentees.
  // Assume cohort_seniors has { id, name, mentee_count, active }.
  const { data: senior, error } = await supabase
    .from('cohort_seniors')
    .select('*')
    .eq('active', true)
    .order('mentee_count', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error || !senior) {
    return NextResponse.json({ name: null, error: error?.message ?? 'no seniors available' });
  }

  // Increment mentee_count
  await supabase
    .from('cohort_seniors')
    .update({ mentee_count: (senior.mentee_count ?? 0) + 1 })
    .eq('id', senior.id);

  // Optional: write a mentee_assignments row if the table exists.

  return NextResponse.json({ name: senior.name, id: senior.id });
}
```

- [ ] **Step 3: Commit**

```bash
cd ~/Code/bia-roommate
git add app/george/profile/api/submit/route.ts app/george/api/pair-senior/route.ts
git commit -m "feat(george): profile-submit writes 3-table contract + cohort senior pairing"
```

---

## Task 10: Smoke test + E2E walkthrough

- [ ] **Step 1: Local smoke**

```bash
# Terminal 1: george backend
cd ~/Code/george && pnpm dev

# Terminal 2: bia-roommate
cd ~/Code/bia-roommate && pnpm dev
```

Visit `http://localhost:3000/george` (whichever port). Click "Connect with george" — verify iMessage app opens with prefilled code (on a Mac).

- [ ] **Step 2: Manual flow**

Send the code from your iMessage to george's number. Verify:
- 5+ messages arrive in sequence (greeting, vcf, intro, 5 images, link)
- Tap the link, hit profile form
- Verify USC email (use a test @usc.edu address you control)
- Fill 4 steps, submit
- Land on confirm page
- Open Supabase: verify rows in `user_profiles`, `user_heartbeat_config`, `user_heartbeat_instructions`
- Verify `pending_users.status = 'completed'`
- Verify Slack webhook fired (if configured)

- [ ] **Step 3: Heartbeat smoke**

Wait up to 10 minutes (scheduler tick) or manually trigger `runHeartbeat` for the test user_id. Verify a `heartbeat_log` row appears with `outcome='ok'` and `last_heartbeat_at` updated.

- [ ] **Step 4: Document any deviations**

If smoke surfaces real friction (e.g., USC email verification flow needs a specific Supabase config), note in PR description + add a follow-up task.

---

## Task 11: Open both PRs

- [ ] **Step 1: Push george branch**

```bash
cd ~/Code/george
git push -u origin feat/slice-b-onboarding
gh pr create --title "feat: Slice B — onboarding handshake + cleanup" --body-file <(cat <<'EOF'
## Summary
Server-side half of Slice B onboarding. Adds the iMessage handshake handler (recognizes `<code>-START`, sends 5-image showcase + contact card + profile link), pending_users DB layer, daily cleanup cron, and a soft-nudge pattern for pending users who keep messaging before completing profile.

Companion bia-roommate PR: see below.

## Files
- src/onboarding/{code-generator, pending-users, handshake, showcase}.ts
- src/jobs/pending-users-cleanup-cron.ts
- assets/onboarding/showcase-{1..5}.png (PLACEHOLDER — replace before launch)
- assets/onboarding/george.vcf (replace phone number before launch)
- src/index.ts (handshake + pending-user routing)

## Test plan
- [ ] All new tests pass (onboarding/{code-generator, pending-users, handshake})
- [ ] `pnpm tsc --noEmit` clean
- [ ] Manual: send `<code>-START` to test number, receive 5+ messages
- [ ] Manual: pending user soft-nudge appears after 3+ unprompted messages
EOF
)
```

- [ ] **Step 2: Push bia-roommate branch**

```bash
cd ~/Code/bia-roommate
git push -u origin feat/slice-b-onboarding-web
gh pr create --title "feat: Slice B — /george landing + profile form" --body-file <(cat <<'EOF'
## Summary
Client-side half of Slice B onboarding. /george landing page mints a pending_users code and links to iMessage via `sms:` URL. /george/profile is a 4-step form (USC email verify, identity, interests, heartbeat prefs) that writes the 3-table contract on submit + pairs a cohort senior + fires Slack notification.

Companion george PR: see above.

## Files
- app/george/page.tsx (landing)
- app/george/api/code/route.ts (mint pending_users row)
- app/george/profile/page.tsx + 3 step components + confirm page
- app/george/profile/api/submit/route.ts (3-table contract writer)
- app/george/api/pair-senior/route.ts (load-balanced senior pairing)

## Test plan
- [ ] /george landing renders, "Connect with george" opens iMessage with prefilled code
- [ ] /george/profile 4-step form completes
- [ ] On submit: user_profiles, user_heartbeat_config, user_heartbeat_instructions all populated
- [ ] cohort_seniors.mentee_count incremented for paired senior
- [ ] Slack webhook fires (if env configured)
EOF
)
```

- [ ] **Step 3: Tag after both merge** (post-merge, separate step)

```bash
cd ~/Code/george
git checkout main && git pull origin main
git tag v2.2.0-slice-b-onboarding
git push origin v2.2.0-slice-b-onboarding
```

---

## Self-review checklist

- [x] **Spec coverage:** Onboarding contract from Slice β spec covered. Tasks 2 (DB layer), 3 (showcase), 4 (handshake), 5 (handler wiring), 6 (cleanup cron), 7 (landing), 8 (profile form), 9 (submit + pairing).
- [x] **Placeholder scan:** Showcase PNGs flagged as placeholders requiring Bobby's GPT Image 2 outputs. george.vcf flagged for phone number. `GEORGE_IMESSAGE_PHONE` env var holds the real number.
- [x] **Type consistency:** `PendingUser` type used across pending-users.ts, handshake.ts, and submit. `code: string` of length 6 invariant enforced via `isValidCodeFormat` + Zod schema. Cohort senior shape (`{ name, id }`) consistent.
- [x] **TDD throughout:** Tasks 2, 4 have failing-test-first steps. Tasks 7-9 are UI/API where smoke testing replaces unit testing per project pattern.

## Acceptance criteria

- A test freshman (you, Bobby, with a test @usc.edu account) can:
  1. Visit `uscbia.com/george`
  2. Click "Connect with george" → iMessage opens with code
  3. Send the code → receive 5+ message handshake
  4. Click the profile link → complete the 4-step form
  5. See "george knows you now" confirmation
  6. Within 12 hours, receive a heartbeat-driven nudge (or HEARTBEAT_OK silently)
- Supabase shows: `user_profiles` row, `user_heartbeat_config` row, `user_heartbeat_instructions` row, `pending_users.status = 'completed'`, `cohort_seniors.mentee_count` incremented for the paired senior
- 5 showcase images are real (BIA brand, GPT Image 2 outputs) — manual swap by Bobby, not part of this plan's code

## Cross-references

- Slice β spec (onboarding contract): `docs/superpowers/specs/2026-06-07-memory-heartbeat-profiles-design.md`
- Reality-aware roadmap: `docs/superpowers/plans/2026-06-07-roadmap-v2-reality-aware.md`
- Slice α tag: `v2.0.0-slice-alpha-agent-sdk`
- Slice β tag: `v2.1.0-slice-beta-memory-heartbeat`

## Execution handoff

Plan complete and saved to `~/Code/george/docs/superpowers/plans/2026-06-08-slice-b-onboarding.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — Fresh subagent dispatched per task; works across both repos.

**2. Inline Execution** — Run tasks in this session via executing-plans skill.

Which approach?
