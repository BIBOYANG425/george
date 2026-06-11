// tests/onboarding/showcase.test.ts
import { describe, it, expect } from 'vitest';
import { SHOWCASE, toPublicAssetUrls } from '../../src/onboarding/showcase.js';

describe('toPublicAssetUrls', () => {
  it('maps repo-relative paths to URLs under the base', () => {
    expect(
      toPublicAssetUrls(['assets/onboarding/showcase-1.png', 'assets/onboarding/george.vcf'], 'https://uscbia.com/onboarding-assets'),
    ).toEqual([
      'https://uscbia.com/onboarding-assets/showcase-1.png',
      'https://uscbia.com/onboarding-assets/george.vcf',
    ]);
  });

  it('tolerates a trailing slash on the base', () => {
    expect(toPublicAssetUrls(['assets/onboarding/showcase-1.png'], 'https://x.test/a/')).toEqual([
      'https://x.test/a/showcase-1.png',
    ]);
  });

  it('returns null when no base URL is configured', () => {
    expect(toPublicAssetUrls(SHOWCASE.map((s) => s.path), undefined)).toBeNull();
  });
});
