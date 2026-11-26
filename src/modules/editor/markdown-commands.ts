export interface TextRange { from: number; to: number }
export interface TextEdit { text: string; selection: TextRange }

export function wrapSelection(text: string, range: TextRange, before: string, after: string, placeholder = 'текст'): TextEdit {
  const from = Math.max(0, Math.min(range.from, text.length));
  const to = Math.max(from, Math.min(range.to, text.length));
  const inner = text.slice(from, to) || placeholder;
  return {
    text: text.slice(0, from) + before + inner + after + text.slice(to),
    selection: { from: from + before.length, to: from + before.length + inner.length },
  };
}

export function prefixLines(text: string, range: TextRange, prefix: string): TextEdit {
  const from = Math.max(0, Math.min(range.from, text.length));
  const to = Math.max(from, Math.min(range.to, text.length));
  const start = text.lastIndexOf('\n', from - 1) + 1;
  const endProbe = to > from && text[to - 1] === '\n' ? to - 1 : to;
  const endOfLine = text.indexOf('\n', endProbe);
  const end = endOfLine === -1 ? text.length : endOfLine;
  const updated = text.slice(start, end).split('\n').map(line => prefix + line).join('\n');
  return {
    text: text.slice(0, start) + updated + text.slice(end),
    selection: { from: start, to: start + updated.length },
  };
}

export function toggleHeading(text: string, range: TextRange, level: number): TextEdit {
  const from = Math.max(0, Math.min(range.from, text.length));
  const start = text.lastIndexOf('\n', from - 1) + 1;
  const endOfLine = text.indexOf('\n', from);
  const end = endOfLine === -1 ? text.length : endOfLine;
  const line = text.slice(start, end);
  const marker = '#'.repeat(Math.max(1, Math.min(6, level))) + ' ';
  const existing = /^(#{1,6})\s/.exec(line);
  const updated = existing
    ? (existing[0] === marker ? line.slice(existing[0].length) : marker + line.slice(existing[0].length))
    : marker + line;
  return {
    text: text.slice(0, start) + updated + text.slice(end),
    selection: { from: start, to: start + updated.length },
  };
}
