import { markdownLanguage } from '@codemirror/lang-markdown';
import type { EditorView } from '@codemirror/view';

export interface DocumentScrollPosition {
  /** Zero-based document line at the top edge of the viewport. */
  line: number;
  /** Fraction of that line scrolled past, from 0 to 1. */
  offset: number;
}

export interface ScrollSurface {
  readonly id: string;
  readPosition(): DocumentScrollPosition;
  scrollToPosition(position: DocumentScrollPosition): void;
  subscribe(listener: () => void): () => void;
}

export function normalizeScrollPosition(
  position: DocumentScrollPosition,
  lineCount: number,
): DocumentScrollPosition {
  const count = Math.max(1, Math.floor(lineCount));
  const lastLine = count - 1;
  const line = Number.isFinite(position.line) ? Math.floor(position.line) : 0;
  const offset = Number.isFinite(position.offset) ? Math.min(1, Math.max(0, position.offset)) : 0;

  if (line < 0) return { line: 0, offset: 0 };
  if (line >= count) return { line: lastLine, offset: 1 };
  if (offset >= 1) {
    return line >= lastLine
      ? { line: lastLine, offset: 1 }
      : { line: line + 1, offset: 0 };
  }
  return { line, offset };
}

function mapValue(
  value: number,
  pairs: Array<{ document: number; preview: number }>,
  from: 'document' | 'preview',
  to: 'document' | 'preview',
): number {
  if (pairs.length < 2) return 0;
  const first = pairs[0];
  const last = pairs[pairs.length - 1];
  const bounded = Math.min(last[from], Math.max(first[from], value));
  for (let index = 0; index < pairs.length - 1; index += 1) {
    const start = pairs[index];
    const end = pairs[index + 1];
    if (bounded > end[from]) continue;
    const span = end[from] - start[from];
    if (span <= 0) return start[to];
    return start[to] + ((bounded - start[from]) / span) * (end[to] - start[to]);
  }
  return last[to];
}

function markdownAnchorLines(content: string): {
  headings: number[];
  images: number[];
  paragraphs: Array<{ start: number; end: number }>;
} {
  const headings: number[] = [];
  const images: number[] = [];
  const paragraphs: Array<{ start: number; end: number }> = [];
  const tree = markdownLanguage.parser.parse(content);

  tree.iterate({
    enter(node) {
      const startLine = content.slice(0, node.from).split(String.fromCharCode(10)).length - 1;
      if (node.name === 'Paragraph') {
        // Paragraph end positions are exclusive. Add one so the bottom edge
        // maps to the position immediately after its final source line.
        const endLine = content.slice(0, node.to).split(String.fromCharCode(10)).length;
        paragraphs.push({ start: startLine, end: endLine });
      } else if (node.name.includes('Heading')) {
        headings.push(startLine);
      } else if (node.name === 'Image') {
        images.push(startLine);
      }
    },
  });

  return { headings, images, paragraphs };
}

