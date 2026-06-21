// src/adapters/spectrum-client.ts
// Narrow seam over the Photon SDK so src/adapters/spectrum.ts is testable
// with a fake. The real factory wires spectrum-ts (messages) + the Find My
// locations client. EXACT SDK names/signatures come from the Task 0 spike
// (docs/superpowers/notes/2026-spectrum-spike.md).
//
// Dynamic-import pattern: top-level value imports of spectrum-ts are
// intentionally absent. spectrum-ts transitively depends on
// @photon-ai/imessage-kit (macOS-native bindings), so a top-level require
// crashes startup on Linux (the Cloudflare Container deploy target). The
// runtime imports live INSIDE createSpectrumClient(), matching the same guard
// pattern used by src/adapters/imessage.ts for @photon-ai/imessage-kit.
// Merely importing this module (for its exported interfaces/types) is safe on
// all platforms.
//
// Header last reviewed: 2026-06-13

// Mirrors @photon-ai/advanced-imessage SharedFriendLocation (fields we use).
// Lives here (not imported) because the location-normalize module is Phase 2.
export interface RawSpectrumLocation {
  latitude?: number
  longitude?: number
  locationType?: string
  expiresAt?: Date
  name?: string
  shortAddress?: string
  longAddress?: string
}

export interface InboundMessage {
  platform: string
  senderId: string
  contentType: string        // 'text' | 'attachment' | ...
  text: string
  messageId: string          // stable id for dedup
  // Which pool/dedicated line the conversation is routed through
  // (iMessage space.phone). On the shared pool this DIFFERS per user —
  // one project connection serves every line.
  linePhone?: string
  spaceType?: string         // 'dm' | 'group'
}

export interface ReplyHandle {
  sendText(text: string): Promise<void>
  sendAttachment(localPath: string): Promise<void>
  // Native iMessage tapback on the inbound message (👍/❤️/😂/👎/‼️/❓ …).
  // Best-effort — resolves silently when the platform has no reaction support
  // (the SDK's message.react() returns undefined and warns). Never throws into
  // the reply path: a failed tapback must not break the text reply.
  react(emoji: string): Promise<void>
  // Typing indicator ("…" bubble). Best-effort — platforms without a typing
  // API silently no-op. Used to show activity during the ~10s orchestrator turn.
  startTyping(): Promise<void>
  stopTyping(): Promise<void>
}

export interface SpectrumClient {
  messages(): AsyncIterable<readonly [ReplyHandle, InboundMessage]>
  getLocation(handle: string): Promise<RawSpectrumLocation | null>
  // Proactive send: opens a new 1:1 space to `handle` and sends each bubble as
  // a separate iMessage. Used by the squad-ping fan-out (no inbound context).
  sendProactive(handle: string, bubbles: string[]): Promise<void>
  close(): Promise<void>
}

export interface SpectrumCredentials {
  projectId: string
  projectSecret: string
  imessageAddress: string
  imessageToken: string
}

// Redact a sender handle (phone/email) for logs. Keeps the last 4 chars so a
// support thread is still correlatable, masks the rest so the full PII handle
// never lands in plaintext logs. Exported for testing.
export function redactHandle(handle: string | undefined | null): string {
  if (!handle) return '?'
  if (handle.length <= 4) return '*'.repeat(handle.length)
  return `${'*'.repeat(handle.length - 4)}${handle.slice(-4)}`
}

// Connection/transport faults where the request almost certainly never reached
// Spectrum, so a resend is safe (won't duplicate the bubble). Anything outside
// this set — validation, auth, "message too long", unknown — is NOT retried:
// space.send() exposes no idempotency key (confirmed against spectrum-ts 3.1.0),
// so blindly resending a non-transport failure risks a duplicate message if the
// original actually landed. Matched on message text because the SDK surfaces
// these as plain Errors without a typed code.
const TRANSIENT_SEND_ERROR =
  /connection dropped|upstream|econnreset|etimedout|epipe|socket hang up|stream (?:closed|ended|reset)|unavailable|deadline exceeded|503/i

// Whether a send error is a transient transport drop that is safe to resend.
// Exported for testing.
export function isTransientSendError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return TRANSIENT_SEND_ERROR.test(msg)
}

// Retry a fire-once send across a transient transport failure (e.g. the
// "[upstream] Connection dropped" we observed on the gRPC stream): the SDK
// re-establishes on the next call, so one retry after a brief backoff recovers
// a reply that would otherwise be silently lost. Only TRANSIENT transport errors
// are retried (see isTransientSendError) — space.send has no Spectrum-side
// dedupe key, so retrying a non-transport failure could duplicate the bubble.
// Throws the last error if all attempts fail OR the error is not retryable.
// Exported for testing; backoffMs/shouldRetry are injectable so tests run fast.
export async function sendWithRetry(
  fn: () => Promise<unknown>,
  opts: { attempts?: number; backoffMs?: number; shouldRetry?: (err: unknown) => boolean } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 2
  const backoffMs = opts.backoffMs ?? 600
  const shouldRetry = opts.shouldRetry ?? isTransientSendError
  for (let i = 0; ; i++) {
    try {
      await fn()
      return
    } catch (err) {
      if (i >= attempts - 1 || !shouldRetry(err)) throw err
      if (backoffMs > 0) await new Promise((r) => setTimeout(r, backoffMs))
    }
  }
}

