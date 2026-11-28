/**
 * TeX math in Markdown text, as pandoc reads it (`tex_math_dollars`): `$…$` inline, `$$…$$` display.
 *
 * - `$$` opens display math, closed by the next `$$`; it may span lines (not a blank one: the caller gives one paragraph)
 * - `$` opens inline math when a non-space follows it; the next `$` closes it when a non-space is before it and no digit
 *   after it, else this `$` is a dollar sign (`costs $5 and $10` has no math)
 * - `\$` is a dollar sign, and a backslash escape is skipped inside math too (`$a\$b$`)
 * - nothing inside a code span (`` `$x$` ``) is math, and a `$` whose closing `$` would be past the start of a code
 *   span is a dollar sign (the code span wins, as on GitHub)
 * - `\(…\)` and `\[…\]` are not math: in Markdown they are escaped brackets
 */
import type { TexMath } from '../docx/types'

export type { TexMath }

/** a formula in a text: the TeX between the delimiters as written (spaces and line breaks of a `$$` block included) */
export interface MathSpan extends TexMath {
  /** where the opening delimiter starts and the closing one ends */
  start: number
  end: number
}

const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v'
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9'

/** where a run of `n` backticks closes a code span opened at `from`, or -1 */
function codeEnd(s: string, from: number, n: number): number {
  for (let i = s.indexOf('`', from); i >= 0; i = s.indexOf('`', i)) {
    let j = i
    while (s[j] === '`') j++
    if (j - i === n) return j
    i = j
  }
  return -1
}

/** where a code span starting at `i` (a run of backticks) ends, or -1 when the run is only backticks */
function codeSpan(s: string, i: number): { run: number; end: number } {
  let j = i
  while (s[j] === '`') j++
  return { run: j, end: codeEnd(s, j, j - i) }
}

/**
 * Where the formula opened at `from` closes: the index of its closing delimiter (`$`, or `$$` when `display`), or -1.
 * Backslash escapes are skipped; a code span before the delimiter means there is no formula (the code wins).
 */
function closer(s: string, from: number, display: boolean): number {
  for (let j = from; j < s.length; ) {
    const c = s[j]
    if (c === '\\') j += 2
    else if (c === '`') {
      const code = codeSpan(s, j)
      if (code.end >= 0) return -1
      j = code.run
    } else if (c === '$' && (!display || s[j + 1] === '$')) return j
    else j++
  }
  return -1
}

/** the math spans of a text (a paragraph, a heading, a table cell…), in order */
export function findMath(s: string): MathSpan[] {
  const out: MathSpan[] = []
  if (!s.includes('$')) return out
  const n = s.length
  for (let i = 0; i < n; ) {
    const c = s[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '`') {
      const code = codeSpan(s, i)
      i = code.end < 0 ? code.run : code.end
      continue
    }
    if (c !== '$') {
      i++
      continue
    }
    if (s[i + 1] === '$') {
      // display: up to the next $$, not empty
      const e = closer(s, i + 2, true)
      if (e >= 0 && s.slice(i + 2, e).trim()) out.push({ start: i, end: e + 2, tex: s.slice(i + 2, e), delim: '$$' })
      // (an empty one is text, both of its $$)
      i = e >= 0 ? e + 2 : i + 2
      continue
    }
    if (i + 1 < n && !isSpace(s[i + 1])) {
      // inline: the first $ after it closes it, or this one is a dollar sign
      const j = closer(s, i + 1, false)
      if (j >= 0 && !isSpace(s[j - 1]) && !isDigit(s[j + 1])) {
        out.push({ start: i, end: j + 1, tex: s.slice(i + 1, j), delim: '$' })
        i = j + 1
        continue
      }
    }
    i++
  }
  return out
}

/**
 * The Markdown of a formula: its TeX between its delimiters, as it was written. TeX that `$…$` cannot hold (spaces at
 * its ends, a `$` of its own, from a paste) gets `$$`.
 */
export function mathSource(m: TexMath): string {
  if (m.delim === '$' && (!m.tex || /^\s|\s$/.test(m.tex) || /(^|[^\\])(\\\\)*\$/.test(m.tex) || /(^|[^\\])(\\\\)*\\$/.test(m.tex))) return `$$${m.tex}$$`
  return m.delim + m.tex + m.delim
}

/** `$$` lines that open a display formula the lines after them close: the block's lines are one paragraph, whatever they start with */
export function displayEnd(lines: string[], i: number): number {
  const line = lines[i]
  const at = line.indexOf('$$')
  if (at < 0 || !/^ {0,3}\$\$/.test(line) || line.indexOf('$$', at + 2) >= 0) return -1
  for (let j = i + 1; j < lines.length && j < i + 1000; j++) {
    if (!lines[j].trim()) return -1
    if (lines[j].includes('$$')) return j
  }
  return -1
}
