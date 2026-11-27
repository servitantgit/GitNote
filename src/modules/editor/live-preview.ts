import { syntaxTree } from '@codemirror/language';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

interface MarkRange { from: number; to: number; className: string }
interface HiddenRange { from: number; to: number }
interface CodeRange { from: number; to: number; kind: 'fenced' | 'inline' }

function buildDecorations(view: EditorView): DecorationSet {
  const marks: MarkRange[] = [];
  const hidden: HiddenRange[] = [];
  const codeRanges: CodeRange[] = [];
  const addMark = (from: number, to: number, className: string) => {
    if (to > from) marks.push({ from, to, className });
  };
  const hide = (from: number, to: number) => {
    if (to > from) hidden.push({ from, to });
  };

  // Lezer owns code boundaries. Inline formatting rules never inspect code nodes.
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        if (node.name === 'FencedCode') codeRanges.push({ from: node.from, to: node.to, kind: 'fenced' });
        if (node.name === 'InlineCode') codeRanges.push({ from: node.from, to: node.to, kind: 'inline' });
        if (node.name === 'CodeMark' || node.name === 'CodeInfo') hide(node.from, node.to);
        if (node.name === 'CodeText') {
          const parentRange = codeRanges.find(range => node.from >= range.from && node.to <= range.to);
          addMark(node.from, node.to, parentRange?.kind === 'inline' ? 'gn-inline-code' : 'gn-code-block');
        }
      },
    });
  }

  for (const { from, to } of view.visibleRanges) {
    const firstLine = view.state.doc.lineAt(from);
    let lineStart = firstLine.from;

    while (lineStart <= to) {
      const lineEnd = view.state.doc.lineAt(lineStart).to;
      const line = view.state.doc.sliceString(lineStart, lineEnd);
      const insideFencedCode = codeRanges.some(range =>
        range.kind === 'fenced' && lineStart >= range.from && lineStart < range.to,
      );

      if (!insideFencedCode) {
        const inlineCodeRanges = codeRanges.filter(range => range.kind === 'inline');
        const overlapsCode = (start: number, end: number) =>
          inlineCodeRanges.some(range => start < range.to && end > range.from);

        const heading = /^(#{1,6})(\s+)(.+)$/.exec(line);
        if (heading) {
          const markerEnd = lineStart + heading[1].length + heading[2].length;
          hide(lineStart, markerEnd);
          addMark(markerEnd, lineEnd, `gn-heading gn-heading-${heading[1].length}`);
        }

        const quote = /^(\s*&gt;|\s*>)(\s?)/.exec(line);
        if (quote) {
          const markerEnd = lineStart + quote[0].length;
          hide(lineStart, markerEnd);
          addMark(markerEnd, lineEnd, 'gn-blockquote');
        }

        const listMarker = /^(\s*)([-*+]|\d+\.)(\s+)/.exec(line);
        if (listMarker) {
          const markerStart = lineStart + listMarker[1].length;
          const markerEnd = lineStart + listMarker[0].length;
          hide(markerStart, markerEnd);
          addMark(markerEnd, lineEnd, 'gn-list-line');
        }

        const patterns: Array<{ regex: RegExp; className: string; delimiterLength: (match: RegExpExecArray) => number; suffixLength: (match: RegExpExecArray) => number }> = [
          { regex: /(\*\*|__)(.+?)\1/g, className: 'gn-strong', delimiterLength: match => match[1].length, suffixLength: match => match[1].length },
          { regex: /~~(.+?)~~/g, className: 'gn-strike', delimiterLength: () => 2, suffixLength: () => 2 },
          { regex: /(?<!\*)\*(?!\*)([^*\n]+)\*(?!\*)|(?<!_)_(?!_)([^_\n]+)_(?!_)/g, className: 'gn-emphasis', delimiterLength: () => 1, suffixLength: () => 1 },
        ];

        for (const pattern of patterns) {
          pattern.regex.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = pattern.regex.exec(line)) !== null) {
            const start = lineStart + match.index;
            const end = start + match[0].length;
            if (overlapsCode(start, end)) continue;
            const prefix = pattern.delimiterLength(match);
            const suffix = pattern.suffixLength(match);
            const innerStart = start + prefix;
            const innerEnd = end - suffix;
            hide(start, innerStart);
            hide(innerEnd, end);
            addMark(innerStart, innerEnd, pattern.className);
          }
        }

        const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
        let link: RegExpExecArray | null;
        while ((link = linkPattern.exec(line)) !== null) {
          const start = lineStart + link.index;
          const end = start + link[0].length;
          if (overlapsCode(start, end)) continue;
          const labelStart = start + 1;
          const labelEnd = labelStart + link[1].length;
          hide(start, labelStart);
          hide(labelEnd, end);
          addMark(labelStart, labelEnd, 'gn-link');
        }
      }

      if (lineEnd >= to) break;
      lineStart = lineEnd + 1;
    }
  }

  const ranges = [
    ...marks.map(range => Decoration.mark({ class: range.className }).range(range.from, range.to)),
    ...hidden.map(range => Decoration.replace({}).range(range.from, range.to)),
  ].sort((a, b) => a.from - b.from || a.to - b.to);

  return Decoration.set(ranges, true);
}

export const livePreviewExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: plugin => plugin.decorations },
);
