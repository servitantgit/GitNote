/**
 * Find in a document: text and query are compared in NFC, lower case, so "Việt" typed composed matches "Việt" pasted
 * decomposed (macOS file names, web text). Positions are those of the original text.
 */

/** a base character with the combining marks (and Hangul vowel / final jamo) that follow it: the unit canonical composition works on */
const CLUSTER = /[^\p{M}\u1160-\u11ff\ud7b0-\ud7ff][\p{M}\u1160-\u11ff\ud7b0-\ud7ff]*|[\p{M}\u1160-\u11ff\ud7b0-\ud7ff]+/gu

/** `text` in NFC, lower case; `at[i]`, `end[i]`: where the original text of character i starts / ends */
function fold(text: string): { s: string; at: number[]; end: number[] } {
  let s = ''
  const at: number[] = []
  const end: number[] = []
  for (const m of text.matchAll(CLUSTER)) {
    const f = m[0].normalize('NFC').toLowerCase()
    for (let i = 0; i < f.length; i++) {
      at.push(m.index)
      end.push(m.index + m[0].length)
    }
    s += f
  }
  return { s, at, end }
}

/** [start, end) of each non-overlapping match of `query` in `text`, at most `max` */
export function findAll(text: string, query: string, max = 5000): [number, number][] {
  const q = fold(query).s
  if (!q) return []
  const t = fold(text)
  const out: [number, number][] = []
  for (let i = t.s.indexOf(q); i >= 0 && out.length < max; i = t.s.indexOf(q, i + q.length)) out.push([t.at[i], t.end[i + q.length - 1]])
  return out
}
