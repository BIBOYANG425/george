// src/adapters/spectrum-client.ts
// Narrow seam over the Photon SDK so src/adapters/spectrum.ts is testable
// with a fake. The real factory wires spectrum-ts (messages) + the Find My
// locations client. EXACT SDK names/signatures come from the Task 0 spike
// (docs/superpowers/notes/2026-spectrum-spike.md).
//
// Header last reviewed: 2026-06-11

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

// Real factory. Filled during the integration task once the live SDK + creds
// exist. Throws until then so accidental use in 'legacy' mode is obvious.
export async function createSpectrumClient(creds: SpectrumCredentials): Promise<SpectrumClient> {
  void creds
  throw new Error('createSpectrumClient not yet wired — integration task pending')
}
