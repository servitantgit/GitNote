import { describe, expect, it } from 'vitest';
import { chooseImageOutput, fitWithin } from './image-compress';

describe('image compression policy', () => {
  it('keeps dimensions within the maximum side without changing aspect ratio', () => {
    expect(fitWithin(4000, 2000)).toEqual({ width: 1920, height: 960 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('converts opaque PNG and BMP to JPEG, but preserves transparent PNG', () => {
    expect(chooseImageOutput('image/png', false, false)).toEqual({ mime: 'image/jpeg', quality: 0.85 });
    expect(chooseImageOutput('image/bmp', false, true)).toEqual({ mime: 'image/jpeg', quality: 0.85 });
    expect(chooseImageOutput('image/png', true, true)).toEqual({ mime: 'image/png' });
    expect(chooseImageOutput('image/png', true, false)).toBeNull();
  });

  it('re-encodes JPEG only when it needs scaling and leaves GIF/SVG/WebP untouched', () => {
    expect(chooseImageOutput('image/jpeg', false, true)).toEqual({ mime: 'image/jpeg', quality: 0.85 });
    expect(chooseImageOutput('image/jpeg', false, false)).toBeNull();
    for (const type of ['image/gif', 'image/svg+xml', 'image/webp']) {
      expect(chooseImageOutput(type, false, true)).toBeNull();
    }
  });
});
