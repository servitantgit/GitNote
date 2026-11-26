import type { Text } from '@codemirror/state';

export interface FenceState {
  marker: '`' | '~';
  length: number;
}

export function parseFenceOpening(line: string): FenceState | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  if (match[1][0] === '`' && match[2].includes('`')) return null;
  return { marker: match[1][0] as FenceState['marker'], length: match[1].length };
}

export function isFenceClosing(line: string, fence: FenceState): boolean {
  const escapedMarker = fence.marker === '`' ? '`' : '~';
  const pattern = new RegExp(`^ {0,3}${escapedMarker}{${fence.length},}[ \\t]*$`);
  return pattern.test(line);
}

/** Finds whether a document line is inside a fenced code block. */
export function getFenceStateBeforeLine(doc: Text, lineNumber: number): FenceState | null {
  let fence: FenceState | null = null;
  const lastLine = Math.min(Math.max(1, lineNumber - 1), doc.lines);

  for (let number = 1; number <= lastLine; number += 1) {
    const line = doc.line(number).text;
    if (fence) {
      if (isFenceClosing(line, fence)) fence = null;
      continue;
    }
    fence = parseFenceOpening(line);
  }

  return fence;
}