// Real factory — wires spectrum-ts to the seam interfaces.
// imessage.config() uses the Spectrum cloud-managed pool (local: false, no
// dedicated-line address/token needed until Phase 2).
// SDK is dynamic-imported here so the native chain is never loaded on Linux.
export async function createSpectrumClient(creds: SpectrumCredentials): Promise<SpectrumClient> {
  const { Spectrum, attachment } = await import('spectrum-ts')
  const { imessage } = await import('spectrum-ts/providers/imessage')

  const app = await Spectrum({
    projectId: creds.projectId,
    projectSecret: creds.projectSecret,
    providers: [imessage.config()],
  })

  return {
    async *messages() {
      for await (const [space, message] of app.messages) {
        const sp = space as unknown as { phone?: string; type?: string }
        console.log(
          `[spectrum IN] line=${sp.phone ?? '?'} space=${sp.type ?? '?'} sender=${redactHandle(message.sender?.id)} type=${message.content.type} id=${message.id}`,
        )
        const replyHandle: ReplyHandle = {
          // Replies retry once across a transient stream drop so a generated
          // reply isn't silently lost. Typing is best-effort (no retry).
          // [spectrum OUT] logs make the RESPONDING surface observable: every
          // send attempt logs line + outcome so a silent outbound failure is
          // impossible to miss in deploy logs.
          sendText: async (text: string) => {
            try {
              await sendWithRetry(() => space.send(text))
              console.log(`[spectrum OUT] line=${sp.phone ?? '?'} to=${redactHandle(message.sender?.id)} kind=text chars=${text.length} ok`)
            } catch (err) {
              console.error(`[spectrum OUT] line=${sp.phone ?? '?'} to=${redactHandle(message.sender?.id)} kind=text FAILED: ${(err as Error).message}`)
              throw err
            }
          },
          sendAttachment: async (localPath: string) => {
            try {
              await sendWithRetry(() => space.send(attachment(localPath)))
              console.log(`[spectrum OUT] line=${sp.phone ?? '?'} to=${redactHandle(message.sender?.id)} kind=attachment path=${localPath.split('/').pop()} ok`)
            } catch (err) {
              console.error(`[spectrum OUT] line=${sp.phone ?? '?'} to=${redactHandle(message.sender?.id)} kind=attachment FAILED: ${(err as Error).message}`)
              throw err
            }
          },
          // Apply a native tapback to the inbound message. message.react()
          // resolves undefined (warns) when the platform lacks reactions, so a
          // miss is silent. Best-effort: never throw — a failed tapback must not
          // break the text reply that follows.
          react: async (emoji: string) => {
            try {
              await (message as unknown as { react(e: string): Promise<unknown> }).react(emoji)
              console.log(`[spectrum OUT] line=${sp.phone ?? '?'} to=${redactHandle(message.sender?.id)} kind=reaction emoji=${emoji} ok`)
            } catch (err) {
              console.error(`[spectrum OUT] line=${sp.phone ?? '?'} to=${redactHandle(message.sender?.id)} kind=reaction FAILED: ${(err as Error).message}`)
            }
          },
          startTyping: async () => { await space.startTyping() },
          stopTyping: async () => { await space.stopTyping() },
        }
        const inbound: InboundMessage = {
          platform: message.platform,
          // message.sender is User | undefined; User.id is the phone/email handle
          senderId: message.sender?.id ?? '',
          // message.content is a Content discriminated union; narrow to text
          contentType: message.content.type,
          text: message.content.type === 'text' ? message.content.text : '',
          // message.id is the stable SDK-assigned guid
          messageId: message.id,
          linePhone: sp.phone,
          spaceType: sp.type,
        }
        yield [replyHandle, inbound] as const
      }
    },

    // Phase 2: Find My location via @photon-ai/advanced-imessage dedicated line.
    // Returns null until a dedicated-line gRPC address + token is provisioned.
    async getLocation(_handle: string): Promise<RawSpectrumLocation | null> {
      return null
    },

    // Proactive outbound: open a new 1:1 iMessage space to `handle` and send
    // each bubble in order. Uses the same sendWithRetry wrapper as reactive
    // replies so transient stream drops are handled identically.
    // Space is created via imessage(app).space.create(handle) — spectrum-ts
    // SpaceNamespace API, confirmed against dist/types-Be0T6E0e.d.ts.
    async sendProactive(handle: string, bubbles: string[]): Promise<void> {
      const im = imessage(app)
      const space = await im.space.create(handle)
      for (const b of bubbles) {
        try {
          await sendWithRetry(() => space.send(b))
          console.log(`[spectrum OUT] line=proactive to=${redactHandle(handle)} kind=proactive chars=${b.length} ok`)
        } catch (err) {
          console.error(`[spectrum OUT] line=proactive to=${redactHandle(handle)} kind=proactive FAILED: ${(err as Error).message}`)
          throw err
        }
      }
    },

    async close(): Promise<void> {
      await app.stop()
    },
  }
}