function previewPairs(
  element: HTMLElement,
  lineCount: number,
  source: { headings: number[]; images: number[]; paragraphs: Array<{ start: number; end: number }> },
) {
  const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
  if (maxScroll <= 0) return [{ document: 0, preview: 0 }, { document: lineCount, preview: 0 }];

  const bounds = element.getBoundingClientRect();
  const anchors: Array<{ document: number; preview: number }> = [
    { document: 0, preview: 0 },
    { document: lineCount, preview: maxScroll },
  ];
  const paragraphs = element.querySelectorAll<HTMLElement>('p');
  if (paragraphs.length === source.paragraphs.length) {
    paragraphs.forEach((paragraph, index) => {
      const anchor = source.paragraphs[index];
      const rect = paragraph.getBoundingClientRect();
      anchors.push(
        { document: anchor.start, preview: element.scrollTop + rect.top - bounds.top },
        { document: anchor.end, preview: element.scrollTop + rect.bottom - bounds.top },
      );
    });
  }

  const headings = element.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6');
  if (headings.length === source.headings.length) {
    headings.forEach((heading, index) => {
      anchors.push({
        document: source.headings[index],
        preview: element.scrollTop + heading.getBoundingClientRect().top - bounds.top,
      });
    });
  }

  const images = element.querySelectorAll<HTMLImageElement>('img');
  if (images.length === source.images.length) {
    images.forEach((image, index) => {
      const line = source.images[index];
      const rect = image.getBoundingClientRect();
      anchors.push(
        { document: line, preview: element.scrollTop + rect.top - bounds.top },
        { document: line + 1, preview: element.scrollTop + rect.bottom - bounds.top },
      );
    });
  }

  const valid = anchors
    .filter(anchor => Number.isFinite(anchor.document) && Number.isFinite(anchor.preview))
    .filter(anchor => anchor.document > 0 && anchor.document < lineCount)
    .filter(anchor => anchor.preview > 0 && anchor.preview < maxScroll)
    .sort((a, b) => a.document - b.document || a.preview - b.preview);

  const pairs = [{ document: 0, preview: 0 }];
  for (const anchor of valid) {
    const previous = pairs[pairs.length - 1];
    if (anchor.document > previous.document && anchor.preview > previous.preview) pairs.push(anchor);
  }
  pairs.push({ document: lineCount, preview: maxScroll });
  return pairs;
}

export function createCodeMirrorScrollSurface(view: EditorView): ScrollSurface {
  return {
    id: 'editor',
    readPosition() {
      const lineCount = view.state.doc.lines;
      // scrollTop is already expressed in document coordinates, which is the
      // coordinate system expected by lineBlockAtHeight().
      const documentOffset = view.scrollDOM.scrollTop;
      const block = view.lineBlockAtHeight(documentOffset);
      const line = view.state.doc.lineAt(block.from).number - 1;
      const height = Math.max(1, block.bottom - block.top);
      return normalizeScrollPosition({
        line,
        offset: (documentOffset - block.top) / height,
      }, lineCount);
    },
    scrollToPosition(position) {
      const normalized = normalizeScrollPosition(position, view.state.doc.lines);
      const lineNumber = normalized.line + 1;
      view.requestMeasure({
        key: view,
        read: () => {
          const line = view.state.doc.line(Math.min(lineNumber, view.state.doc.lines));
          const block = view.lineBlockAt(line.from);
          const height = Math.max(1, block.bottom - block.top);
          const target = block.top + height * normalized.offset;
          return target;
        },
        write: documentOffset => {
          view.scrollDOM.scrollTop = documentOffset;
        },
      });
    },
    subscribe(listener) {
      const handleScroll = () => listener();
      view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true });
      return () => view.scrollDOM.removeEventListener('scroll', handleScroll);
    },
  };
}

export function createPreviewScrollSurface(
  element: HTMLElement,
  content: string,
): ScrollSurface {
  const lineCount = Math.max(1, content.split('\n').length);
  const sourceAnchors = markdownAnchorLines(content);
  return {
    id: 'preview',
    readPosition() {
      const pairs = previewPairs(element, lineCount, sourceAnchors);
      const documentPosition = mapValue(element.scrollTop, pairs, 'preview', 'document');
      return normalizeScrollPosition({
        line: Math.floor(documentPosition),
        offset: documentPosition - Math.floor(documentPosition),
      }, lineCount);
    },
    scrollToPosition(position) {
      const normalized = normalizeScrollPosition(position, lineCount);
      const pairs = previewPairs(element, lineCount, sourceAnchors);
      element.scrollTop = mapValue(normalized.line + normalized.offset, pairs, 'document', 'preview');
    },
    subscribe(listener) {
      element.addEventListener('scroll', listener, { passive: true });
      const images = Array.from(element.querySelectorAll('img'));
      images.forEach(image => image.addEventListener('load', listener));
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(listener);
      observer?.observe(element);
      images.forEach(image => observer?.observe(image));
      return () => {
        element.removeEventListener('scroll', listener);
        images.forEach(image => image.removeEventListener('load', listener));
        observer?.disconnect();
      };
    },
  };
}
