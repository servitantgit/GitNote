export function connectHtmlScrollSurfaces(source: HTMLElement, preview: HTMLElement): () => void {
  let writingTo: HTMLElement | null = null;
  let expectedTop = 0;
  let frame = 0;

  const sync = (from: HTMLElement, to: HTMLElement) => {
    if (writingTo === from && Math.abs(from.scrollTop - expectedTop) < 1.5) {
      writingTo = null;
      return;
    }
    const fromRange = Math.max(0, from.scrollHeight - from.clientHeight);
    const toRange = Math.max(0, to.scrollHeight - to.clientHeight);
    if (fromRange === 0 || toRange === 0) return;
    const target = (from.scrollTop / fromRange) * toRange;
    if (Math.abs(to.scrollTop - target) < 1) return;

    writingTo = to;
    expectedTop = target;
    to.scrollTop = target;
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (writingTo === to && Math.abs(to.scrollTop - expectedTop) < 1.5) writingTo = null;
      frame = 0;
    });
  };

  const onSourceScroll = () => sync(source, preview);
  const onPreviewScroll = () => sync(preview, source);
  source.addEventListener('scroll', onSourceScroll, { passive: true });
  preview.addEventListener('scroll', onPreviewScroll, { passive: true });

  return () => {
    source.removeEventListener('scroll', onSourceScroll);
    preview.removeEventListener('scroll', onPreviewScroll);
    if (frame) cancelAnimationFrame(frame);
  };
}
