import { describe, expect, it } from 'vitest';
import { createSearchGrams } from './search-index';

describe('createSearchGrams', () => {
  it('creates unique case-insensitive bigrams and trigrams', () => {
    const grams = createSearchGrams('Hello hello');
    expect(grams).toEqual(expect.arrayContaining(['hel', 'ell', 'llo', 'lo ']));
    expect(new Set(grams).size).toBe(grams.length);
  });

  it('indexes two-character queries with bigrams and leaves one-character queries unindexed', () => {
    expect(createSearchGrams('ab')).toEqual(['ab']);
    expect(createSearchGrams('a')).toEqual([]);
  });

  it('handles an empty string', () => {
    expect(createSearchGrams('')).toEqual([]);
  });
});
