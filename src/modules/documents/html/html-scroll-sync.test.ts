import { describe, expect, it } from 'vitest';
import { connectHtmlScrollSurfaces } from './html-scroll-sync';

function surface() {
  const element = document.createElement('div');
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 1100 },
  });
  return element;
}

describe('HTML scroll synchronization', () => {
  it('maps scroll positions proportionally in both directions', () => {
    const source = surface();
    const preview = surface();
    const cleanup = connectHtmlScrollSurfaces(source, preview);

    source.scrollTop = 500;
    source.dispatchEvent(new Event('scroll'));
    expect(preview.scrollTop).toBe(500);

    preview.scrollTop = 250;
    preview.dispatchEvent(new Event('scroll'));
    expect(source.scrollTop).toBe(250);

    cleanup();
  });

  it('does not retain listeners after detach', () => {
    const source = surface();
    const preview = surface();
    const cleanup = connectHtmlScrollSurfaces(source, preview);
    cleanup();

    source.scrollTop = 600;
    source.dispatchEvent(new Event('scroll'));
    expect(preview.scrollTop).toBe(0);
  });
});
