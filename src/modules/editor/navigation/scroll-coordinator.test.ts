import { describe, expect, it, vi } from 'vitest';
import { createScrollCoordinator } from './scroll-coordinator';
import {
  normalizeScrollPosition,
  type DocumentScrollPosition,
  type ScrollSurface,
} from './scroll-position';

function makeSurface(id: string, initial: DocumentScrollPosition = { line: 0, offset: 0 }) {
  let position = initial;
  const listeners = new Set<() => void>();
  const writes: DocumentScrollPosition[] = [];
  const surface: ScrollSurface = {
    id,
    readPosition: () => position,
    scrollToPosition(next) {
      position = next;
      writes.push(next);
      listeners.forEach(listener => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    surface,
    writes,
    get position() { return position; },
    setWithoutEvent(next: DocumentScrollPosition) { position = next; },
    userScroll(next: DocumentScrollPosition) {
      position = next;
      listeners.forEach(listener => listener());
    },
  };
}

describe('normalizeScrollPosition', () => {
  it('clamps line and fractional offset to the document bounds', () => {
    expect(normalizeScrollPosition({ line: -4, offset: 0.4 }, 10)).toEqual({ line: 0, offset: 0 });
    expect(normalizeScrollPosition({ line: 3, offset: 1.5 }, 10)).toEqual({ line: 4, offset: 0 });
    expect(normalizeScrollPosition({ line: 30, offset: 0 }, 10)).toEqual({ line: 9, offset: 1 });
  });

  it('preserves the fractional position within a line', () => {
    expect(normalizeScrollPosition({ line: 45, offset: 0.25 }, 100)).toEqual({ line: 45, offset: 0.25 });
  });
});

describe('createScrollCoordinator', () => {
  it('propagates user scrolling to every other registered surface', () => {
    const changed = vi.fn();
    const coordinator = createScrollCoordinator({ line: 2, offset: 0.5 }, changed);
    const source = makeSurface('source');
    const preview = makeSurface('preview');
    const minimap = makeSurface('minimap');

    coordinator.register(source.surface);
    coordinator.register(preview.surface);
    coordinator.register(minimap.surface);

    source.userScroll({ line: 45, offset: 0.25 });

    expect(coordinator.getPosition()).toEqual({ line: 45, offset: 0.25 });
    expect(preview.position).toEqual({ line: 45, offset: 0.25 });
    expect(minimap.position).toEqual({ line: 45, offset: 0.25 });
    expect(changed).toHaveBeenLastCalledWith({ line: 45, offset: 0.25 });
    coordinator.destroy();
  });

  it('does not feed programmatic scroll writes back as user input', () => {
    const coordinator = createScrollCoordinator();
    const source = makeSurface('source');
    const preview = makeSurface('preview');
    coordinator.register(source.surface);
    coordinator.register(preview.surface);

    source.userScroll({ line: 20, offset: 0.4 });

    expect(source.writes).toHaveLength(1);
    expect(preview.writes).toHaveLength(2);
    expect(coordinator.getPosition()).toEqual({ line: 20, offset: 0.4 });
    coordinator.destroy();
  });

  it('lets a minimap drive all registered surfaces through the same command', () => {
    const coordinator = createScrollCoordinator();
    const source = makeSurface('source');
    const preview = makeSurface('preview');
    coordinator.register(source.surface);
    coordinator.register(preview.surface);

    coordinator.scrollTo({ line: 72, offset: 0.6 });

    expect(source.position).toEqual({ line: 72, offset: 0.6 });
    expect(preview.position).toEqual({ line: 72, offset: 0.6 });
    coordinator.destroy();
  });

  it('restores the current position when a surface is registered later', () => {
    const coordinator = createScrollCoordinator({ line: 31, offset: 0.75 });
    const preview = makeSurface('preview');

    coordinator.register(preview.surface);

    expect(preview.position).toEqual({ line: 31, offset: 0.75 });
    coordinator.destroy();
  });

  it('captures the final position when a surface is detached', () => {
    const coordinator = createScrollCoordinator();
    const source = makeSurface('source');
    const detach = coordinator.register(source.surface);
    source.setWithoutEvent({ line: 44, offset: 0.5 });

    detach();

    expect(coordinator.getPosition()).toEqual({ line: 44, offset: 0.5 });
    coordinator.destroy();
  });

  it('does not overwrite the last captured position with a detached surface reset', () => {
    const coordinator = createScrollCoordinator();
    const source = makeSurface('source');
    let connected = true;
    const surface: ScrollSurface = {
      ...source.surface,
      isConnected: () => connected,
    };
    const detach = coordinator.register(surface);

    source.userScroll({ line: 44, offset: 0.5 });
    connected = false;
    source.setWithoutEvent({ line: 0, offset: 0 });

    detach();

    expect(coordinator.getPosition()).toEqual({ line: 44, offset: 0.5 });
    coordinator.destroy();
  });

  it('unregisters surfaces and clears subscriptions on destroy', () => {
    const coordinator = createScrollCoordinator();
    const source = makeSurface('source');
    const detach = coordinator.register(source.surface);
    detach();
    source.userScroll({ line: 10, offset: 0 });

    expect(coordinator.getPosition()).toEqual({ line: 0, offset: 0 });
    coordinator.destroy();
  });
});
