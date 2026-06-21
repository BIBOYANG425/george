import { z } from 'zod'
import { wrapTool } from './_wrap.js'

// iMessage tapbacks. The Spectrum SDK takes a raw emoji string and maps it to a
// native tapback; newer iMessage also supports arbitrary-emoji reactions, but
// these six are the universally-rendered classics, so we steer George to them.
export const TAPBACKS = ['👍', '❤️', '😂', '👎', '‼️', '❓'] as const

const inputSchema = {
  emoji: z
    .string()
    .describe(
      "The tapback emoji to apply to the user's most recent message. Prefer one of: " +
        '👍 (like/赞同) · ❤️ (love/暖) · 😂 (haha/好笑) · 👎 (dislike/不认同) · ‼️ (emphasize/强调) · ❓ (confused/疑问).',
    ),
}

// Signal tool: it does NOT send the tapback itself (it has no message handle).
// runOrchestrator detects this tool call in the SDK stream and yields a
// { type: 'reaction', emoji } event; the iMessage (Spectrum) transport applies
// it via message.react(emoji). On non-iMessage channels the event is ignored.
export async function reactToUserHandler(input: { emoji: string }): Promise<string> {
  const emoji = (input?.emoji ?? '').trim()
  if (!emoji) return "react_to_user needs an 'emoji' (e.g. 👍 ❤️ 😂 👎 ‼️ ❓)."
  return `Tapback ${emoji} applied to the user's last message. (Reply with text too if it fits.)`
}

export const reactToUserTool = wrapTool({
  name: 'react_to_user',
  description:
    "Send an iMessage tapback (点赞/比心/哈哈…) on the user's most recent message — like a real 学长 double-tapping a text. " +
    'Use SPARINGLY, only when a reaction genuinely fits the moment (affirmation→👍, warmth/good news→❤️, something funny→😂, ' +
    'disagree→👎, big emphasis→‼️, confusion→❓). This does NOT replace your text reply: react AND reply when both fit, ' +
    'or react alone for a quick wordless acknowledgement. iMessage only — silently no-ops on other channels.',
  schema: inputSchema,
  handler: reactToUserHandler,
})
