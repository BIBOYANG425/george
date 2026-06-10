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
    caption: 'ask me anything usc. academics, dps zones, iya, the works',
  },
  {
    path: 'assets/onboarding/showcase-5.png',
    caption: 'I remember what you tell me. always here.',
  },
] as const;

export const CONTACT_CARD_PATH = 'assets/onboarding/george.vcf';

// Path B (iPhone Shortcuts) consumes the outgoing queue on a phone that
// cannot read the backend's filesystem, so repo-relative asset paths must be
// rewritten to public URLs before enqueueing. Returns null when no base URL
// is configured — callers should then send text-only rather than enqueue
// paths the Shortcut can never resolve.
export function toPublicAssetUrls(
  localPaths: string[],
  baseUrl: string | undefined,
): string[] | null {
  if (!baseUrl) return null;
  const base = baseUrl.replace(/\/+$/, '');
  return localPaths.map((p) => {
    const filename = p.split('/').pop() ?? p;
    return `${base}/${filename}`;
  });
}
