import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

interface MarkRange { from: number; to: number; className: string }
interface HiddenRange { from: number; to: number }

function buildDecorations(view: EditorView): DecorationSet {
  const marks: MarkRange[] = [];
  const hidden: HiddenRange[] = [];
  const addMark = (from: number, to: number, className: string) => {
    if (to > from) marks.push({ from, to, className });
  };
  const hide = (from: number, to: number) => {
    if (to > from) hidden.push({ from, to });
  };

  for (const { from, to } of view.visibleRanges) {
    let lineStart = view.state.doc.lineAt(from).from;
    while (lineStart <= to) {
      const lineEnd = view.state.doc.lineAt(lineStart).to;
      const line = view.state.doc.sliceString(lineStart, lineEnd);

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
        { regex: /(`+)([^`\n]+)\1/g, className: 'gn-inline-code', delimiterLength: match => match[1].length, suffixLength: match => match[1].length },
      ];

      for (const pattern of patterns) {
        pattern.regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.regex.exec(line)) !== null) {
          const start = lineStart + match.index;
          const prefix = pattern.delimiterLength(match);
          const suffix = pattern.suffixLength(match);
          const innerStart = start + prefix;
          const innerEnd = lineStart + match.index + match[0].length - suffix;
          hide(start, innerStart);
          hide(innerEnd, innerEnd + suffix);
          addMark(innerStart, innerEnd, pattern.className);
        }
      }

      const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
      let link: RegExpExecArray | null;
      while ((link = linkPattern.exec(line)) !== null) {
        const start = lineStart + link.index;
        const labelStart = start + 1;
        const labelEnd = labelStart + link[1].length;
        hide(start, labelStart);
        hide(labelEnd, lineStart + link.index + link[0].length);
        addMark(labelStart, labelEnd, 'gn-link');
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
