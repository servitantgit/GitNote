import { describe, expect, it } from 'vitest';
import { findSimilarTextMatches } from './search-query';

describe('findSimilarTextMatches', () => {
  it('matches token prefixes and a one-character typo across separate words', () => {
    const result = findSimilarTextMatches(
      'Planning notes contain the unique phrase for this test.',
      'plan uniqe phrase',
    );

    expect(result).not.toBeNull();
    expect(result?.snippet).toContain('Planning');
    expect(result?.count).toBe(1);
    expect(result?.ranges).toEqual([
      { from: 0, to: 8 },
      { from: 27, to: 33 },
      { from: 34, to: 40 },
    ]);
  });

  it('requires every query token to match a distinct document token', () => {
    expect(findSimilarTextMatches('A unique phrase in the note.', 'unique missing')).toBeNull();
  });

  it('does not apply edit-distance matching to short tokens', () => {
    expect(findSimilarTextMatches('cat dog bird', 'bat dog')).toBeNull();
  });

  it('supports prefixes in non-Latin text', () => {
    const result = findSimilarTextMatches('Нотатка про робочий простір', 'нотат робоч');

    expect(result).not.toBeNull();
    expect(result?.snippet).toContain('Нотатка');
  });
});
