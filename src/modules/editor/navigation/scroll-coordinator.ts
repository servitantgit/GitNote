import {
  normalizeScrollPosition,
  type DocumentScrollPosition,
  type ScrollSurface,
} from './scroll-position';

const INITIAL_POSITION: DocumentScrollPosition = { line: 0, offset: 0 };

function samePosition(a: DocumentScrollPosition, b: DocumentScrollPosition): boolean {
  // Keep echo detection below sub-pixel wheel movement. A wider tolerance can
  // mistake slow user scrolling for a pending programmatic scroll event.
  return Math.abs(a.line - b.line) < 0.002 && Math.abs(a.offset - b.offset) < 0.005;
}

/**
 * Coordinates every registered scroll surface around one logical document
 * position. Editors and previews provide adapters; a future minimap can call
 * scrollTo() and subscribe() without owning a second synchronization algorithm.
 */
export function createScrollCoordinator(
  initialPosition: DocumentScrollPosition = INITIAL_POSITION,
  onPositionChange: (position: DocumentScrollPosition) => void = () => undefined,
) {
  let position = normalizeScrollPosition(initialPosition, Number.MAX_SAFE_INTEGER);
  const surfaces = new Map<string, { surface: ScrollSurface; unsubscribe: () => void }>();
  const pendingWrites = new Map<string, DocumentScrollPosition>();
  const listeners = new Set<(next: DocumentScrollPosition) => void>();
  let destroyed = false;

  function publish(next: DocumentScrollPosition, sourceId?: string) {
    if (destroyed) return;
    position = normalizeScrollPosition(next, Number.MAX_SAFE_INTEGER);
    onPositionChange(position);
    listeners.forEach(listener => listener(position));

    for (const [id, entry] of surfaces) {
      if (id === sourceId) continue;
      pendingWrites.set(id, position);
      entry.surface.scrollToPosition(position);
    }
  }

  function handleSurfaceScroll(id: string) {
    const entry = surfaces.get(id);
    if (!entry || destroyed) return;
    let next: DocumentScrollPosition;
    try {
      next = entry.surface.readPosition();
    } catch {
      return;
    }

    const pending = pendingWrites.get(id);
    if (pending && samePosition(next, pending)) {
      pendingWrites.delete(id);
      return;
    }
    pendingWrites.delete(id);
    publish(next, id);
  }

  function register(surface: ScrollSurface): () => void {
    if (destroyed) return () => undefined;
    const previous = surfaces.get(surface.id);
    previous?.unsubscribe();
    pendingWrites.delete(surface.id);

    const unsubscribe = surface.subscribe(() => handleSurfaceScroll(surface.id));
    surfaces.set(surface.id, { surface, unsubscribe });
    pendingWrites.set(surface.id, position);
    surface.scrollToPosition(position);

    return () => {
      const current = surfaces.get(surface.id);
      if (current?.surface !== surface) return;
      // Do not read the surface during cleanup. React may already have hidden it
      // while keeping it connected, or reused its DOM for another document. In
      // either case scrollTop may be zero/clamped. Keep the last event-captured
      // logical position instead.
      current.unsubscribe();
      surfaces.delete(surface.id);
      pendingWrites.delete(surface.id);
    };
  }
  return {
    register,
    getPosition: () => position,
    scrollTo: (next: DocumentScrollPosition) => publish(next),
    subscribe(listener: (next: DocumentScrollPosition) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      surfaces.forEach(entry => entry.unsubscribe());
      surfaces.clear();
      pendingWrites.clear();
      listeners.clear();
    },
  };
}
