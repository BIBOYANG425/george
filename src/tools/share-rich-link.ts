import { z } from 'zod'
import { wrapTool } from './_wrap.js'
import { getFlags } from '../flags.js'

// Flag gate (GEORGE_RICH_LINKS_ENABLED, default OFF). Read at module load, in
// lockstep with the ALL_TOOLS registration and the ORCHESTRATOR_DIRECT_TOOLS
// allowlist so the tool is present iff the feature is on. Same pattern as
// isRecallToolEnabled.
export function isRichLinksEnabled(): boolean {
  return getFlags().richLinksEnabled
}

const inputSchema = {
  url: z
    .string()
    .describe('The full https URL to share as a rich preview card (event page, housing listing, article, etc.).'),
}

// Signal tool: it does NOT send the card itself (it has no message handle).
// runOrchestrator detects this tool call in the SDK stream and yields a
// { type: 'richlink', url } event; the iMessage (Spectrum) transport sends it via
// space.send(richlink(url)). On channels that don't consume the event it's ignored
// (george's text reply, which should still name the link, carries the info there).
export async function shareRichLinkHandler(input: { url: string }): Promise<string> {
  const url = (input?.url ?? '').trim()
  if (!/^https?:\/\/\S+$/i.test(url)) return "share_rich_link needs a full http(s) 'url'."
  return `Rich link card for ${url} queued. Keep your text reply about it short — the card shows the title and preview.`
}

export const shareRichLinkTool = wrapTool({
  name: 'share_rich_link',
  description:
    'Share a URL as an iMessage rich preview CARD (title + image + link) instead of a bare URL — for a specific event page, ' +
    'housing listing, or article worth surfacing. Use DELIBERATELY and RARELY: one card for one genuinely useful link, never a ' +
    'dump of links, never for a URL you only half-remember (send only real URLs you have). Pair it with a short text reason in ' +
    'your own voice ("这个 listing 我看了下, 价格能打"). iMessage only — silently no-ops on other channels, so still name the link in text.',
  schema: inputSchema,
  handler: shareRichLinkHandler,
})
