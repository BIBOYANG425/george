// A downloaded inbound image, ready to hand to Claude as a vision content block.
// Shared across the transport → pipeline → orchestrator layers so none of them
// has to know how the others fetch or format it.

export type SupportedImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

export const SUPPORTED_IMAGE_MIMES: readonly SupportedImageMime[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]

export function isSupportedImageMime(mime: string | undefined): mime is SupportedImageMime {
  return !!mime && (SUPPORTED_IMAGE_MIMES as readonly string[]).includes(mime)
}

export interface ImagePart {
  mimeType: SupportedImageMime
  dataBase64: string
}

// Caps: George's vision turns are bounded so a flood of large images can't blow
// the context window or the reply latency. Claude accepts up to ~5MB/image.
export const MAX_IMAGES_PER_TURN = 4
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
