import { useEffect, useRef } from 'react';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { RefObject } from 'react';
import type { DocumentScrollPosition } from './navigation/scroll-position';
import type { EditorMode } from './types';

type LineKind = 'text' | 'heading' | 'code' | 'list';

interface ScrollController {
  getPosition(): DocumentScrollPosition;
  scrollTo(position: DocumentScrollPosition): void;
  subscribe(listener: (position: DocumentScrollPosition) => void): () => void;
}

interface Props {
  view: EditorView | null;
  content: string;
  mode: EditorMode;
  previewRef: RefObject<HTMLElement | null>;
  coordinator: ScrollController;
}

export function buildMinimapLineKinds(content: string): LineKind[] {
  const document = Text.of(content.split('\n'));
  const kinds: LineKind[] = Array.from({ length: document.lines }, () => 'text');
  const tree = markdownLanguage.parser.parse(content);

  tree.iterate({
    enter(node) {
      let kind: LineKind | null = null;
      if (node.name.includes('Heading')) kind = 'heading';
      else if (node.name === 'FencedCode') kind = 'code';
      else if (node.name === 'BulletList' || node.name === 'OrderedList' || node.name === 'ListItem') {
        kind = 'list';
      }
      if (!kind) return;

      const first = document.lineAt(node.from).number - 1;
      const last = document.lineAt(Math.max(node.from, node.to - 1)).number - 1;
      for (let line = first; line <= last; line += 1) {
        if (kind === 'heading' || kinds[line] === 'text' || kind === 'code') kinds[line] = kind;
      }
    },
  });

  return kinds;
}

export function positionAtMinimapRatio(ratio: number, lineCount: number): DocumentScrollPosition {
  const count = Math.max(1, Math.floor(lineCount));
  const bounded = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  const value = bounded * count;
  const line = Math.min(count - 1, Math.floor(value));
  return { line, offset: Math.min(0.999, value - line) };
}

export function Minimap({ view, content, mode, previewRef, coordinator }: Props) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper || !view) return;

    let frame = 0;
    let destroyed = false;
    const lineKinds = buildMinimapLineKinds(content);

    const paint = () => {
      frame = 0;
      if (destroyed) return;
      const context = canvas.getContext('2d');
      if (!context) return;

      const width = 96;
      const height = Math.max(1, wrapper.clientHeight);
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const pixelWidth = Math.max(1, Math.floor(width * ratio));
      const pixelHeight = Math.max(1, Math.floor(height * ratio));
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      canvas.style.width = width + 'px';
      canvas.style.height = '100%';
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      const style = getComputedStyle(wrapper);
      const background = style.getPropertyValue('--panel').trim() || '#ffffff';
      const textColor = style.getPropertyValue('--muted').trim() || '#747d89';
      const headingColor = style.getPropertyValue('--accent').trim() || '#315f9b';
      const codeColor = '#39845b';
      const listColor = '#b7791f';
      const cursorColor = '#d97706';

      const document = view.state.doc;
      const lineCount = Math.max(1, document.lines);
      context.clearRect(0, 0, width, height);
      context.fillStyle = background;
      context.fillRect(0, 0, width, height);

      const rowHeight = height / lineCount;
      for (let index = 0; index < lineCount; index += 1) {
        const line = document.line(index + 1).text;
        if (!line.trim()) continue;
        const density = Math.min(1, line.trim().length / 72);
        const barWidth = Math.max(2, Math.floor((0.12 + density * 0.78) * (width - 8)));
        const y = index * rowHeight;
        context.fillStyle = lineKinds[index] === 'heading'
          ? headingColor
          : lineKinds[index] === 'code'
            ? codeColor
            : lineKinds[index] === 'list'
              ? listColor
              : textColor;
        context.globalAlpha = 0.5 + density * 0.4;
        context.fillRect(4, y, barWidth, Math.max(1, rowHeight * 0.88));
      }
      context.globalAlpha = 1;

      const position = coordinator.getPosition();
      const logicalTop = Math.min(lineCount - 1, Math.max(0, position.line + position.offset));
      let visibleLines = 1;

      if (mode === 'preview') {
        const preview = previewRef.current;
        if (preview && preview.clientHeight > 0 && preview.scrollHeight > 0) {
          visibleLines = lineCount * Math.min(1, preview.clientHeight / preview.scrollHeight);
        }
      } else if (view.scrollDOM.clientHeight > 0) {
        const topBlock = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
        const bottomBlock = view.lineBlockAtHeight(view.scrollDOM.scrollTop + view.scrollDOM.clientHeight);
        const firstLine = document.lineAt(topBlock.from).number - 1;
        const lastLine = document.lineAt(bottomBlock.from).number - 1;
        visibleLines = Math.max(1, lastLine - firstLine + 1);
      }

      const viewportHeight = Math.max(6, Math.min(height, visibleLines / lineCount * height));
      const viewportTop = Math.min(height - viewportHeight, logicalTop / lineCount * height);
      context.globalAlpha = 0.16;
      context.fillStyle = headingColor;
      context.fillRect(0, viewportTop, width, viewportHeight);
      context.globalAlpha = 1;
      context.strokeStyle = headingColor;
      context.lineWidth = 1;
      context.strokeRect(0.5, viewportTop, width - 1, Math.max(1, viewportHeight));

      const cursorLine = document.lineAt(view.state.selection.main.head).number - 1;
      const cursorY = (cursorLine + 0.5) / lineCount * height;
      context.fillStyle = cursorColor;
      context.fillRect(0, cursorY - 1, width, 2);
    };

    const schedulePaint = () => {
      if (destroyed) return;
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(paint);
    };

    const scrollDOM = view.scrollDOM;
    scrollDOM.addEventListener('scroll', schedulePaint, { passive: true });
    view.dom.addEventListener('keyup', schedulePaint);
    view.dom.addEventListener('mouseup', schedulePaint);
    const unsubscribe = coordinator.subscribe(schedulePaint);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedulePaint);
    observer?.observe(wrapper);
    if (previewRef.current) observer?.observe(previewRef.current);
    schedulePaint();

    return () => {
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      scrollDOM.removeEventListener('scroll', schedulePaint);
      view.dom.removeEventListener('keyup', schedulePaint);
      view.dom.removeEventListener('mouseup', schedulePaint);
      unsubscribe();
      observer?.disconnect();
    };
  }, [content, coordinator, mode, previewRef, view]);

  const scrollToPointer = (clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !view) return;
    const bounds = canvas.getBoundingClientRect();
    const ratio = bounds.height > 0 ? (clientY - bounds.top) / bounds.height : 0;
    coordinator.scrollTo(positionAtMinimapRatio(ratio, view.state.doc.lines));
  };

  return (
    <div ref={wrapperRef} className="editor-minimap">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Мінімапа документа"
        onPointerDown={event => {
          event.preventDefault();
          draggingRef.current = true;
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* unsupported */ }
          scrollToPointer(event.clientY);
        }}
        onPointerMove={event => {
          if (draggingRef.current) scrollToPointer(event.clientY);
        }}
        onPointerUp={event => {
          draggingRef.current = false;
          try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
        }}
        onPointerCancel={() => { draggingRef.current = false; }}
      />
    </div>
  );
}
