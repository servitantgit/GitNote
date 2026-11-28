/**
 * Persistent substring-search index helpers.
 *
 * Each document stores its extracted text and unique lower-case trigrams in
 * IndexedDB. The multi-entry grams index narrows a query to candidate
 * documents; findTextMatches still verifies the complete query, preserving
 * the existing exact, case-insensitive substring semantics.
 */
export function createSearchGrams(text: string): string[] {
  const normalized = text.toLocaleLowerCase();
  if (normalized.length < 3) return [];
  const grams = new Set<string>();
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    grams.add(normalized.slice(index, index + 3));
  }
  return [...grams];
}
