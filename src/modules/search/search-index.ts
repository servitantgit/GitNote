/**
 * Persistent substring and fuzzy-search index helpers.
 *
 * Each document stores its extracted text and unique lower-case bigrams and
 * trigrams in IndexedDB. Exact substring queries use the rarest gram; fuzzy
 * fallback queries use shared bigrams to find documents worth verifying.
 */
export function createSearchGrams(text: string): string[] {
  const normalized = text.toLocaleLowerCase();
  if (normalized.length < 2) return [];
  const grams = new Set<string>();
  for (let index = 0; index <= normalized.length - 2; index += 1) {
    grams.add(normalized.slice(index, index + 2));
  }
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    grams.add(normalized.slice(index, index + 3));
  }
  return [...grams];
}

export function hasCurrentSearchGrams(stored: string[] | undefined, text: string): boolean {
  if (!stored) return false;
  const expected = createSearchGrams(text);
  return stored.length === expected.length && expected.every((gram, index) => stored[index] === gram);
}
