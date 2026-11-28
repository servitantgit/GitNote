export interface SearchMatchRange {
  from: number;
  to: number;
}

interface TextMatch {
  count: number;
  snippet: string;
  ranges: SearchMatchRange[];
}

interface SearchToken {
  value: string;
  index: number;
  end: number;
}

function tokenize(value: string): SearchToken[] {
  return [...value.toLocaleLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map(match => ({
    value: match[0],
    index: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function boundedEditDistance(left: string, right: string, limit: number): number | null {
  const a = Array.from(left);
  const b = Array.from(right);
  if (Math.abs(a.length - b.length) > limit) return null;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = new Array<number>(b.length + 1);
    current[0] = row;
    let rowMinimum = row;

    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
      rowMinimum = Math.min(rowMinimum, current[column]);
    }

    if (rowMinimum > limit) return null;
    previous = current;
  }

  return previous[b.length] <= limit ? previous[b.length] : null;
}

function tokenDistance(query: string, word: string): number | null {
  if (word.startsWith(query)) return 0;
  if (query.length < 4) return null;
  return boundedEditDistance(query, word, query.length >= 8 ? 2 : 1);
}

/**
 * Fallback matching used only when the workspace has no exact substring
 * results. Every query token must match a distinct document token by prefix
 * or a small edit distance, preventing unrelated partial hits.
 */
export function findSimilarTextMatches(text: string, query: string): TextMatch | null {
  const queryTokens = tokenize(query);
  if (!queryTokens.length || queryTokens.some(token => token.value.length < 3)) return null;

  const documentTokens = tokenize(text);
  const used = new Set<number>();
  const matches: SearchToken[] = [];

  for (const queryToken of queryTokens) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < documentTokens.length; index += 1) {
      if (used.has(index)) continue;
      const distance = tokenDistance(queryToken.value, documentTokens[index].value);
      if (distance === null) continue;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
        if (distance === 0) break;
      }
    }

    if (bestIndex < 0) return null;
    used.add(bestIndex);
    matches.push(documentTokens[bestIndex]);
  }

  matches.sort((a, b) => a.index - b.index);
  const first = matches[0];
  const start = Math.max(0, first.index - 72);
  const end = Math.min(text.length, first.end + 96);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const snippet = prefix + text.slice(start, end).replace(/\s+/g, ' ').trim() + suffix;
  return { count: 1, snippet, ranges: matches.map(match => ({ from: match.index, to: match.end })) };
}
