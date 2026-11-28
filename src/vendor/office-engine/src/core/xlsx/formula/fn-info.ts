/** Information about cells, references and sheets; the addresses and formulas of cells as text. */
import { parseDateText } from './dates'
import { A, S, type Ev, type FnDef } from './fn'
import { colName, quoteSheet, sameSheet } from './refs'
import { stripFunctionPrefixes } from './transform'
import { ERR, FormulaError, MAX_COL, MAX_ROW, type Value } from './types'
import { ArrayV, bool, LambdaV, num, RangeV, str, UnionV, type Val } from './values'

/** the one cell a reference argument names (its first, as Excel takes it) */
function cellOf(v: Val): RangeV {
  if (v instanceof UnionV && v.areas.length) return v.areas[0]
  if (!(v instanceof RangeV)) throw ERR.VALUE
  return v
}

function sheetNumber(ev: Ev, name: string | undefined): number {
  const names = ev.provider.sheetNames?.()
  if (!names) return 1
  const i = names.findIndex((n) => sameSheet(n, name ?? ev.sheet ?? names[0]))
  if (i < 0) throw ERR.NA
  return i + 1
}

/** quotes and what stands between brackets are not the format's codes */
const bare = (fmt: string) => fmt.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '')

/** the code CELL("format") gives a number format: G, F2, ",0", C2, P0, S2, D1… ("-" with colored negatives, "()" with parentheses) */
function formatCode(fmt: string | undefined): string {
  if (!fmt || /^general$/i.test(fmt)) return 'G'
  const first = fmt.split(';')[0]
  const code = bare(first)
  const lc = code.toLowerCase()
  if (/[ymdhs]/.test(lc) && !/[0#?]/.test(lc)) {
    const ampm = /am\/pm|a\/p/.test(lc)
    if (/h/.test(lc) && !/[yd]/.test(lc)) return /s/.test(lc) ? (ampm ? 'D6' : 'D8') : ampm ? 'D7' : 'D9'
    if (/mmm/.test(lc)) return /d/.test(lc) ? (/y/.test(lc) ? 'D1' : 'D2') : 'D3'
    return /y/.test(lc) ? 'D4' : 'D5'
  }
  const decimals = (/\.([0#?]+)/.exec(code)?.[1] ?? '').length
  let out: string
  if (code.includes('%')) out = `P${decimals}`
  else if (/e[+-]/i.test(code)) out = `S${decimals}`
  else if (/[$€£¥]/.test(first) || /\[\$/.test(first)) out = `C${decimals}`
  else if (/[0#],[0#]/.test(code)) out = `,${decimals}`
  else if (/[0#?]/.test(code)) out = `F${decimals}`
  else return 'G'
  if (/;\s*\[(red|color\s*\d+|blue|green|magenta|cyan|yellow)\]/i.test(fmt)) out += '-'
  if (first.includes('(')) out += '()'
  return out
}

function cellInfo(a: Val[], ev: Ev): Value {
  const type = str(ev.scalar(a[0])).toLowerCase()
  const ref = a.length > 1 ? cellOf(a[1]) : new RangeV(ev.sheet, ev.r, ev.c, ev.r, ev.c)
  const { sheet, r0: r, c0: c } = ref
  const info = () => ev.provider.cellInfo?.(sheet, r, c)
  switch (type) {
    case 'address':
      return (sheet !== undefined && !sameSheet(sheet, ev.sheet) ? `${quoteSheet(sheet)}!` : '') + `$${colName(c)}$${r + 1}`
    case 'col':
      return c + 1
    case 'row':
      return r + 1
    case 'contents': {
      const v = ev.cell(sheet, r, c)
      return v === null ? 0 : v
    }
    case 'type': {
      const v = ev.cell(sheet, r, c)
      return v === null ? 'b' : typeof v === 'string' ? 'l' : 'v'
    }
    case 'filename':
      return info()?.filename ?? ''
    case 'format':
      return formatCode(info()?.format)
    case 'color':
      return /;\s*\[(red|color\s*\d+|blue|green|magenta|cyan|yellow)\]/i.test(info()?.format ?? '') ? 1 : 0
    case 'parentheses':
      return (info()?.format ?? '').split(';')[0].includes('(') ? 1 : 0
    case 'prefix': {
      if (typeof ev.cell(sheet, r, c) !== 'string') return ''
      const align = info()?.align
      return align === 'right' ? '"' : align === 'center' ? '^' : align === 'fill' ? '\\' : "'"
    }
    case 'protect':
      return info()?.locked === false ? 0 : 1
    case 'width':
      return Math.round(info()?.width ?? 8.43)
  }
  throw ERR.VALUE
}

function address(a: Value[]): string {
  const row = Math.trunc(num(a[0]))
  const col = Math.trunc(num(a[1]))
  const abs = a.length > 2 && a[2] !== null ? Math.trunc(num(a[2])) : 1
  const a1 = a.length > 3 && a[3] !== null ? bool(a[3]) : true
  if (abs < 1 || abs > 4) throw ERR.VALUE
  const absRow = abs === 1 || abs === 2
  const absCol = abs === 1 || abs === 3
  // (a relative R1C1 address is an offset: any number is one)
  if (((a1 || absRow) && (row < 1 || row > MAX_ROW + 1)) || ((a1 || absCol) && (col < 1 || col > MAX_COL + 1))) throw ERR.VALUE
  const cell = a1
    ? `${absCol ? '$' : ''}${colName(col - 1)}${absRow ? '$' : ''}${row}`
    : `R${absRow ? row : `[${row}]`}C${absCol ? col : `[${col}]`}`
  if (a.length > 4 && a[4] !== null) {
    const sheet = str(a[4])
    return `${sheet === '' ? '' : quoteSheet(sheet)}!${cell}`
  }
  return cell
}

/** whether a value is a date: text that reads as one, or a number in a cell formatted as a date */
function isDate(v: Val, ev: Ev): boolean {
  if (v instanceof RangeV) {
    const x = ev.cell(v.sheet, v.r0, v.c0)
    if (typeof x === 'number') {
      const fmt = bare(ev.provider.cellInfo?.(v.sheet, v.r0, v.c0)?.format ?? '').toLowerCase()
      return /[ymd]/.test(fmt) && !/[0#?]/.test(fmt)
    }
    return typeof x === 'string' && dateText(x)
  }
  const x = ev.scalar(v)
  return typeof x === 'string' && dateText(x)
}

/** text holding a day (not a time alone, not a plain number) */
const dateText = (s: string) => /[-/]|[a-z]{3}/i.test(s) && parseDateText(s.trim()) !== null && !/^\d{1,2}:\d{2}/.test(s.trim())

const EMAIL = /^[^\s@]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i
const URL_RE = /^(?:(?:https?|ftp):\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i

/** GETPIVOTDATA(data_field, pivot_table, [field, item]…): the value a pivot table shows for the items given */
function pivotData(a: Val[], ev: Ev): Value {
  const want = str(ev.scalar(a[0])).trim().toLowerCase()
  const at = cellOf(a[1])
  const pt = ev.provider.pivot?.(at.sheet, at.r0, at.c0)
  if (!pt || a.length % 2) throw ERR.REF
  const data = pt.dataFields.findIndex((f) => f.name.trim().toLowerCase() === want || f.field.trim().toLowerCase() === want)
  if (data < 0) throw ERR.REF
  const asked = new Map<string, Value>()
  for (let i = 2; i < a.length; i += 2) asked.set(str(ev.scalar(a[i])).trim().toLowerCase(), ev.scalar(a[i + 1]))
  const eq = (x: Value, y: Value) => (typeof x === 'string' || typeof y === 'string' ? String(x ?? '').toLowerCase() === String(y ?? '').toLowerCase() : x === y)
  /** the line of an axis that is of exactly the items asked for its fields (its grand total when none is) */
  const find = (fields: string[], lines: typeof pt.rows): number => {
    const named = fields.filter((f) => f !== '').map((f) => f.toLowerCase())
    const used = named.filter((f) => asked.has(f))
    // the fields asked must be the outermost ones: a total of an inner field alone is not shown
    if (used.some((f, i) => f !== named[i])) return -1
    const onAxis = fields.includes('')
    return lines.findIndex((l) => {
      if (onAxis && l.data !== data) return false
      const own = l.items.filter((_, i) => fields[i] !== '')
      if (own.length !== used.length) return false
      return used.every((f, i) => eq(own[i], asked.get(f)!))
    })
  }
  const known = new Set([...pt.rowFields, ...pt.colFields].map((f) => f.toLowerCase()))
  for (const f of asked.keys()) if (!known.has(f)) throw ERR.REF
  // (an axis without lines — no field on it — is its one row or column of values)
  const r = pt.rows.length ? find(pt.rowFields, pt.rows) : 0
  const c = pt.cols.length ? find(pt.colFields, pt.cols) : 0
  if (r < 0 || c < 0) throw ERR.REF
  const v = ev.cell(pt.sheet, pt.r0 + pt.firstDataRow + r, pt.c0 + pt.firstDataCol + c)
  if (v instanceof FormulaError) throw v
  return v === null ? ERR.REF : v
}

export const INFO: Record<string, FnDef> = {
  GETPIVOTDATA: A(2, 254, pivotData),
  CELL: A(1, 2, cellInfo),
  ISFORMULA: A(1, 1, ([v], ev) => {
    const ref = cellOf(v)
    return ev.provider.formula?.(ref.sheet, ref.r0, ref.c0) !== undefined
  }),
  FORMULATEXT: A(1, 1, ([v], ev) => {
    const ref = cellOf(v)
    const f = ev.provider.formula?.(ref.sheet, ref.r0, ref.c0)
    if (f === undefined) throw ERR.NA
    return '=' + stripFunctionPrefixes(f)
  }),
  ISREF: A(1, 1, ([v]) => v instanceof RangeV || v instanceof UnionV),
  TYPE: A(1, 1, ([v], ev) => {
    if (v instanceof LambdaV) return 128
    if (v instanceof UnionV) return 16
    if ((v instanceof RangeV || v instanceof ArrayV) && v.h * v.w > 1) return 64
    const x = ev.scalar(v)
    return x instanceof FormulaError ? 16 : typeof x === 'string' ? 2 : typeof x === 'boolean' ? 4 : 1
  }),
  SHEET: A(0, 1, (a, ev) => {
    if (!a.length || a[0] === null) return sheetNumber(ev, undefined)
    const v = a[0]
    if (v instanceof RangeV) return sheetNumber(ev, v.sheet)
    if (v instanceof UnionV && v.areas.length) return Math.min(...v.areas.map((x) => sheetNumber(ev, x.sheet)))
    const x = ev.scalar(v)
    if (x instanceof FormulaError) throw x
    if (typeof x !== 'string') throw ERR.NA
    return sheetNumber(ev, x)
  }),
  SHEETS: A(0, 1, (a, ev) => {
    if (!a.length || a[0] === null) return ev.provider.sheetNames?.().length ?? 1
    const v = a[0]
    if (v instanceof RangeV) return 1
    if (v instanceof UnionV) return new Set(v.areas.map((x) => (x.sheet ?? '').toLowerCase())).size
    throw ERR.VALUE
  }),
  AREAS: A(1, 1, ([v]) => {
    if (v instanceof UnionV) return v.areas.length
    if (v instanceof RangeV) return 1
    throw v instanceof FormulaError ? v : ERR.VALUE
  }),
  ADDRESS: S(2, 5, address),
  // A1#: the cells the dynamic array formula in A1 fills (the cell alone when it gives one value)
  ANCHORARRAY: A(1, 1, ([v], ev) => {
    if (!(v instanceof RangeV) || v.h !== 1 || v.w !== 1) throw ERR.REF
    // (read first: the formula is computed before its cells are known)
    const x = ev.cell(v.sheet, v.r0, v.c0)
    const end = ev.provider.spill?.(v.sheet, v.r0, v.c0)
    if (!end) {
      if (x instanceof FormulaError) throw x
      if (ev.provider.formula?.(v.sheet, v.r0, v.c0) === undefined) throw ERR.REF
      return v
    }
    return new RangeV(v.sheet, v.r0, v.c0, end.r1, end.c1)
  }),
  // Google Sheets
  ISDATE: A(1, 1, ([v], ev) => isDate(v, ev)),
  ISEMAIL: S(1, 1, ([x]) => typeof x === 'string' && EMAIL.test(x.trim())),
  ISURL: S(1, 1, ([x]) => typeof x === 'string' && URL_RE.test(x.trim())),
}
