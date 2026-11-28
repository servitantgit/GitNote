import { describe, expect, it } from 'vitest';
import { findTextMatches } from './search-service';

describe('findTextMatches', () => {
  it('finds case-insensitive matches and counts repeated occurrences', () => {
    expect(findTextMatches('First phrase, then PHRASE again.', 'phrase')).toEqual({
      count: 2,
      snippet: 'First phrase, then PHRASE again.',
      ranges: [{ from: 6, to: 12 }, { from: 19, to: 25 }],
    });
  });

  it('returns a useful excerpt around a match in long content', () => {
    const content = 'x'.repeat(100) + 'Needle in the document' + 'y'.repeat(100);
    const result = findTextMatches(content, 'needle');
    expect(result?.snippet).toContain('Needle in the document');
    expect(result?.snippet.startsWith('…')).toBe(true);
    expect(result?.snippet.endsWith('…')).toBe(true);
  });

  it('does not treat an empty query as a match', () => {
    expect(findTextMatches('some text', '   ')).toBeNull();
  });
});
