// src/tools/user-commands.ts
// 5 user-issued control commands: /profile, /correct, /pause, /resume, /delete me.
// parseAndRouteUserCommand is a pure parser — no I/O.
// executeUserCommand performs the action via injected deps.

import { BLOCK_NAMES, BlockName, Profile, ProfileStore } from '../memory/profile.js';

export type ParsedCommand =
  | { command: 'profile' }
  | { command: 'correct'; blockName: BlockName; newContent: string }
  | { command: 'pause'; durationDays: number }
  | { command: 'resume' }
  | { command: 'delete_me' }
  | null;

const PROFILE_RE = /^\/profile\s*$/i;
const CORRECT_RE = /^\/correct\s+(\w+)\s+([\s\S]+)$/i;
const PAUSE_RE = /^\/pause(?:\s+(\d+)\s*days?)?\s*$/i;
const RESUME_RE = /^\/resume\s*$/i;
const DELETE_RE = /^\/delete\s+me\s*$/i;

export function parseAndRouteUserCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  if (PROFILE_RE.test(trimmed)) return { command: 'profile' };

  const correctMatch = trimmed.match(CORRECT_RE);
  if (correctMatch) {
    const blockName = correctMatch[1].toLowerCase();
    const newContent = correctMatch[2].trim();
    if (BLOCK_NAMES.includes(blockName as BlockName)) {
      return { command: 'correct', blockName: blockName as BlockName, newContent };
    }
  }

  const pauseMatch = trimmed.match(PAUSE_RE);
  if (pauseMatch) {
    const days = pauseMatch[1] ? parseInt(pauseMatch[1], 10) : 7;
    return { command: 'pause', durationDays: days };
  }

  if (RESUME_RE.test(trimmed)) return { command: 'resume' };
  if (DELETE_RE.test(trimmed)) return { command: 'delete_me' };

  return null;
}

export interface UserCommandDeps {
  profileStore: ProfileStore;
  setPaused: (userId: string, until: Date | null) => Promise<void>;
  deleteUserData: (userId: string) => Promise<void>;
  sendImessage: (msg: { to: string; text: string }) => Promise<void>;
  setDeleteConfirmPending: (userId: string, pending: boolean) => Promise<void>;
  getDeleteConfirmPending: (userId: string) => Promise<boolean>;
  writeAudit: (entry: { userId: string; action: string; payload: Record<string, unknown> }) => Promise<void>;
}

export async function executeUserCommand(
  userId: string,
  parsed: ParsedCommand,
  deps: UserCommandDeps,
  _rawText: string,
): Promise<string> {
  if (parsed === null) throw new Error('Not a command');

  if (parsed.command === 'profile') {
    const profile = await deps.profileStore.loadProfile(userId);
    try {
      await deps.writeAudit({ userId, action: 'profile_view', payload: {} });
    } catch {
      // audit table may not exist yet; don't fail the command
    }
    return renderProfilePlainEnglish(profile);
  }

  if (parsed.command === 'correct') {
    await deps.profileStore.saveBlock(userId, parsed.blockName, parsed.newContent);
    try {
      await deps.writeAudit({
        userId,
        action: 'profile_correct',
        payload: { block: parsed.blockName, length: parsed.newContent.length },
      });
    } catch {
      // audit table may not exist yet; don't fail the command
    }
    return `got it. updated ${parsed.blockName}.`;
  }

  if (parsed.command === 'pause') {
    const until = new Date(Date.now() + parsed.durationDays * 24 * 60 * 60 * 1000);
    await deps.setPaused(userId, until);
    try {
      await deps.writeAudit({ userId, action: 'heartbeat_pause', payload: { days: parsed.durationDays } });
    } catch {
      // audit table may not exist yet; don't fail the command
    }
    return `paused for ${parsed.durationDays} days. /resume to undo.`;
  }

  if (parsed.command === 'resume') {
    await deps.setPaused(userId, null);
    try {
      await deps.writeAudit({ userId, action: 'heartbeat_resume', payload: {} });
    } catch {
      // audit table may not exist yet; don't fail the command
    }
    return `resumed.`;
  }

  if (parsed.command === 'delete_me') {
    const pending = await deps.getDeleteConfirmPending(userId);
    if (!pending) {
      await deps.setDeleteConfirmPending(userId, true);
      return `this clears your profile + all heartbeats + history + iMessage link. reply /delete me again within 5 min to confirm, or /resume to cancel.`;
    }
    await deps.deleteUserData(userId);
    await deps.setDeleteConfirmPending(userId, false);
    try {
      await deps.writeAudit({ userId, action: 'user_delete', payload: {} });
    } catch {
      // audit table may not exist yet; don't fail the command
    }
    return `done. take care.`;
  }

  throw new Error(`Unhandled command: ${(parsed as { command: string }).command}`);
}

export function renderProfilePlainEnglish(profile: Profile): string {
  const parts: string[] = ['here is what I know about you:'];
  if (profile.identity) parts.push(`identity: ${profile.identity}`);
  if (profile.academic) parts.push(`academic: ${profile.academic}`);
  if (profile.interests) parts.push(`interests: ${profile.interests}`);
  if (profile.relationships) parts.push(`relationships: ${profile.relationships}`);
  if (profile.state) parts.push(`state: ${profile.state}`);
  // george_notes is a pure scratchpad now (the raised-thread ledger lives in the
  // proactive_raised_threads table), so it renders directly as commitments.
  if (profile.george_notes) parts.push(`commitments: ${profile.george_notes}`);
  if (parts.length === 1) parts.push('(nothing yet — we are just getting started)');
  parts.push('\nthe full version is on uscbia.com/account/george.');
  return parts.join('\n');
}
