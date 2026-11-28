/** Structured references: `Table1[Price]`, `Table1[[#Headers],[Price]:[Total]]`, `Table1[@Price]`, `[@Price]`. */
import type { TableInfo } from './types'

export interface StructuredRef {
  /** the table named; none when the reference is of the table the formula is in */
  table?: string
  /** the rows asked for: `#All`, `#Data`, `#Headers`, `#Totals` (none: the data) */
  items: ('all' | 'data' | 'headers' | 'totals')[]
  /** `@` / `#This Row`: the row of the formula */
  thisRow: boolean
  /** the first and last column named (none: all of them) */
  col0?: string
  col1?: string
}

const ITEMS: Record<string, StructuredRef['items'][number] | 'this'> = {
  '#all': 'all',
  '#data': 'data',
  '#headers': 'headers',
  '#totals': 'totals',
  '#this row': 'this',
}

/** `'` escapes the next character of a column name */
const unescape = (s: string) => s.replace(/'([\s\S])/g, '$1')

/** the parts of `[a],[b]:[c]`: each bracketed text, and whether a `:` came before it */
function parts(inner: string): { text: string; range: boolean }[] | null {
  const out: { text: string; range: boolean }[] = []
  let i = 0
  let range = false
  while (i < inner.length) {
    const ch = inner[i]
    if (ch === ' ' || ch === ',') {
      i++
      continue
    }
    if (ch === ':') {
      range = true
      i++
      continue
    }
    if (ch !== '[') return null
    let j = i + 1
    for (; j < inner.length && inner[j] !== ']'; j++) if (inner[j] === "'") j++
    if (j >= inner.length) return null
    out.push({ text: inner.slice(i + 1, j), range })
    range = false
    i = j + 1
  }
  return out
}

/** Reads the text of a structured reference (a name token holding brackets); null when it is not one. */
export function parseStructured(text: string): StructuredRef | null {
  const open = text.indexOf('[')
  if (open < 0 || text[text.length - 1] !== ']') return null
  const ref: StructuredRef = { items: [], thisRow: false }
  if (open > 0) ref.table = text.slice(0, open)
  let inner = text.slice(open + 1, -1).trim()
  if (inner.startsWith('@')) {
    ref.thisRow = true
    inner = inner.slice(1).trim()
  }
  if (inner === '') return ref
  // one item or column without brackets of its own: Table[Price], Table[#All], Table[@Price]
  const list = inner.includes('[') ? parts(inner) : [{ text: inner, range: false }]
  if (!list) return null
  for (const p of list) {
    const key = p.text.trim().toLowerCase()
    if (key.startsWith('#')) {
      const item = ITEMS[key]
      if (!item) return null
      if (item === 'this') ref.thisRow = true
      else ref.items.push(item)
    } else if (p.range && ref.col0 !== undefined && ref.col1 === undefined) ref.col1 = unescape(p.text)
    else if (ref.col0 === undefined) ref.col0 = unescape(p.text)
    else return null
  }
  return ref
}

/**
 * The cells a structured reference names in its table, for a formula in row `r`: null when the table has no such
 * rows or columns (#REF!), 'row' when `@` is used outside the rows of the table (#VALUE!).
 */
export function resolveStructured(ref: StructuredRef, tb: TableInfo, r: number): { r0: number; c0: number; r1: number; c1: number } | 'row' | null {
  const dataR0 = tb.r0 + tb.headers
  const dataR1 = tb.r1 - tb.totals
  let c0 = tb.c0
  let c1 = tb.c1
  if (ref.col0 !== undefined) {
    const find = (name: string) => tb.columns.findIndex((c) => c.toLowerCase() === name.toLowerCase())
    const a = find(ref.col0)
    const b = ref.col1 !== undefined ? find(ref.col1) : a
    if (a < 0 || b < 0) return null
    c0 = tb.c0 + Math.min(a, b)
    c1 = tb.c0 + Math.max(a, b)
  }
  if (ref.thisRow) {
    if (r < dataR0 || r > dataR1) return 'row'
    return { r0: r, c0, r1: r, c1 }
  }
  let r0 = dataR0
  let r1 = dataR1
  if (ref.items.length) {
    r0 = Infinity
    r1 = -1
    for (const it of ref.items) {
      let a: number
      let b: number
      if (it === 'all') [a, b] = [tb.r0, tb.r1]
      else if (it === 'data') [a, b] = [dataR0, dataR1]
      else if (it === 'headers') {
        if (!tb.headers) return null
        ;[a, b] = [tb.r0, dataR0 - 1]
      } else {
        if (!tb.totals) return null
        ;[a, b] = [dataR1 + 1, tb.r1]
      }
      r0 = Math.min(r0, a)
      r1 = Math.max(r1, b)
    }
  }
  if (r1 < r0) return null
  return { r0, c0, r1, c1 }
}
