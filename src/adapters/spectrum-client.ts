// src/adapters/spectrum-client.ts
// Narrow seam over the Photon SDK so src/adapters/spectrum.ts is testable
// with a fake. The real factory wires spectrum-ts (messages) + the Find My
// locations client. EXACT SDK names/signatures come from the Task 0 spike
// (docs/superpowers/notes/2026-spectrum-spike.md).
//
// Header last reviewed: 2026-06-11

import { Spectrum, attachment } from 'spectrum-ts'
import { imessage } from 'spectrum-ts/providers/imessage'

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
}

export interface ReplyHandle {
  sendText(text: string): Promise<void>
  sendAttachment(localPath: string): Promise<void>
}

export interface SpectrumClient {
  messages(): AsyncIterable<readonly [ReplyHandle, InboundMessage]>
  getLocation(handle: string): Promise<RawSpectrumLocation | null>
  close(): Promise<void>
}

export interface SpectrumCredentials {
  projectId: string
  projectSecret: string
  imessageAddress: string
  imessageToken: string
}

// Real factory — wires spectrum-ts to the seam interfaces.
// imessage.config() uses the Spectrum cloud-managed pool (local: false, no
// dedicated-line address/token needed until Phase 2).
export async function createSpectrumClient(creds: SpectrumCredentials): Promise<SpectrumClient> {
  const app = await Spectrum({
    projectId: creds.projectId,
    projectSecret: creds.projectSecret,
    providers: [imessage.config()],
  })

  return {
    async *messages() {
      for await (const [space, message] of app.messages) {
        const replyHandle: ReplyHandle = {
          sendText: async (text: string) => { await space.send(text) },
          sendAttachment: async (localPath: string) => { await space.send(attachment(localPath)) },
        }
        const inbound: InboundMessage = {
          platform: message.platform,
          // message.sender is User | undefined; User.id is the phone/email handle
          senderId: message.sender?.id ?? '',
          // message.content is a Content discriminated union; narrow to text
          contentType: message.content.type,
          text: message.content.type === 'text' ? (message.content as { type: 'text'; text: string }).text : '',
          // message.id is the stable SDK-assigned guid
          messageId: message.id,
        }
        yield [replyHandle, inbound] as const
      }
    },

    // Phase 2: Find My location via @photon-ai/advanced-imessage dedicated line.
    // Returns null until a dedicated-line gRPC address + token is provisioned.
    async getLocation(_handle: string): Promise<RawSpectrumLocation | null> {
      return null
    },

    async close(): Promise<void> {
      await app.stop()
    },
  }
}
