import { describe, expect, it } from 'vitest';
import { createPreviewScrollSurface, normalizeScrollPosition } from './scroll-position';

describe('normalizeScrollPosition', () => {
  it('clamps the logical document position to its line range', () => {
    expect(normalizeScrollPosition({ line: -4, offset: 0.4 }, 10)).toEqual({ line: 0, offset: 0 });
    expect(normalizeScrollPosition({ line: 3, offset: 1.5 }, 10)).toEqual({ line: 4, offset: 0 });
    expect(normalizeScrollPosition({ line: 30, offset: 0 }, 10)).toEqual({ line: 9, offset: 1 });
  });

  it('preserves fractional position within a line', () => {
    expect(normalizeScrollPosition({ line: 45, offset: 0.25 }, 100)).toEqual({ line: 45, offset: 0.25 });
  });
});

describe('createPreviewScrollSurface', () => {
  it('maps a logical document line to the corresponding preview position', () => {
    const element = document.createElement('article');
    Object.defineProperties(element, {
      scrollHeight: { value: 1100, configurable: true },
      clientHeight: { value: 100, configurable: true },
      scrollTop: { value: 0, writable: true, configurable: true },
    });
    element.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100 } as DOMRect);
    const content = Array.from({ length: 10 }, (_, index) => `Line ${index + 1}`).join('\n');
    const surface = createPreviewScrollSurface(element, content);

    surface.scrollToPosition({ line: 5, offset: 0 });

    expect(element.scrollTop).toBe(500);
    expect(surface.readPosition()).toEqual({ line: 5, offset: 0 });
  });

  it('maps the height of an image block instead of treating it as one preview line', () => {
    const element = document.createElement('article');
    element.innerHTML = '<img src="image.png">';
    Object.defineProperties(element, {
      scrollHeight: { value: 1100, configurable: true },
      clientHeight: { value: 100, configurable: true },
      scrollTop: { value: 0, writable: true, configurable: true },
    });
    element.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100 } as DOMRect);
    const image = element.querySelector('img')!;
    image.getBoundingClientRect = () => ({ top: 400 - element.scrollTop, bottom: 800 - element.scrollTop, height: 400 } as DOMRect);
    const content = 'First line\nSecond line\n![image](image.png)\nFourth line\nFifth line';
    const surface = createPreviewScrollSurface(element, content);

    surface.scrollToPosition({ line: 2, offset: 0.5 });
    expect(element.scrollTop).toBe(600);

    element.scrollTop = 600;
    expect(surface.readPosition()).toEqual({ line: 2, offset: 0.5 });
  });
});
