import { describe, expect, it } from 'vitest';
import { createSearchGrams } from './search-index';

describe('createSearchGrams', () => {
  it('creates unique case-insensitive trigrams', () => {
    const grams = createSearchGrams('Hello hello');
    expect(grams).toEqual(expect.arrayContaining(['hel', 'ell', 'llo', 'lo ']));
    expect(new Set(grams).size).toBe(grams.length);
  });

  it('returns no candidates for queries shorter than three characters', () => {
    expect(createSearchGrams('ab')).toEqual([]);
  });

  it('handles an empty string', () => {
    expect(createSearchGrams('')).toEqual([]);
  });
});
