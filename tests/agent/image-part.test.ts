// tests/agent/image-part.test.ts
//
// Unit tests for the image-intake value type + guards shared across the
// transport → pipeline → orchestrator layers. Pure, no I/O.

import { describe, it, expect } from 'vitest';
import {
  isSupportedImageMime,
  SUPPORTED_IMAGE_MIMES,
  MAX_IMAGES_PER_TURN,
  MAX_IMAGE_BYTES,
} from '../../src/agent/image-part.js';

describe('isSupportedImageMime', () => {
  it('accepts the four supported image mimes', () => {
    for (const m of SUPPORTED_IMAGE_MIMES) expect(isSupportedImageMime(m)).toBe(true);
  });

  it('rejects non-image and unsupported mimes', () => {
    expect(isSupportedImageMime('image/heic')).toBe(false);
    expect(isSupportedImageMime('image/tiff')).toBe(false);
    expect(isSupportedImageMime('application/pdf')).toBe(false);
    expect(isSupportedImageMime('text/plain')).toBe(false);
  });

  it('rejects undefined / empty', () => {
    expect(isSupportedImageMime(undefined)).toBe(false);
    expect(isSupportedImageMime('')).toBe(false);
  });
});

describe('caps', () => {
  it('bounds images per turn and bytes per image', () => {
    expect(MAX_IMAGES_PER_TURN).toBe(4);
    expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
  });
});
