/**
 * XLSX editing: cell values/formats live in the worker's SheetData; on save each
 * edited sheet is streamed through a rewriter that only touches edited rows.
 */
import { officeHex } from '../color'
import { relOfType, relsPathFor } from '../opc'
import type { DocComment } from '../comments'
import { writeXlsxComments } from './comments'
import {
  clone, el, escAttr, escText, relIdAttrs, getAttr, isNode, kidOf, kidsOf, local, parseRaw, prefixOf, rootEl, serialize, setAttr, setOrdered, textContent,
  type RChild, type RNode,
} from '../raw'
import { decodeEntities, parseXml } from '../xml'
import { BUILTIN_FORMATS, isDateFormat } from './numfmt'
import { readTyped, type TypedNumber } from '../number-input'
import { parseSheetStyles } from './styles'
import type { BookOp, BorderKind, CellInput, ClipCell, ColInfo, FindOptions, FmtPatch, Merge, Range, RowAttrs, SetOptions, SheetOp, SheetProgress, XlsxClip, XlsxEditResult } from './types'
import { expandShared, overflows, restore, setColStyle, setColWidth, setFormula, setMerge, setRowHeight, shiftSheet, snapshot, type Snapshot } from './structure'
import { dropSheetInFormula, FormulaSyntaxError, moveRefsInFormula, parseFormula, renameSheetInFormula, translateFormula, withFunctionPrefixes, type Ast, type MoveOp, type RefAddr } from './formula'
import { loadDelimited, type DelimitedImport } from './import'
import { tsvCell } from './clip'
import { compare } from './formula/values'
import type { Value } from './formula'
import { followParts, followSheetTail, renameInCharts, sheetTail, type PartEdit } from './follow'
import {
  colAt, colName, DEFAULT_STYLES_PART, ownRow, MAX_COL, MAX_ROWS, parseRef, rowSizesOf, SheetData, stylesPartOf, T_BOOL, T_DATE, T_EMPTY, T_ERR, T_NUM, T_SST,
  T_STR, XlsxWorkbook,
} from './workbook'

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

type Entry = [number, unknown, number]
interface CellChange {
  key: number
  prev: Entry | null
  prevF?: string
  next: Entry | null
  nextF?: string
  /**
   * Whether the formula before / after is a dynamic array formula. `nextD` left out: the formula says (one typed is
   * dynamic when it may give several values); a formula copied is what its source is. Both are known once the
   * change was applied: undoing and redoing put back what was.
   */
  prevD?: boolean
  nextD?: boolean
}
interface LayoutState {
  merges?: Merge[]
  colInfo?: ColInfo[]
  rowAttrs?: [number, RowAttrs][]
  frozen?: { rows: number; cols: number }
  gridLines?: boolean
}

/** what the formulas know of the workbook besides its cells: the defined names and the tables */
interface BookState {
  names: XlsxWorkbook['names']
  tables: XlsxWorkbook['tables']
  pivots: XlsxWorkbook['pivots']
}

export interface Change {
  sheet: number
  cells: CellChange[]
  range: Range
  /** cheap layout state (merges, sizes, panes) before/after */
  lay?: { before: LayoutState; after: LayoutState }
  /** whole-sheet snapshots (row/column insert/delete) */
  full?: { before: Snapshot; after: Snapshot }
  /** comments the change moved or took away (inserted / deleted rows and columns): their values before / after */
  cm?: { before: [string, DocComment | null][]; after: [string, DocComment | null][] }
  /** formulas of the other sheets the change rewrote (they read rows / columns that moved): their text before / after */
  others?: { sheet: number; key: number; prev: string; next: string }[]
  /** parts rewritten with it (defined names, tables, drawings, charts following rows / columns that moved) */
  parts?: PartEdit[]
  /** the defined names and the tables as the formulas see them, before and after (they follow the rows / columns too) */
  book?: { before: BookState; after: BookState }
  /**
   * The rows of `range` put in another order (a sort): row `i` of the range took the cells of row `order[i]`. The
   * cells are moved, not kept here; the formulas among them, as their text was before and is after (it follows the
   * move), by cell.
   */
  sort?: { order: number[]; before: [number, string][]; after: [number, string][] }
  /** the format (style index) of cells before and after, by cell key; -1: no cell (the change made one to hold a format) */
  restyle?: { keys: Float64Array; before: Int32Array; after: Int32Array }
}

/** the functions that give a date: a cell without a format shows their result as one */
const DATE_FUNCTIONS = new Set(['TODAY', 'DATE', 'DATEVALUE', 'EDATE', 'EOMONTH', 'WORKDAY'])

/** cells a format of whole columns / rows may make where they cross rows / columns that have a format of their own */
const MAX_CELLS_MADE = 200_000

/** cells an edit may touch at once (each is kept for Undo) */
const MAX_CELLS_AT_ONCE = 2_000_000

/** the cell a copied one is pasted as: its value checked (the cells of a paste may come from anywhere), with format `st` */
function clipEntry(cell: NonNullable<ClipCell>, st: number): Entry | null {
  const [t, v] = cell
  switch (t) {
    case T_NUM:
      return typeof v === 'number' && Number.isFinite(v) ? [T_NUM, v, st] : null
    case T_STR:
    case T_ERR:
    case T_DATE:
      return typeof v === 'string' ? [t, v, st] : null
    case T_BOOL:
      return [T_BOOL, v ? 1 : 0, st]
    default:
      return st ? [T_EMPTY, '', st] : null
  }
}


const FONT_ORDER = ['b', 'i', 'strike', 'condense', 'extend', 'outline', 'shadow', 'u', 'vertAlign', 'sz', 'color', 'name', 'family', 'charset', 'scheme']
const WB_ORDER = [
  'fileVersion', 'fileSharing', 'workbookPr', 'workbookProtection', 'bookViews', 'sheets', 'functionGroups', 'externalReferences',
  'definedNames', 'calcPr', 'oleSize', 'customWorkbookViews', 'pivotCaches', 'smartTagPr', 'smartTagTypes', 'webPublishing',
  'fileRecoveryPr', 'webPublishObjects', 'extLst',
]
const SS_ORDER = ['numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'cellStyles', 'dxfs', 'tableStyles', 'colors', 'extLst']

// ---------------------------------------------------------------- cell storage helpers

function rowOf(d: SheetData, r: number, create: boolean): unknown[] | undefined {
  let row = ownRow(d, r)
  if (!row && create) d.rows[r] = row = []
  return row
}

export function getEntry(d: SheetData, r: number, c: number): Entry | null {
  const row = d.rows[r]
  if (!row) return null
  for (let k = 0; k < row.length; k += 4) if (row[k] === c) return [row[k + 1] as number, row[k + 2], row[k + 3] as number]
  return null
}

function setEntry(d: SheetData, r: number, c: number, e: Entry | null) {
  // the file does not have this row's edit: its page stays in memory (and must be there: a fresh row would lose the rest)
  if (d.pages && !d.pages.has(r)) throw new Error('Row not in memory')
  d.pages?.pin(r)
  const row = rowOf(d, r, !!e)
  if (!row) return
  let k = 0
  for (; k < row.length; k += 4) if ((row[k] as number) >= c) break
  const exists = k < row.length && row[k] === c
  if (!e) {
    if (exists) row.splice(k, 4)
    if (!row.length) d.rows[r] = undefined
    return
  }
  if (exists) {
    row[k + 1] = e[0]
    row[k + 2] = e[1]
    row[k + 3] = e[2]
  } else row.splice(k, 0, c, e[0], e[1], e[2])
  if (r > d.maxRow) d.maxRow = r
  if (c > d.maxCol) d.maxCol = c
}

/**
 * A date typed as 2024-01-15 or 15/01/2024 (day first; month first when only that reads as a date: 1/15/2024), with
 * an optional time: its serial number and the format that shows it as typed. Undefined for what is not a date of
 * the calendar (31/02/2024, 15/15/2024): it stays text, never another date.
 */
function dateInput(t: string, date1904: boolean): { serial: number; fmt: string } | undefined {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t)
  let y: number, mo: number, d: number
  let fmt = 'yyyy-mm-dd'
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t)
    if (!m) return undefined
    ;[d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
    fmt = 'dd/mm/yyyy'
    if (mo > 12 && d <= 12) {
      ;[d, mo] = [mo, d]
      fmt = 'mm/dd/yyyy'
    }
  }
  const [hh, mi, ss] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)]
  if (y < (date1904 ? 1904 : 1900) || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || hh > 23 || mi > 59 || ss > 59) return undefined
  const ms = Date.UTC(y, mo - 1, d, hh, mi, ss)
  // a workbook counting its dates from 1904 holds them 1462 days lower
  const serial = ms / 86400000 + 25569 - (date1904 ? 1462 : 0)
  // (the dates before March 1900 are off by the day Excel adds to February 1900: left as text)
  if (!date1904 && serial < 61) return undefined
  if (m[4] !== undefined) fmt += m[6] !== undefined ? ' hh:mm:ss' : ' hh:mm'
  return { serial, fmt }
}

/** what the cell typed into is formatted as, for reading what is typed */
interface InputContext {
  /** its number format ('' or "General": none) */
  fmt: string
  date1904: boolean
  /** the BCP 47 tag numbers are typed in (undefined: a decimal point) */
  locale?: string
}

const noQuotes = (fmt: string) => fmt.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '')

const ERROR_INPUT = /^#(?:N\/A|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|NULL!)$/i

/**
 * The format that shows an amount as typed ("1,234,567", "$50", "€1,200.50", "50 ₫"): grouped, with the decimals typed
 * (a currency shows cents when cents were typed), the currency where it was. A format code, the same in every locale.
 */
function amountFormat(n: TypedNumber): string {
  const digits = '#,##0' + (n.decimals ? '.' + '0'.repeat(n.currency ? Math.max(2, n.decimals) : n.decimals) : '')
  return !n.currency ? digits : n.after ? `${digits}" ${n.currency}"` : `"${n.currency}"${digits}`
}

/** whether text reads as a formula that reads a cell or calls a function (what makes "+A1+B1" one, and not "-5" or "- item") */
/**
 * A formula as it is entered: with the parentheses it leaves open closed ("=SUM(A1:A3" → "=SUM(A1:A3)", as Excel
 * does). Undefined when it ends where something must follow ("=1+", "=A1&", "=\"open text"): not a formula yet.
 * Anything else the reader does not understand is kept as typed: it may be a formula of a kind it does not know.
 */
function typedFormula(f: string): string | undefined {
  let text = f
  for (let closed = 0; closed <= 64; closed++) {
    try {
      parseFormula(text)
      return text
    } catch (e) {
      if (!(e instanceof FormulaSyntaxError)) return f
      if (e.message === 'unterminated string') return undefined
      // wrong before its end: as typed it is something the reader does not know; with parentheses closed, it was not finished
      if (e.pos !== -1) return closed ? undefined : f
      // (-1: the formula ended where more was expected: an argument list or a group left open, or an operator with nothing after it)
      text += ')'
    }
  }
  return undefined
}

function readsOrCalls(text: string): boolean {
  let ast: Ast
  try {
    ast = parseFormula(text)
  } catch {
    return false
  }
  const has = (n: Ast): boolean => {
    switch (n.type) {
      case 'ref':
      case 'range':
      case 'call':
        return true
      case 'unary':
      case 'percent':
        return has(n.arg)
      case 'binary':
        return has(n.left) || has(n.right)
      case 'union':
        return n.items.some(has)
      default:
        return false
    }
  }
  return has(ast)
}

/**
 * The cell for what was typed. `want`: the number format to give a cell that has none, so that what was typed as a
 * date or a percentage shows as one (as Excel does).
 */
function parseInput(input: string, style: number, ctx: InputContext = { fmt: '', date1904: false }): { e: Entry | null; f?: string; want?: string } {
  if (input === '') return { e: style ? [T_EMPTY, '', style] : null }
  // a cell formatted as Text holds what is typed as it is typed: a phone number keeps its zeros, a formula is its text
  if (ctx.fmt === '@') return { e: [T_STR, input, style] }
  if (input.startsWith('=') && input.length > 1) {
    const f = typedFormula(input.slice(1))
    // not a formula yet ("=1+"): the text typed, which a file can hold (a formula that does not read cannot: Excel repairs the file)
    return f === undefined ? { e: [T_STR, input, style] } : { e: [T_STR, '=' + f, style], f }
  }
  const t = input.trim()
  const general = !ctx.fmt || /^general$/i.test(ctx.fmt)
  // "+A1+B1", "-A1", "@SUM(A1:A3)": a formula as a numeric keypad (or Lotus) starts one. Only what reads a cell or
  // calls a function: "-5" is a number, "- item" and "+84 912 345 678" are text.
  if (t.length > 1 && (t[0] === '+' || t[0] === '-' || t[0] === '@')) {
    const f = t[0] === '@' ? t.slice(1) : t
    if (readsOrCalls(f)) return { e: [T_STR, '=' + f, style], f }
  }
  if (ERROR_INPUT.test(t)) return { e: [T_ERR, t.toUpperCase(), style] }
  // a number in the separators of the locale it is typed in (a number too large to be one, 1e999, stays the text
  // typed: the file has no way to say Infinity)
  const n = readTyped(t, ctx.locale)
  // more digits than a number holds (a card number, an id): kept as typed, where a number would end in zeros
  if (n?.kind === 'plain' && /^[-+]?\d{16,}$/.test(n.canon)) return { e: [T_STR, input, style] }
  // in a cell that shows percentages, 50 is 50% (as Excel reads it); a number under 1 is the fraction itself
  if (n?.kind === 'plain') return { e: [T_NUM, Math.abs(n.value) >= 1 && noQuotes(ctx.fmt).includes('%') ? n.value / 100 : n.value, style] }
  if (n?.kind === 'percent') return { e: [T_NUM, n.value / 100, style], want: general ? (n.decimals ? `0.${'0'.repeat(Math.min(n.decimals, 10))}%` : '0%') : undefined }
  if (/^(true|false)$/i.test(t)) return { e: [T_BOOL, /^true$/i.test(t) ? 1 : 0, style] }
  if (n) return { e: [T_NUM, n.value, style], want: general ? amountFormat(n) : undefined }
  if (general || isDateFormat(ctx.fmt)) {
    const date = dateInput(t, ctx.date1904)
    if (date) return { e: [T_NUM, date.serial, style], want: general ? date.fmt : undefined }
  }
  return { e: [T_STR, input, style] }
}

// ---------------------------------------------------------------- styles

class StyleEditor {
  nodes: RChild[]
  root: RNode
  P: string
  private cache = new Map<string, number>()
  /**
   * per section: serialized entry → first index. Derived entries reuse identical ones, so derivation
   * depends only on the table's content — a saved and reopened workbook derives the same indexes
   * as the live one (collaboration snapshots rely on it).
   */
  private found = new Map<string, Map<string, number>>()
  changed = false

  constructor(xml: string) {
    this.nodes = parseRaw(xml)
    this.root = rootEl(this.nodes)!
    this.P = prefixOf(this.root.q)
  }

  private section(name: string): RNode {
    let n = kidOf(this.root, name)
    if (!n) {
      n = el(this.P + name, { count: '0' })
      setOrdered(this.root, n, name, SS_ORDER)
    }
    return n
  }

  private append(sectionName: string, node: RNode): number {
    const sec = this.section(sectionName)
    sec.c.push(node)
    sec.self = false
    const n = kidsOf(sec).length
    setAttr(sec, 'count', String(n))
    this.changed = true
    return n - 1
  }

  private lookup(sectionName: string): Map<string, number> {
    let m = this.found.get(sectionName)
    if (!m) {
      const idx = new Map<string, number>()
      kidsOf(kidOf(this.root, sectionName)).forEach((k, i) => {
        const s = serialize([k])
        if (!idx.has(s)) idx.set(s, i)
      })
      this.found.set(sectionName, (m = idx))
    }
    return m
  }

  /** index of an entry equal to `node`, appended when there is none */
  private intern(sectionName: string, node: RNode): number {
    const s = serialize([node])
    const m = this.lookup(sectionName)
    const hit = m.get(s)
    if (hit !== undefined) return hit
    const i = this.append(sectionName, node)
    m.set(s, i)
    return i
  }

  private numFmtId(code: string): number {
    for (const [id, c] of Object.entries(BUILTIN_FORMATS)) if (c === code) return Number(id)
    const sec = kidOf(this.root, 'numFmts')
    let max = 163
    for (const f of kidsOf(sec, 'numFmt')) {
      const id = Number(getAttr(f, 'numFmtId'))
      if (getAttr(f, 'formatCode') === code) return id
      max = Math.max(max, id)
    }
    this.append('numFmts', el(this.P + 'numFmt', { numFmtId: String(max + 1), formatCode: code }))
    return max + 1
  }

  derive(xfIndex: number, patch: FmtPatch): number {
    const key = xfIndex + JSON.stringify(patch)
    const hit = this.cache.get(key)
    if (hit !== undefined) return hit
    const P = this.P
    const xfs = kidsOf(this.section('cellXfs'), 'xf')
    const xf = clone(xfs[xfIndex] ?? xfs[0] ?? el(P + 'xf', { numFmtId: '0', fontId: '0', fillId: '0', borderId: '0' }))
    const fontKeys = ['b', 'i', 'u', 'strike', 'color', 'sz', 'font'] as const
    if (fontKeys.some((k) => k in patch)) {
      const fonts = kidsOf(this.section('fonts'), 'font')
      const font = clone(fonts[Number(getAttr(xf, 'fontId') ?? 0)] ?? fonts[0] ?? el(P + 'font'))
      const put = (l: string, n: RNode | undefined) => setOrdered(font, n, l, FONT_ORDER)
      if (patch.b !== undefined) put('b', patch.b ? el(P + 'b') : undefined)
      if (patch.i !== undefined) put('i', patch.i ? el(P + 'i') : undefined)
      if (patch.strike !== undefined) put('strike', patch.strike ? el(P + 'strike') : undefined)
      if (patch.u !== undefined) put('u', patch.u ? el(P + 'u') : undefined)
      if (patch.sz !== undefined) put('sz', el(P + 'sz', { val: String(patch.sz) }))
      const color = officeHex(patch.color)
      if ('color' in patch) put('color', color ? el(P + 'color', { rgb: 'FF' + color }) : undefined)
      if (patch.font) {
        put('name', el(P + 'name', { val: patch.font }))
        put('scheme', undefined)
      }
      setAttr(xf, 'fontId', String(this.intern('fonts', font)))
      setAttr(xf, 'applyFont', '1')
    }
    // a fill that is not a color (it would be written into the XML as it is) leaves the cell's fill alone
    const fillHex = officeHex(patch.fill)
    if ('fill' in patch && (!patch.fill || fillHex)) {
      if (!patch.fill) setAttr(xf, 'fillId', '0')
      else {
        const fill = parseRaw(
          `<${P}fill><${P}patternFill patternType="solid"><${P}fgColor rgb="FF${fillHex}"/><${P}bgColor indexed="64"/></${P}patternFill></${P}fill>`,
        )[0] as RNode
        setAttr(xf, 'fillId', String(this.intern('fills', fill)))
      }
      setAttr(xf, 'applyFill', '1')
    }
    if (patch.border) {
      const sides = (patch as FmtPatch & { sides?: Record<string, boolean> }).sides ?? {}
      const borders = kidsOf(this.section('borders'), 'border')
      const b = clone(borders[Number(getAttr(xf, 'borderId') ?? 0)] ?? borders[0] ?? el(P + 'border'))
      const color = officeHex(patch.borderColor) ?? '000000'
      const order = ['left', 'start', 'right', 'end', 'top', 'bottom', 'diagonal', 'vertical', 'horizontal']
      for (const side of ['left', 'right', 'top', 'bottom']) {
        if (!(side in sides)) continue
        const node = sides[side] ? el(P + side, { style: patch.borderStyle ?? 'thin' }, [el(P + 'color', { rgb: 'FF' + color })]) : el(P + side)
        setOrdered(b, node, side, order)
      }
      if (!kidOf(b, 'diagonal')) setOrdered(b, el(P + 'diagonal'), 'diagonal', order)
      setAttr(xf, 'borderId', String(this.intern('borders', b)))
      setAttr(xf, 'applyBorder', '1')
    }
    if ('align' in patch || 'wrap' in patch || 'valign' in patch || 'rotate' in patch) {
      const al = clone(kidOf(xf, 'alignment') ?? el(P + 'alignment'))
      if ('align' in patch) setAttr(al, 'horizontal', patch.align ?? undefined)
      if ('valign' in patch) setAttr(al, 'vertical', patch.valign && patch.valign !== 'bottom' ? patch.valign : undefined)
      if ('wrap' in patch) setAttr(al, 'wrapText', patch.wrap ? '1' : undefined)
      if ('rotate' in patch) {
        const v = patch.rotate
        // OOXML: 1-90 counter-clockwise, 91-180 clockwise (90 + deg), 255 vertical
        setAttr(al, 'textRotation', !v ? undefined : v === 255 ? '255' : v > 0 ? String(Math.min(90, v)) : String(90 + Math.min(90, -v)))
      }
      setOrdered(xf, al.a.trim() ? al : undefined, 'alignment', ['alignment', 'protection', 'extLst'])
      setAttr(xf, 'applyAlignment', '1')
    }
    if (patch.numFmt !== undefined) {
      setAttr(xf, 'numFmtId', String(this.numFmtId(patch.numFmt)))
      setAttr(xf, 'applyNumberFormat', '1')
    }
    const idx = this.intern('cellXfs', xf)
    this.cache.set(key, idx)
    return idx
  }

  xml() {
    return serialize(this.nodes)
  }

  /** collaboration: sizes of the growing sections (to drop what a rolled-back operation derived) */
  mark(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const name of ['numFmts', 'fonts', 'fills', 'borders', 'cellXfs']) out[name] = kidsOf(kidOf(this.root, name)).length
    return out
  }

  truncate(m: Record<string, number>) {
    for (const [name, len] of Object.entries(m)) {
      const sec = kidOf(this.root, name)
      const kids = kidsOf(sec)
      if (!sec || kids.length <= len) continue
      const drop = new Set<RChild>(kids.slice(len))
      sec.c = sec.c.filter((c) => !drop.has(c))
      setAttr(sec, 'count', String(len))
      const idx = this.found.get(name)
      if (idx) for (const [k, v] of idx) if (v >= len) idx.delete(k)
    }
    // a dropped index is given to another style later: forget what was derived from it too, not only what derived to it
    for (const [k, v] of this.cache) if (v >= m.cellXfs || parseInt(k) >= m.cellXfs) this.cache.delete(k)
  }
}

// ---------------------------------------------------------------- editor

export class XlsxEditor {
  private undoStack: Change[] = []
  private redoStack: Change[] = []

  /** the steps undo and redo can take back now */
  get history(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length }
  }
  private styleEd?: StyleEditor
  private stylesPath?: string
  private formulaTouched = false

  constructor(private wb: XlsxWorkbook) {}

  get dirty() {
    return [...this.wb.sheetsData.values()].some(needsWrite) || !!this.styleEd?.changed || this.bookChanged || this.wb.comments.dirty
  }

  /**
   * Comments of sheet `path` after `n` rows / columns were inserted (n > 0) or deleted (n < 0) at `at`: they move with
   * their cell, and go with it. Returns what changed (for undo).
   */
  private shiftComments(path: string, axis: 'row' | 'col', at: number, n: number): Change['cm'] {
    const store = this.wb.comments
    const before: [string, DocComment | null][] = []
    const after: [string, DocComment | null][] = []
    const set = (id: string, c: DocComment | null) => {
      before.push([id, store.get(id) ?? null])
      after.push([id, c])
      store.set(id, c)
    }
    for (const t of store.threads()) {
      const a = t.root.at
      if (!a || !('sheet' in a) || a.sheet !== path) continue
      const x = axis === 'row' ? a.r : a.c
      const y = n >= 0 ? (x >= at ? x + n : x) : x < at ? x : x < at - n ? null : x + n
      if (y === x) continue
      if (y === null) {
        for (const r of t.replies) set(r.id, null)
        set(t.root.id, null)
      } else set(t.root.id, { ...t.root, at: axis === 'row' ? { ...a, r: y } : { ...a, c: y } })
    }
    return before.length ? { before, after } : undefined
  }

  /** a protected sheet refuses what `flag` of <sheetProtection> forbids (every flag used here is on unless the file says "0") */
  private denySheet(d: SheetData, flag: string, what: string) {
    const v = d.protection?.[flag]
    if (d.protection && v !== '0' && v !== 'false') throw new Error(`This sheet is protected: ${what} is not allowed. Unprotect the sheet (in Excel) to change it.`)
  }

  /** style of the cell at (r, c) as the format of a cell with no content: its row's if it has one of its own, else its column's */
  private lockStyleAt(d: SheetData, r: number, c: number): number {
    const e = getEntry(d, r, c)
    if (e) return e[2]
    return this.defaultStyle(d, r, d.colInfo.find((ci) => ci.min <= c && c <= ci.max)?.x?.style)
  }

  private defaultStyle(d: SheetData, r: number, colStyle: string | undefined): number {
    const x = d.rowAttrs.get(r)?.x
    if (x && (x.customFormat === '1' || x.customFormat === 'true')) return Number(x.s ?? 0) || 0
    return Number(colStyle ?? 0) || 0
  }

  /** a protected sheet refuses to change a locked cell of `range` (no cell in it is locked: the cell formats say so) */
  private denyLocked(d: SheetData, range: Range | undefined, what = 'changing it') {
    if (!d.protection || !range) return
    const xfs = this.wb.styles.xfs
    const locked = (st: number) => xfs[st]?.locked ?? true
    const fail = () => {
      throw new Error(`This sheet is protected and the cells ${what} include locked ones. Unprotect the sheet (in Excel) to change them.`)
    }
    if (range.r0 === range.r1 && range.c0 === range.c1) {
      if (locked(this.lockStyleAt(d, range.r0, range.c0))) fail()
      return
    }
    // columns in stretches of one format, each checked on the cells it has and on the ones it has not
    const segs: [number, number, string | undefined][] = []
    let at = range.c0
    for (const ci of [...d.colInfo].sort((x, y) => x.min - y.min)) {
      const lo = Math.max(ci.min, at)
      const hi = Math.min(ci.max, range.c1)
      if (hi < lo) continue
      if (lo > at) segs.push([at, lo - 1, undefined])
      segs.push([lo, hi, ci.x?.style])
      at = hi + 1
    }
    if (at <= range.c1) segs.push([at, range.c1, undefined])
    const last = Math.min(range.r1, d.rows.length - 1)
    const plain = (r: number) => segs.some(([a, b, st]) => locked(this.defaultStyle(d, r, st)) && b >= a)
    for (let r = range.r0; r <= last; r++) {
      const row = d.rows[r]
      const n = segs.map(() => 0)
      if (row)
        for (let k = 0; k < row.length; k += 4) {
          const c = row[k] as number
          if (c < range.c0 || c > range.c1) continue
          if (locked(row[k + 3] as number)) fail()
          const i = segs.findIndex(([a, b]) => a <= c && c <= b)
          if (i >= 0) n[i]++
        }
      for (const [i, [a, b, st]] of segs.entries()) if (n[i] < b - a + 1 && locked(this.defaultStyle(d, r, st))) fail()
    }
    // the rows past the last one the sheet holds: their cells are empty (those with a format of their own apart)
    if (range.r1 > last) {
      const from = Math.max(range.r0, last + 1)
      let formatted = 0
      for (const r of d.rowAttrs.keys()) {
        if (r < from || r > range.r1) continue
        formatted++
        if (plain(r)) fail()
      }
      if (range.r1 - from + 1 > formatted && segs.some(([a, b, st]) => b >= a && locked(this.defaultStyle(d, -1, st)))) fail()
    }
  }

  /** what a protected sheet allows, for each operation on it */
  private guardOp(d: SheetData, op: SheetOp) {
    if (op.op === 'paste' && op.moved) {
      // cells cut leave their place: the sheet they come from (it may be another one) has its say
      const from = this.wb.sheetsData.get(this.wb.sheets.findIndex((x) => x.path === op.from.sheet))
      const w = op.cells.reduce((m, row) => Math.max(m, row.length), 0)
      if (from?.protection && op.cells.length && w) this.denyLocked(from, { r0: op.from.r0, c0: op.from.c0, r1: op.from.r0 + op.cells.length - 1, c1: op.from.c0 + w - 1 }, 'cut')
    }
    if (!d.protection) return
    switch (op.op) {
      case 'insertRows':
        return this.denySheet(d, 'insertRows', 'inserting rows')
      case 'insertCols':
        return this.denySheet(d, 'insertColumns', 'inserting columns')
      case 'deleteRows':
        this.denySheet(d, 'deleteRows', 'deleting rows')
        return this.denyLocked(d, { r0: op.at, r1: op.at + op.n - 1, c0: 0, c1: MAX_COL - 1 }, 'of the rows')
      case 'deleteCols':
        this.denySheet(d, 'deleteColumns', 'deleting columns')
        return this.denyLocked(d, { r0: 0, r1: MAX_ROWS - 1, c0: op.at, c1: op.at + op.n - 1 }, 'of the columns')
      case 'merge':
      case 'unmerge':
        this.denySheet(d, 'formatCells', op.op === 'merge' ? 'merging cells' : 'unmerging cells')
        return op.op === 'merge' ? this.denyLocked(d, op.range) : undefined
      case 'hideCols':
      case 'colWidth':
        return this.denySheet(d, 'formatColumns', 'changing columns')
      case 'hideRows':
      case 'rowHeight':
        return this.denySheet(d, 'formatRows', 'changing rows')
      case 'clear':
        return this.denyLocked(d, op.range)
      case 'fill':
        return this.denyLocked(d, op.dir === 'down' ? { ...op.range, r0: op.range.r0 + 1 } : { ...op.range, c0: op.range.c0 + 1 })
      case 'paste': {
        const w = op.cells.reduce((m, row) => Math.max(m, row.length), 0)
        if (!op.cells.length || !w) return
        return this.denyLocked(d, { r0: op.range.r0, c0: op.range.c0, r1: Math.min(MAX_ROWS - 1, op.range.r0 + op.cells.length - 1), c1: Math.min(MAX_COL - 1, op.range.c0 + w - 1) })
      }
      case 'sort':
        this.denySheet(d, 'sort', 'sorting')
        return this.denyLocked(d, op.range)
    }
  }

  private sheet(i: number): SheetData {
    const d = this.wb.sheetsData.get(i)
    if (!d || !d.done) throw new Error('Sheet is still loading')
    return d
  }

  private lastRecalc: number[] = []
  /** the sheet reached further after the last change than before (a formula filled cells past its last row / column): how far */
  private lastGrown: { rows: number; cols: number } | undefined

  /**
   * Before anything is edited: every sheet is in memory (a formula may read any, and a sheet never shown may hold
   * formulas reading the cell edited: its values are saved too), the values a file left out are computed, and the
   * cells of the shared formulas have their text (an edit records the formula a cell had).
   */
  private async ready(): Promise<void> {
    const wb = this.wb
    if (!wb.sheets.every((s) => wb.sheetsData.get(s.index)?.done)) {
      await Promise.all(wb.sheets.map((s) => wb.loadSheet(s.index, () => {})))
      // the dependencies known so far are those of the sheets read then
      wb.calc.invalidate()
    }
    await wb.settled()
    for (const d of wb.sheetsData.values()) expandShared(d)
  }

  private apply(d: SheetData, cells: CellChange[], which: 'prev' | 'next') {
    const sheet = [...this.wb.sheetsData].find(([, x]) => x === d)?.[0] ?? 0
    const formulaKeys: { sheet: number; key: number }[] = []
    const reach = [d.maxRow, d.maxCol]
    // A value a dynamic array formula spilled into a cell is not the cell's own: what is typed over it replaces
    // nothing, and undoing leaves the cell empty for the formula to fill again.
    if (which === 'next' && d.dynamic.size) {
      for (const ch of cells) if (ch.prev && !ch.prevF && ch.prev[0] !== T_EMPTY && this.wb.calc.spilledAt(sheet, ch.key)) ch.prev = ch.prev[2] ? [T_EMPTY, '', ch.prev[2]] : null
    }
    if (which === 'next') for (const ch of cells) if (ch.prevD === undefined && ch.prevF !== undefined) ch.prevD = d.dynamic.has(ch.key)
    this.applyRaw(d, cells, which)
    for (const ch of cells) {
      const f0 = which === 'prev' ? ch.nextF : ch.prevF
      const f1 = which === 'prev' ? ch.prevF : ch.nextF
      if (f0 !== f1) {
        this.wb.calc.formulaChanged(sheet, ch.key, which === 'prev' ? ch.prevD : ch.nextD)
        if (which === 'next' && ch.nextD === undefined && f1 !== undefined) ch.nextD = d.dynamic.has(ch.key)
      }
      if (f1) formulaKeys.push({ sheet, key: ch.key })
    }
    // only value changes matter for dependents (formatting doesn't)
    const changed = cells.filter((c) => {
      if (which === 'prev' ? c.prevF : c.nextF) return false
      const a = c.prev
      const b = c.next
      return !a || !b || a[0] !== b[0] || a[1] !== b[1] || c.prevF !== c.nextF
    })
    this.lastRecalc = changed.length || formulaKeys.length ? [...this.wb.calc.recalc(changed.map((c) => ({ sheet, key: c.key })), formulaKeys)] : []
    this.lastGrown = d.maxRow > reach[0] || d.maxCol > reach[1] ? { rows: d.maxRow + 1, cols: d.maxCol + 1 } : undefined
  }

  private applyRaw(d: SheetData, cells: CellChange[], which: 'prev' | 'next') {
    for (const ch of cells) {
      const r = Math.floor(ch.key / MAX_COL)
      const c = ch.key % MAX_COL
      setEntry(d, r, c, which === 'prev' ? ch.prev : ch.next)
      const f = which === 'prev' ? ch.prevF : ch.nextF
      if (f) d.formulas.set(ch.key, f)
      else d.formulas.delete(ch.key)
      d.edited.add(ch.key)
      if (ch.prevF || ch.nextF) this.formulaTouched = true
    }
  }

  private record(sheet: number, cells: CellChange[], range: Range, lay?: Change['lay']): XlsxEditResult {
    this.undoStack.push({ sheet, cells, range, lay })
    if (this.undoStack.length > 200) this.undoStack.shift()
    this.redoStack = []
    return { sheet, range, recalc: this.lastRecalc, layout: lay ? this.layout(sheet) : undefined, ...(this.lastGrown ? { grown: this.lastGrown } : {}) }
  }

  /** after rows/columns moved: rebuild the dependency graph and recompute every formula */
  private recalcAll(): number[] {
    this.wb.calc.invalidate()
    const all: { sheet: number; key: number }[] = []
    for (const [sheet, d] of this.wb.sheetsData) for (const key of d.formulas.keys()) all.push({ sheet, key })
    return [...this.wb.calc.recalc([], all)]
  }

  /** `opts.locale`: the BCP 47 tag the numbers among `inputs` were typed in (undefined: a decimal point; formulas are never read in it) */
  async setCells(sheet: number, inputs: CellInput[], opts: SetOptions = {}): Promise<XlsxEditResult> {
    await this.ready()
    const d = this.sheet(sheet)
    if (d.protection) for (const { r, c } of inputs) this.denyLocked(d, { r0: r, c0: c, r1: r, c1: c })
    await this.prepare(sheet, d, inputs)
    const changes: CellChange[] = []
    const range = { r0: Infinity, c0: Infinity, r1: -1, c1: -1 }
    // text with line breaks: the cell wraps and its row grows to show every line (as Excel does)
    const xfs = this.wb.styles.xfs
    let ed: StyleEditor | undefined
    let rowsBefore: LayoutState['rowAttrs']
    for (const { r, c, input } of inputs) {
      const key = r * MAX_COL + c
      const prev = getEntry(d, r, c)
      // (a cell typed into an empty place takes the format of its row, else of its column)
      const st = prev?.[2] ?? this.lockStyleAt(d, r, c)
      const { e, f, want: typed } = parseInput(input, st, { fmt: xfs[st]?.numFmt ?? '', date1904: this.wb.date1904, locale: opts?.locale })
      // a formula typed into a cell without a format shows as what it computes: a date, or as the cell it is
      const want = typed ?? (e && f && !/[^\s]/.test((xfs[st]?.numFmt ?? '').replace(/^general$/i, '')) ? this.formulaFormat(sheet, f) : undefined)
      if (e && want) e[2] = (ed ??= await this.styles()).derive(st, { numFmt: want })
      if (e && e[0] === T_STR && !f && input.includes('\n')) {
        if (!xfs[st]?.wrap) e[2] = (ed ??= await this.styles()).derive(st, { wrap: true })
        const a = d.rowAttrs.get(r)
        const now = a?.ht !== undefined ? Math.round((a.ht * 4) / 3) : (d.autoRowH.get(r) ?? d.defaultRowH)
        const need = input.split('\n').length * Math.max(d.defaultRowH, Math.round((xfs[st]?.fontPt ?? 11) * 1.6 + 2))
        if (need > now && !a?.hidden && !d.merges.some((m) => m.r0 <= r && r <= m.r1 && m.c0 <= c && c <= m.c1)) {
          rowsBefore ??= layoutState(d).rowAttrs
          setRowHeight(d, r, r, need)
        }
      }
      changes.push({ key, prev, prevF: d.formulas.get(key), next: e, nextF: f })
      range.r0 = Math.min(range.r0, r)
      range.c0 = Math.min(range.c0, c)
      range.r1 = Math.max(range.r1, r)
      range.c1 = Math.max(range.c1, c)
    }
    this.apply(d, changes, 'next')
    const styles = ed ? this.restyled(ed, xfs.length) : undefined
    const res = this.record(sheet, changes, range, rowsBefore && { before: { rowAttrs: rowsBefore }, after: { rowAttrs: layoutState(d).rowAttrs } })
    if (styles?.length) res.styles = styles
    return res
  }

  /**
   * The number format a formula typed into a cell without one takes, as Excel gives it: a date for the functions
   * that give one, the format of the cell it reads for "=A1", a date for a date moved by a number ("=A1+30").
   * Undefined: none (the General format stays).
   */
  private formulaFormat(sheet: number, f: string): string | undefined {
    let ast: Ast
    try {
      ast = parseFormula(f)
    } catch {
      return undefined
    }
    const xfs = this.wb.styles.xfs
    const fmtOf = (ref: RefAddr): string => {
      const i = ref.sheet === undefined ? sheet : this.wb.sheets.findIndex((s) => s.name.toLowerCase() === ref.sheet!.toLowerCase())
      const d = this.wb.sheetsData.get(i)
      const fmt = d ? (xfs[getEntry(d, ref.r0, ref.c0)?.[2] ?? 0]?.numFmt ?? '') : ''
      return /^general$/i.test(fmt) ? '' : fmt
    }
    const cellFmt = (n: Ast): string => (n.type === 'ref' && n.ref.kind === 'cell' ? fmtOf(n.ref) : '')
    const dateOf = (n: Ast): string => {
      const fmt = cellFmt(n)
      return fmt && isDateFormat(fmt) ? fmt : ''
    }
    while (ast.type === 'unary' && ast.op === '+') ast = ast.arg
    if (ast.type === 'ref') return cellFmt(ast) || undefined
    if (ast.type === 'call') {
      if (ast.name === 'NOW') return 'dd/mm/yyyy hh:mm'
      if (ast.name === 'TIME' || ast.name === 'TIMEVALUE') return 'hh:mm:ss'
      if (DATE_FUNCTIONS.has(ast.name)) return (ast.args[0] && dateOf(ast.args[0])) || 'dd/mm/yyyy'
      if ((ast.name === 'MIN' || ast.name === 'MAX') && ast.args.length) {
        // (the earliest / latest of some dates: the format of the first of them)
        const a = ast.args[0].type === 'range' ? ast.args[0].left : ast.args[0]
        const fmt = a.type === 'ref' && a.ref.kind === 'area' ? fmtOf(a.ref) : cellFmt(a)
        return fmt && isDateFormat(fmt) ? fmt : undefined
      }
      return undefined
    }
    // a date and some days is a date; the days between two dates are a number
    if (ast.type === 'binary' && (ast.op === '+' || ast.op === '-')) {
      const l = dateOf(ast.left)
      const r = dateOf(ast.right)
      if (l && !r) return l
      if (r && !l && ast.op === '+') return r
    }
    return undefined
  }

  /** the style table grew: stores it, re-derives its css and returns the entries added after the first `before` */
  private restyled(ed: StyleEditor, before: number): NonNullable<XlsxEditResult['styles']> {
    const xml = ed.xml()
    this.wb.pkg.setPart(this.stylesPath!, xml)
    this.wb.styles = parseSheetStyles(parseXml(xml), this.wb.theme)
    return this.wb.styles.xfs.slice(before).map((x, i) => ({ index: before + i, css: x.css, format: x.numFmt }))
  }

  /**
   * Sheets read from their file by pages: the rows an edit touches, and the rows read by the formulas it adds or
   * whose value it changes, are in memory first (throws when they cannot all be).
   */
  private async prepare(sheet: number, d: SheetData, inputs: CellInput[]): Promise<void> {
    let paged = false
    for (const x of this.wb.sheetsData.values()) if (x.pages) paged = true
    if (!paged) return
    // the rows edited, in runs (an edit far down and one at the top are two)
    const rows = [...new Set(inputs.map((i) => i.r))].sort((a, b) => a - b)
    const gap = d.pages?.size ?? 1
    for (let i = 0; i < rows.length; ) {
      let j = i
      while (j + 1 < rows.length && rows[j + 1] - rows[j] <= gap) j++
      await this.wb.ensure(d, rows[i], rows[j])
      i = j + 1
    }
    const changed = inputs.map((i) => ({ sheet, key: i.r * MAX_COL + i.c }))
    const added = inputs.filter((i) => i.input.length > 1 && i.input.startsWith('=')).map((i) => ({ sheet, key: i.r * MAX_COL + i.c, text: i.input.slice(1) }))
    for (const need of this.wb.calc.reads(changed, added)) {
      const x = this.wb.sheetsData.get(need.sheet)
      if (x?.pages) await this.wb.ensure(x, need.r0, need.r1)
    }
    // later rows may have pushed earlier ones out again
    if (d.pages) for (const r of rows) if (!d.pages.has(r)) throw new Error(`More rows at once than a sheet of ${(d.maxRow + 1).toLocaleString()} rows can hold in memory`)
  }

  private async styles(): Promise<StyleEditor> {
    if (!this.styleEd) {
      this.stylesPath = stylesPartOf(this.wb.pkg, this.wb.rels) ?? DEFAULT_STYLES_PART
      const xml = this.wb.pkg.has(this.stylesPath)
        ? await this.wb.pkg.text(this.stylesPath)
        : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>'
      this.styleEd = new StyleEditor(xml)
    }
    return this.styleEd
  }

  /**
   * Formats the cells of `range`. Whole columns (or the whole sheet) and whole rows take the format as their own,
   * as in Excel: the cells they have get it one by one, the rest through the column's / row's style, which a cell
   * typed there later takes. The format of every cell before and after is kept by cell (`Change.restyle`).
   */
  async format(sheet: number, range: Range, patch: FmtPatch): Promise<XlsxEditResult> {
    await this.ready()
    const d = this.sheet(sheet)
    this.denySheet(d, 'formatCells', 'formatting cells')
    const ed = await this.styles()
    const wholeCols = range.r0 === 0 && range.r1 >= MAX_ROWS - 1
    const wholeRows = !wholeCols && range.c0 === 0 && range.c1 >= MAX_COL - 1
    const R = wholeCols || wholeRows ? this.used(d, range) : range
    await this.wb.ensure(d, R.r0, R.r1)
    const before = this.wb.styles.xfs.length
    const styled = (st: number, r: number, c: number): number => {
      if (patch.clear) return 0
      if (patch.xf !== undefined) return patch.xf
      if (!patch.border) return ed.derive(st, patch)
      const sides = borderSides(patch.border, range, r, c)
      return Object.keys(sides).length ? ed.derive(st, { ...patch, sides } as FmtPatch) : st
    }
    // the format of a column / row itself: no borders but those every cell gets
    const own = (st: number): number => {
      if (patch.clear) return 0
      if (patch.xf !== undefined) return patch.xf
      if (!patch.border) return ed.derive(st, patch)
      if (patch.border !== 'all' && patch.border !== 'none') return st
      const on = patch.border === 'all'
      return ed.derive(st, { ...patch, sides: { top: on, bottom: on, left: on, right: on } } as FmtPatch)
    }
    const keys: number[] = []
    const was: number[] = []
    const now: number[] = []
    const put = (r: number, c: number, st: number, exists: boolean) => {
      const s = styled(st, r, c)
      // (a place without a cell shows the format of its row / column: no cell is made to say the same)
      if (s === st) return
      keys.push(r * MAX_COL + c)
      was.push(exists ? st : -1)
      now.push(s)
    }
    const lay = wholeCols || wholeRows ? layoutState(d) : undefined
    if (!wholeCols && !wholeRows) {
      const count = (R.r1 - R.r0 + 1) * (R.c1 - R.c0 + 1)
      if (count > MAX_CELLS_AT_ONCE) throw new Error(`Too many cells to format at once (${count.toLocaleString()}): select whole columns or rows instead`)
      for (let r = R.r0; r <= R.r1; r++) {
        const row = d.rows[r]
        let k = row ? colAt(row, R.c0) : 0
        for (let c = R.c0; c <= R.c1; c++) {
          if (row && k < row.length && row[k] === c) {
            put(r, c, row[k + 3] as number, true)
            k += 4
          } else put(r, c, this.lockStyleAt(d, r, c), false)
        }
      }
    } else {
      // the cells there are
      for (let r = R.r0; r <= R.r1; r++) {
        const row = d.rows[r]
        if (!row) continue
        for (let k = colAt(row, R.c0); k < row.length && (row[k] as number) <= R.c1; k += 4) put(r, row[k] as number, row[k + 3] as number, true)
      }
      const rowStyle = (a: RowAttrs | undefined) => (a?.x && (a.x.customFormat === '1' || a.x.customFormat === 'true') ? Number(a.x.s ?? 0) || 0 : undefined)
      if (wholeCols) {
        const sheetWide = range.c0 === 0 && range.c1 >= MAX_COL - 1
        // where a row has a format of its own, that one shows in its empty cells: the whole sheet changes it too,
        // some columns get a cell there (as Excel writes them)
        let made = 0
        for (const [r, a] of d.rowAttrs) {
          const st = rowStyle(a)
          if (st === undefined) continue
          if (sheetWide) d.rowAttrs.set(r, { ...a, x: { ...a.x, s: String(own(st)), customFormat: '1' } })
          else for (let c = range.c0; c <= range.c1 && made < MAX_CELLS_MADE; c++) if (!getEntry(d, r, c)) (put(r, c, st, false), made++)
          d.dirtyRows.add(r)
        }
        setColStyle(d, range.c0, Math.min(range.c1, MAX_COL - 1), own)
      } else {
        const last = Math.min(range.r1, MAX_ROWS - 1)
        if (last - range.r0 + 1 > MAX_CELLS_MADE) throw new Error('Too many rows to format at once: select the whole sheet instead')
        // the columns with a format of their own keep it under the row's: a cell where they cross (not for a format of the whole sheet's width)
        const cols = d.colInfo.filter((ci) => ci.x?.style && ci.max - ci.min < 1024)
        let made = 0
        for (let r = range.r0; r <= last; r++) {
          const a = d.rowAttrs.get(r)
          const st = rowStyle(a)
          for (const ci of cols) for (let c = ci.min; c <= ci.max && made < MAX_CELLS_MADE; c++) if (st === undefined && !getEntry(d, r, c)) (put(r, c, Number(ci.x!.style) || 0, false), made++)
          d.rowAttrs.set(r, { ...(a ?? {}), x: { ...(a?.x ?? {}), s: String(own(st ?? 0)), customFormat: '1' } })
          d.dirtyRows.add(r)
        }
      }
    }
    if (keys.length > MAX_CELLS_AT_ONCE * 2) throw new Error(`Too many cells to format at once (${keys.length.toLocaleString()})`)
    const restyle = { keys: Float64Array.from(keys), before: Int32Array.from(was), after: Int32Array.from(now) }
    this.restyle(d, restyle, 'next')
    this.lastRecalc = []
    const res = this.record(sheet, [], range, lay && { before: lay, after: layoutState(d) })
    this.undoStack[this.undoStack.length - 1].restyle = restyle
    res.styles = this.restyled(ed, before)
    return res
  }

  /** gives the cells of a format change the format they had before it, or have after (a cell the change made goes with it) */
  private restyle(d: SheetData, x: NonNullable<Change['restyle']>, which: 'prev' | 'next') {
    const to = which === 'next' ? x.after : x.before
    // many cells: their rows are written whole, where a set of every cell would take more room than the cells
    const bulk = x.keys.length > 50_000
    for (let i = 0; i < x.keys.length; i++) {
      const key = x.keys[i]
      const r = Math.floor(key / MAX_COL)
      const c = key % MAX_COL
      if (d.pages && !d.pages.has(r)) throw new Error('Row not in memory')
      d.pages?.pin(r)
      let row = ownRow(d, r)
      let k = row ? colAt(row, c) : 0
      const exists = !!row && k < row.length && row[k] === c
      if (to[i] < 0) {
        // (the cell was made to hold the format: it goes, unless something was typed into it since)
        if (exists && row![k + 1] === T_EMPTY) {
          row!.splice(k, 4)
          if (!row!.length) d.rows[r] = undefined
        } else if (exists) row![k + 3] = 0
      } else if (exists) row![k + 3] = to[i]
      else {
        if (!row) d.rows[r] = row = []
        k = colAt(row, c)
        row.splice(k, 0, c, T_EMPTY, '', to[i])
        if (r > d.maxRow) d.maxRow = r
        if (c > d.maxCol) d.maxCol = c
      }
      if (bulk) d.rewrite.add(r)
      else d.edited.add(key)
    }
  }

  private step(ch: Change, which: 'prev' | 'next'): XlsxEditResult {
    const d = this.sheet(ch.sheet)
    this.lastRecalc = []
    this.lastGrown = undefined
    if (ch.full) restore(d, which === 'prev' ? ch.full.before : ch.full.after)
    for (const o of ch.others ?? []) {
      const od = this.wb.sheetsData.get(o.sheet)
      if (od) setFormula(od, o.key, which === 'prev' ? o.prev : o.next)
    }
    for (const p of ch.parts ?? []) this.wb.pkg.setPart(p.path, which === 'prev' ? p.prev : p.next)
    if (ch.book) {
      const b = which === 'prev' ? ch.book.before : ch.book.after
      this.wb.names = b.names
      this.wb.tables = b.tables
      this.wb.pivots = b.pivots
      this.wb.calc.namesChanged()
    }
    if (ch.cm) for (const [id, c] of which === 'prev' ? [...ch.cm.before].reverse() : ch.cm.after) this.wb.comments.set(id, c)
    if (ch.sort) {
      if (which === 'next') this.moveRows(d, ch.range, ch.sort.order, ch.sort.before, ch.sort.after)
      else this.moveRows(d, ch.range, inverse(ch.sort.order), ch.sort.after, ch.sort.before)
    }
    if (ch.restyle) this.restyle(d, ch.restyle, which)
    this.apply(d, ch.cells, which)
    if (ch.lay) applyLayout(d, which === 'prev' ? ch.lay.before : ch.lay.after)
    const recalc = ch.full || ch.others?.length || ch.sort ? this.recalcAll() : this.lastRecalc
    return { sheet: ch.sheet, range: ch.range, layout: ch.full || ch.lay ? this.layout(ch.sheet) : undefined, recalc, ...(this.lastGrown ? { grown: this.lastGrown } : {}) }
  }

  undo(): XlsxEditResult | null {
    const ch = this.undoStack.pop()
    if (!ch) return null
    this.redoStack.push(ch)
    return this.step(ch, 'prev')
  }

  redo(): XlsxEditResult | null {
    const ch = this.redoStack.pop()
    if (!ch) return null
    this.undoStack.push(ch)
    return this.step(ch, 'next')
  }

  // ---------------------------------------------------------------- collaboration

  /** takes the change recorded by the last operation out of the (unused) undo history */
  takeRecord(): Change | undefined {
    const ch = this.undoStack.pop()
    this.undoStack = []
    this.redoStack = []
    return ch
  }

  /** exactly undoes a recorded change (rolling back an unconfirmed operation) */
  revertRecord(ch: Change): XlsxEditResult {
    return this.step(ch, 'prev')
  }

  /** sets the cells / layout touched by `ch` to its `which` state, recorded as a new change */
  restoreRecord(ch: Change, which: 'prev' | 'next'): XlsxEditResult {
    const d = this.sheet(ch.sheet)
    // Only the cells that still hold what this change left in them: one somebody changed since is theirs (undoing
    // a change of one's own does not take away what others typed after it).
    const cells: CellChange[] = []
    for (const c of ch.cells) {
      const cur = getEntry(d, Math.floor(c.key / MAX_COL), c.key % MAX_COL)
      const curF = d.formulas.get(c.key)
      const [left, leftF] = which === 'prev' ? [c.next, c.nextF] : [c.prev, c.prevF]
      const same = curF !== undefined || leftF !== undefined ? curF === leftF : (cur?.[0] ?? T_EMPTY) === (left?.[0] ?? T_EMPTY) && (cur?.[1] ?? '') === (left?.[1] ?? '')
      if (!same) continue
      const to = which === 'prev' ? c.prev : c.next
      // (a format given to the cell since stays)
      const next: Entry | null = to && cur && left && cur[2] !== left[2] ? [to[0], to[1], cur[2]] : !to && cur && left && cur[2] !== left[2] ? [T_EMPTY, '', cur[2]] : to
      cells.push({ key: c.key, prev: cur, prevF: curF, next, nextF: which === 'prev' ? c.prevF : c.nextF, nextD: which === 'prev' ? c.prevD : c.nextD })
    }
    const counter: Change = {
      sheet: ch.sheet,
      cells,
      range: ch.range,
      lay: ch.lay ? { before: layoutState(d), after: which === 'prev' ? ch.lay.before : ch.lay.after } : undefined,
      full: ch.full ? { before: snapshot(d), after: which === 'prev' ? ch.full.before : ch.full.after } : undefined,
      others: ch.others?.map((o) => ({ ...o, prev: this.wb.sheetsData.get(o.sheet)?.formulas.get(o.key) ?? '', next: which === 'prev' ? o.prev : o.next })),
      // (the cells as they are formatted now, given the format of then)
      restyle: ch.restyle && {
        keys: ch.restyle.keys,
        before: Int32Array.from(ch.restyle.keys, (key) => getEntry(d, Math.floor(key / MAX_COL), key % MAX_COL)?.[2] ?? -1),
        after: which === 'prev' ? ch.restyle.before : ch.restyle.after,
      },
      // (the rows as they are now, put back in the order they had)
      sort: ch.sort && (which === 'prev' ? { order: inverse(ch.sort.order), before: ch.sort.after, after: ch.sort.before } : ch.sort),
      cm: ch.cm
        ? { before: ch.cm.before.map(([id]) => [id, this.wb.comments.get(id) ?? null]), after: which === 'prev' ? [...ch.cm.before].reverse() : ch.cm.after }
        : undefined,
    }
    const res = this.step(counter, 'next')
    this.undoStack.push(counter)
    return res
  }

  /** style table sizes before an operation */
  async styleMark(): Promise<Record<string, number>> {
    return (await this.styles()).mark()
  }

  /** drops styles derived after `m` (the operations that used them were rolled back) */
  async styleTruncate(m: Record<string, number>) {
    const ed = await this.styles()
    const before = ed.xml()
    ed.truncate(m)
    const xml = ed.xml()
    if (xml === before) return
    this.wb.pkg.setPart(this.stylesPath!, xml)
    this.wb.styles = parseSheetStyles(parseXml(xml), this.wb.theme)
  }

  /** style index of a cell (0 when empty) */
  styleAt(sheet: number, r: number, c: number): number {
    return this.lockStyleAt(this.sheet(sheet), r, c)
  }

  /** current layout of a sheet (after structural edits) */
  layout(sheet: number): SheetProgress {
    const d = this.sheet(sheet)
    const rowSizes = rowSizesOf(d)
    return {
      sheet, rows: d.maxRow + 1, cols: d.maxCol + 1, rowSizes, done: true, colInfo: d.colInfo, defaultColW: d.defaultColW,
      defaultRowH: d.defaultRowH, frozen: d.frozen, gridLines: d.gridLines, merges: d.merges,
    }
  }

  private indexOf(d: SheetData): number {
    for (const [i, x] of this.wb.sheetsData) if (x === d) return i
    return -1
  }

  private async allSheets(): Promise<{ name: string; d: SheetData }[]> {
    await Promise.all(this.wb.sheets.map((s) => this.wb.loadSheet(s.index, () => {})))
    return this.wb.sheets.map((s) => ({ name: s.name, d: this.wb.sheetsData.get(s.index)! }))
  }

  async sheetOp(sheet: number, op: SheetOp): Promise<XlsxEditResult> {
    await this.ready()
    const d = this.sheet(sheet)
    this.guardOp(d, op)
    const name = this.wb.sheets[sheet].name
    const all: Range = { r0: 0, c0: 0, r1: Math.max(0, d.maxRow + 50), c1: Math.max(0, d.maxCol + 10) }
    const lay = (fn: () => void, range = all): XlsxEditResult => {
      const before = layoutState(d)
      fn()
      const ch: Change = { sheet, cells: [], range, lay: { before, after: layoutState(d) } }
      this.undoStack.push(ch)
      this.redoStack = []
      return { sheet, range, layout: this.layout(sheet) }
    }
    switch (op.op) {
      case 'insertRows':
      case 'deleteRows':
      case 'insertCols':
      case 'deleteCols': {
        if (d.pages) throw new Error(`Rows and columns cannot be inserted or deleted in a sheet of ${(d.maxRow + 1).toLocaleString()} rows (its rows are read from the file as they are shown)`)
        const others = await this.allSheets()
        const axis = op.op.endsWith('Rows') ? 'row' : 'col'
        if (op.op.startsWith('insert') && overflows(d, axis, op.at, op.n)) {
          throw new Error(
            axis === 'row'
              ? 'Rows cannot be inserted: the last row of the sheet holds data, which would be pushed off the sheet. Delete or move it first.'
              : 'Columns cannot be inserted: the last column of the sheet holds data, which would be pushed off the sheet. Delete or move it first.',
          )
        }
        const before = snapshot(d)
        const delta = op.op.startsWith('insert') ? op.n : -op.n
        const edits = shiftSheet(d, name, axis, op.at, delta, others)
        // what else points at the cells follows them: names, tables, pictures, charts (the sheet's own filters, links… when it is written)
        const followed = await followParts(this.wb.pkg, this.wb.mainPath, this.wb.sheets[sheet].path, name, { axis, at: op.at, delta })
        for (const h of followed.headers) setEntry(d, h.r, h.c, [T_STR, h.text, getEntry(d, h.r, h.c)?.[2] ?? 0])
        if (followed.parts.length) this.bookChanged = true
        // (the names and tables the formulas know are those of the parts as they are now)
        const book: BookState = { names: this.wb.names, tables: this.wb.tables, pivots: this.wb.pivots }
        if (followed.parts.length) await this.wb.loadNames()
        const cm = this.shiftComments(this.wb.sheets[sheet].path, axis, op.at, delta)
        this.formulaTouched = true
        const recalc = this.recalcAll()
        const ch: Change = { sheet, cells: [], range: all, full: { before, after: snapshot(d) }, cm }
        if (edits.length) ch.others = edits.map((e) => ({ sheet: this.indexOf(e.d), key: e.key, prev: e.prev, next: e.next }))
        if (followed.parts.length) {
          ch.parts = followed.parts
          ch.book = { before: book, after: { names: this.wb.names, tables: this.wb.tables, pivots: this.wb.pivots } }
        }
        this.undoStack.push(ch)
        this.redoStack = []
        return { sheet, range: all, layout: this.layout(sheet), recalc }
      }
      case 'merge':
      case 'unmerge': {
        const R = op.range
        const blocks: Range[] =
          op.op === 'unmerge' || !op.mode || op.mode === 'all'
            ? [R]
            : op.mode === 'across'
              ? Array.from({ length: R.r1 - R.r0 + 1 }, (_, i) => ({ r0: R.r0 + i, r1: R.r0 + i, c0: R.c0, c1: R.c1 }))
              : Array.from({ length: R.c1 - R.c0 + 1 }, (_, i) => ({ r0: R.r0, r1: R.r1, c0: R.c0 + i, c1: R.c0 + i }))
        const res = lay(() => {
          setMerge(d, R, false)
          if (op.op === 'merge') for (const b of blocks) setMerge(d, b, true)
        }, R)
        if (op.op === 'merge') {
          // like Excel: only the top-left value of each merged block survives
          const clear: CellInput[] = []
          for (const b of blocks)
            for (let r = b.r0; r <= b.r1; r++)
              for (let c = b.c0; c <= b.c1; c++) if ((r !== b.r0 || c !== b.c0) && getEntry(d, r, c) && getEntry(d, r, c)?.[1] !== '') clear.push({ r, c, input: '' })
          if (clear.length) {
            await this.setCells(sheet, clear)
            const last = this.undoStack.pop()!
            this.undoStack[this.undoStack.length - 1].cells = last.cells
          }
        }
        return res
      }
      case 'hideRows':
        return lay(() => {
          for (let r = op.a; r <= op.b; r++) {
            const cur = d.rowAttrs.get(r)
            if (op.hidden) d.rowAttrs.set(r, { ...(cur ?? {}), hidden: true })
            else if (cur) {
              const { hidden: _h, ...rest } = cur
              if (rest.ht !== undefined || rest.x) d.rowAttrs.set(r, rest)
              else d.rowAttrs.delete(r)
            }
            d.dirtyRows.add(r)
          }
        })
      case 'hideCols':
        return lay(() => hideCols(d, op.a, op.b, op.hidden))
      case 'gridlines':
        return lay(() => {
          d.gridLines = op.show
          d.dirtyView = true
        })
      case 'colWidth':
        return lay(() => setColWidth(d, op.c0, op.c1, op.px))
      case 'rowHeight':
        return lay(() => setRowHeight(d, op.r0, op.r1, op.px))
      case 'freeze':
        return lay(() => {
          d.frozen = { rows: op.rows, cols: op.cols }
          d.dirtyView = true
        })
      case 'clear':
        return this.clear(sheet, d, op.range)
      case 'paste':
        return this.paste(sheet, d, op)
      case 'fill':
        await this.wb.ensure(d, op.range.r0, op.range.r1)
        return this.fill(sheet, d, op.range, op.dir)
      case 'sort':
        await this.wb.ensure(d, op.range.r0, op.range.r1)
        return this.sort(sheet, d, op.range, op.col, !!op.desc, op.order)
    }
  }

  /** the cells of `range` that are in the sheet: it may run to the last row / column (a whole column, the whole sheet) */
  private used(d: SheetData, range: Range): Range {
    return { r0: range.r0, c0: range.c0, r1: Math.min(range.r1, Math.max(d.maxRow, d.rows.length - 1)), c1: Math.min(range.c1, d.maxCol) }
  }

  /**
   * The block of filled cells `range` is part of: grown on every side while the row / column next to it (corners
   * included) holds something, as Excel takes "the data around the selection". And whether its first row reads as
   * a header: text over values that are not, or bold over rows that are not. What sorting a selection sorts: whole
   * rows of the table (not the selected cells alone, which would part them from their rows), less its header.
   */
  async region(sheet: number, range: Range): Promise<{ range: Range; header: boolean }> {
    const d = this.sheet(sheet)
    const last = Math.max(d.maxRow, d.rows.length - 1)
    const R: Range = { r0: Math.min(range.r0, Math.max(0, last)), c0: Math.min(range.c0, Math.max(0, d.maxCol)), r1: Math.min(range.r1, Math.max(0, last)), c1: Math.min(range.c1, Math.max(0, d.maxCol)) }
    R.r1 = Math.max(R.r0, R.r1)
    R.c1 = Math.max(R.c0, R.c1)
    // a sheet read from its file by pages has no rows at hand to look around in
    if (d.pages) return { range: R, header: false }
    const filled = (r: number, c0: number, c1: number) => {
      const row = d.rows[r]
      if (row) for (let k = 0; k < row.length; k += 4) if ((row[k] as number) >= c0 && (row[k] as number) <= c1 && row[k + 1] !== T_EMPTY && row[k + 2] !== '') return true
      return false
    }
    const colFilled = (c: number, r0: number, r1: number) => {
      for (let r = Math.max(0, r0); r <= Math.min(last, r1); r++) if (filled(r, c, c)) return true
      return false
    }
    for (let grew = true; grew; ) {
      grew = false
      while (R.r0 > 0 && filled(R.r0 - 1, R.c0 - 1, R.c1 + 1)) [R.r0, grew] = [R.r0 - 1, true]
      while (R.r1 < last && filled(R.r1 + 1, R.c0 - 1, R.c1 + 1)) [R.r1, grew] = [R.r1 + 1, true]
      while (R.c0 > 0 && colFilled(R.c0 - 1, R.r0 - 1, R.r1 + 1)) [R.c0, grew] = [R.c0 - 1, true]
      while (R.c1 < d.maxCol && colFilled(R.c1 + 1, R.r0 - 1, R.r1 + 1)) [R.c1, grew] = [R.c1 + 1, true]
    }
    let header = false
    if (R.r1 > R.r0) {
      const xfs = this.wb.styles.xfs
      const text = (e: Entry | null) => !!e && (e[0] === T_STR || e[0] === T_SST)
      const bold = (e: Entry | null) => Number((xfs[e?.[2] ?? 0]?.css as { fontWeight?: number | string } | undefined)?.fontWeight ?? 400) >= 600
      let labels = 0
      let overValues = false
      let allBold = true
      let belowBold = false
      for (let c = R.c0; c <= R.c1; c++) {
        const top = getEntry(d, R.r0, c)
        const below = getEntry(d, R.r0 + 1, c)
        const topFilled = !!top && top[0] !== T_EMPTY && top[1] !== ''
        if (topFilled) {
          if (!text(top) || d.formulas.has(R.r0 * MAX_COL + c)) {
            labels = -Infinity
            break
          }
          labels++
          if (!bold(top)) allBold = false
        }
        if (below && below[0] !== T_EMPTY && below[1] !== '') {
          if (!text(below) || d.formulas.has((R.r0 + 1) * MAX_COL + c)) overValues = true
          if (bold(below)) belowBold = true
        }
      }
      header = labels > 0 && (overValues || (allBold && !belowBold))
    }
    return { range: R, header }
  }

  /**
   * Clears the contents of every cell of `range` (formats stay), in one undo step. Every cell: also those of rows
   * the view has not shown yet (a whole column selected, the whole sheet).
   */
  private async clear(sheet: number, d: SheetData, range: Range): Promise<XlsxEditResult> {
    const R = this.used(d, range)
    const inputs: CellInput[] = []
    const scan = (r: number, row: unknown[] | undefined) => {
      if (!row) return
      for (let k = 0; k < row.length; k += 4) {
        const c = row[k] as number
        if (c < R.c0 || c > R.c1) continue
        if (row[k + 1] === T_EMPTY && !d.formulas.has(r * MAX_COL + c)) continue
        inputs.push({ r, c, input: '' })
      }
    }
    if (d.pages) {
      // a sheet read from its file by pages: each page read for the look
      const size = d.pages.size
      for (let p = Math.floor(R.r0 / size); p * size <= R.r1 && inputs.length <= MAX_CELLS_AT_ONCE; p++) {
        const rows = await d.pages.peek(p)
        for (let k = 0; k < rows.length; k++) if (p * size + k >= R.r0 && p * size + k <= R.r1) scan(p * size + k, rows[k])
      }
    } else for (let r = R.r0; r <= R.r1 && inputs.length <= MAX_CELLS_AT_ONCE; r++) scan(r, d.rows[r])
    if (inputs.length > MAX_CELLS_AT_ONCE) throw new Error(`Too many cells to clear at once (over ${MAX_CELLS_AT_ONCE.toLocaleString()}): clear fewer rows or columns at a time, or delete them`)
    return inputs.length ? this.setCells(sheet, inputs) : { sheet, range }
  }

  /**
   * The cells of `range` as they are now, for `paste` (values, formulas, formats), and as text for other programs
   * (the values as shown, tab separated). Up to the last cell the sheet has: a whole column selected is copied
   * whole, the rows not shown yet included.
   */
  async copy(sheet: number, range: Range): Promise<XlsxClip> {
    await this.ready()
    const d = this.sheet(sheet)
    const R = this.used(d, range)
    const h = Math.max(1, R.r1 - R.r0 + 1)
    const w = Math.max(1, R.c1 - R.c0 + 1)
    if (h * w > MAX_CELLS_AT_ONCE * 4) throw new Error(`Too many cells to copy at once (${(h * w).toLocaleString()})`)
    await this.wb.ensure(d, R.r0, R.r0 + h - 1)
    const cells: ClipCell[][] = []
    const lines: string[] = []
    let filled = 0
    for (let r0 = R.r0; r0 < R.r0 + h; r0 += 4096) {
      const r1 = Math.min(R.r0 + h, r0 + 4096)
      const shown = new Map<number, Map<number, string>>()
      for (const row of (await this.wb.block(sheet, r0, r1)).rows) shown.set(row.r, new Map(row.cells.map((c) => [c[0], c[1]])))
      for (let r = r0; r < r1; r++) {
        const line: ClipCell[] = []
        const text: string[] = []
        for (let c = R.c0; c < R.c0 + w; c++) {
          let e = getEntry(d, r, c)
          const key = r * MAX_COL + c
          const f = d.formulas.get(key)
          // a value a dynamic array formula spilled here, copied with its formula: the formula fills the cell again where it is pasted
          if (e && f === undefined && d.dynamic.size) {
            const owner = this.wb.calc.spillOwner(sheet, key)
            if (owner !== undefined && owner % MAX_COL >= R.c0 && owner % MAX_COL < R.c0 + w && Math.floor(owner / MAX_COL) >= R.r0 && Math.floor(owner / MAX_COL) < R.r0 + h) e = e[2] ? [T_EMPTY, '', e[2]] : null
          }
          // (a shared string by its text: its number means something in this workbook only)
          line.push(e || f !== undefined ? [e ? (e[0] === T_SST ? T_STR : e[0]) : T_EMPTY, e ? (e[0] === T_SST ? (this.wb.sst[e[1] as number] ?? '') : e[1]) : '', e?.[2] ?? 0, ...(f !== undefined ? (d.dynamic.has(key) ? [f, true] : [f]) : [])] as ClipCell : null)
          if (e || f !== undefined) filled++
          text.push(tsvCell(shown.get(r)?.get(c) ?? ''))
        }
        cells.push(line)
        lines.push(text.join('\t'))
      }
    }
    if (filled > MAX_CELLS_AT_ONCE) throw new Error(`Too many cells to copy at once (${filled.toLocaleString()})`)
    return { text: lines.join('\n'), sheet: this.wb.sheets[sheet].path, range: { r0: R.r0, c0: R.c0, r1: R.r0 + h - 1, c1: R.c0 + w - 1 }, cells }
  }

  /**
   * Writes copied cells with their top left at `at`, in one undo step: values as they were, formats, formulas.
   * A copied formula reads the cells at the same distance from it as before. Cells that were cut (`moved`: they
   * are cleared where they were already): their formulas read the cells they read, and whatever read the cells
   * cut reads them where they are now.
   */
  private async paste(sheet: number, d: SheetData, op: Extract<SheetOp, { op: 'paste' }>): Promise<XlsxEditResult> {
    const { r0, c0 } = op.range
    const h = op.cells.length
    const w = Math.max(0, ...op.cells.map((row) => row.length))
    if (r0 + h > MAX_ROWS || c0 + w > MAX_COL) throw new Error('The cells copied do not fit there: they would run past the last row or column of the sheet')
    if (h * w > MAX_CELLS_AT_ONCE * 4) throw new Error(`Too many cells to paste at once (${(h * w).toLocaleString()})`)
    await this.wb.ensure(d, r0, r0 + h - 1)
    const dr = r0 - op.from.r0
    const dc = c0 - op.from.c0
    const here = this.wb.sheets[sheet].name
    const src = this.wb.sheets.find((x) => x.path === op.from.sheet)
    const move: MoveOp | undefined = op.moved && src ? { from: src.name, to: here, r0: op.from.r0, c0: op.from.c0, r1: op.from.r0 + h - 1, c1: op.from.c0 + w - 1, dr, dc } : undefined
    const styles = this.wb.styles.xfs.length
    const changes: CellChange[] = []
    for (let i = 0; i < h; i++) {
      for (let j = 0; j < w; j++) {
        const cell = op.cells[i][j] ?? null
        const r = r0 + i
        const c = c0 + j
        const key = r * MAX_COL + c
        const prev = getEntry(d, r, c)
        const prevF = d.formulas.get(key)
        if (!cell && !prev && prevF === undefined) continue
        const f = cell?.[3]
        const nextF = f === undefined ? undefined : move ? moveRefsInFormula(f, move, here, move.from) : translateFormula(f, dr, dc)
        // (a format this workbook does not have: one of another document, or a broken operation)
        const st = cell && Number.isInteger(cell[2]) && cell[2] >= 0 && cell[2] < styles ? cell[2] : 0
        const next: Entry | null = !cell ? null : nextF !== undefined ? [T_STR, '=' + nextF, st] : clipEntry(cell, st)
        // (a formula copied is a dynamic array formula when the one it was copied from is)
        changes.push(nextF !== undefined ? { key, prev, prevF, next, nextF, nextD: cell?.[4] === true } : { key, prev, prevF, next, nextF })
      }
    }
    // what read the cells cut reads them here (the formulas pasted have theirs already)
    const others: NonNullable<Change['others']> = []
    if (move) {
      const pasted = new Set(changes.map((ch) => ch.key))
      for (const [i, od] of this.wb.sheetsData) {
        const name = this.wb.sheets[i]?.name
        if (name === undefined) continue
        for (const [key, f] of od.formulas) {
          if (od === d && pasted.has(key)) continue
          const g = moveRefsInFormula(f, move, name)
          if (g !== f) others.push({ sheet: i, key, prev: f, next: g })
        }
      }
      for (const o of others) setFormula(this.wb.sheetsData.get(o.sheet)!, o.key, o.next)
    }
    this.apply(d, changes, 'next')
    const res = this.record(sheet, changes, { r0, c0, r1: r0 + h - 1, c1: c0 + w - 1 })
    if (others.length) {
      this.undoStack[this.undoStack.length - 1].others = others
      res.recalc = this.recalcAll()
    }
    return res
  }

  /** replaces `query` in matching cells (one undo step); `at` limits it to one cell */
  async replace(sheet: number, query: string, by: string, opts: FindOptions = {}, at?: { r: number; c: number }): Promise<XlsxEditResult | null> {
    await this.ready()
    const d = this.sheet(sheet)
    const re = new RegExp(opts.whole ? `^${escRe(query)}$` : escRe(query), opts.matchCase ? 'g' : 'gi')
    const inputs: CellInput[] = []
    const cells = at ? [at] : await this.wb.find(sheet, query, opts, 1e9)
    for (const { r, c } of cells) {
      const f = d.formulas.get(r * MAX_COL + c)
      const raw = opts.formulas && f ? '=' + f : (await this.wb.cell(sheet, r, c))?.value
      if (raw === undefined || (f && !opts.formulas)) continue
      // (the text to put, as it is: "$&" and "$1" mean nothing here)
      const next = raw.replace(re, () => by)
      if (next !== raw) inputs.push({ r, c, input: next })
    }
    return inputs.length ? this.setCells(sheet, inputs) : null
  }

  private fill(sheet: number, d: SheetData, range: Range, dir: 'down' | 'right'): XlsxEditResult {
    expandShared(d)
    const changes: CellChange[] = []
    for (let r = range.r0; r <= range.r1; r++) {
      for (let c = range.c0; c <= range.c1; c++) {
        const sr = dir === 'down' ? range.r0 : r
        const sc = dir === 'right' ? range.c0 : c
        if (sr === r && sc === c) continue
        // a cell under a merged one is not shown: nothing is filled into it
        if (d.merges.some((m) => m.r0 <= r && r <= m.r1 && m.c0 <= c && c <= m.c1 && (m.r0 !== r || m.c0 !== c))) continue
        const key = r * MAX_COL + c
        const src = getEntry(d, sr, sc)
        const sf = d.formulas.get(sr * MAX_COL + sc)
        const nf = sf ? translateFormula(sf, r - sr, c - sc) : undefined
        const ch: CellChange = { key, prev: getEntry(d, r, c), prevF: d.formulas.get(key), next: src ? [src[0], nf ? '=' + nf : src[1], src[2]] : null, nextF: nf }
        if (nf) ch.nextD = d.dynamic.has(sr * MAX_COL + sc)
        changes.push(ch)
      }
    }
    this.apply(d, changes, 'next')
    return this.record(sheet, changes, range)
  }

  /**
   * Sorts the rows of `range` by column `col`, in Excel's order: numbers, then text (as it compares in formulas: by
   * letters, not by character codes; "item10" before "item2"), then FALSE and TRUE, then errors; cells without
   * anything last, in either direction. The cells are moved (see `Change.sort`), formulas reading their own row
   * with them, comments with their cells.
   */
  private sort(sheet: number, d: SheetData, range: Range, col: number, desc: boolean, given?: number[]): XlsxEditResult {
    expandShared(d)
    // (Excel refuses too: "all the merged cells need to be the same size")
    if (d.merges.some((m) => m.r1 >= range.r0 && m.r0 <= range.r1 && m.c1 >= range.c0 && m.c0 <= range.c1)) {
      throw new Error('This range has merged cells: unmerge them to sort it.')
    }
    // (Excel refuses too: the cells a formula fills are not cells to move, and the formula moved would fill others)
    if (d.dynamic.size) {
      for (const key of d.dynamic) {
        const rg = d.arrays.get(key) ?? { r0: Math.floor(key / MAX_COL), c0: key % MAX_COL, r1: Math.floor(key / MAX_COL), c1: key % MAX_COL }
        if (rg.r1 >= range.r0 && rg.r0 <= range.r1 && rg.c1 >= range.c0 && rg.c0 <= range.c1) {
          throw new Error('This range has a formula that fills several cells (a dynamic array): it cannot be sorted. Sort the cells the formula reads, or use SORT.')
        }
      }
    }
    const n = range.r1 - range.r0 + 1
    const rank = new Uint8Array(n)
    const vals: Value[] = new Array(n)
    // (an order given is the sort already made, elsewhere: the rows are moved as it says)
    const fixed = given && isOrder(given, n) ? given.slice() : undefined
    for (let i = 0; i < n && !fixed; i++) {
      const e = getEntry(d, range.r0 + i, col)
      const t = e ? e[0] : T_EMPTY
      const v = e ? e[1] : ''
      if (t === T_EMPTY || v === '' || v === undefined) rank[i] = 4
      else if (t === T_NUM) [rank[i], vals[i]] = [0, v as number]
      else if (t === T_BOOL) [rank[i], vals[i]] = [2, !!v]
      else if (t === T_ERR) rank[i] = 3
      else [rank[i], vals[i]] = [1, t === T_SST ? (this.wb.sst[v as number] ?? '') : String(v)]
      if (rank[i] === 1 && vals[i] === '') rank[i] = 4
    }
    const order = fixed ?? Array.from({ length: n }, (_, i) => i)
    if (!fixed)
      order.sort((x, y) => {
        const a = rank[x]
        const b = rank[y]
        if (a !== b) return a === 4 ? 1 : b === 4 ? -1 : desc ? b - a : a - b
        if (a >= 3) return 0
        const k = compare(vals[x], vals[y])
        return desc ? -k : k
      })
    const sorted = n <= SORT_ORDER_MAX ? { sorted: order } : {}
    if (order.every((x, i) => x === i)) return { sheet, range, ...sorted }
    // the formulas of the range as they are, and as they are in the rows they go to
    const before: [number, string][] = []
    const after: [number, string][] = []
    const at = inverse(order)
    for (let i = 0; i < n; i++) {
      const row = d.rows[range.r0 + i]
      if (!row) continue
      for (let k = colAt(row, range.c0); k < row.length && (row[k] as number) <= range.c1; k += 4) {
        const c = row[k] as number
        const f = d.formulas.get((range.r0 + i) * MAX_COL + c)
        if (f === undefined) continue
        before.push([(range.r0 + i) * MAX_COL + c, f])
        after.push([(range.r0 + at[i]) * MAX_COL + c, translateFormula(f, at[i] - i, 0)])
      }
    }
    const cm = this.sortComments(this.wb.sheets[sheet].path, range, at)
    this.moveRows(d, range, order, before, after)
    const ch: Change = { sheet, cells: [], range, sort: { order, before, after }, cm }
    this.undoStack.push(ch)
    if (this.undoStack.length > 200) this.undoStack.shift()
    this.redoStack = []
    if (before.length) this.formulaTouched = true
    return { sheet, range, recalc: this.recalcAll(), ...sorted }
  }

  /**
   * Row `i` of `range` takes the cells row `order[i]` has in the columns of the range (the cells beside them stay);
   * the formulas of those cells are `drop` before and `put` after.
   */
  private moveRows(d: SheetData, range: Range, order: number[], drop: [number, string][], put: [number, string][]) {
    const { r0, c0, c1 } = range
    // the cells of each row in the columns of the range, as they are
    const cut = (row: unknown[] | undefined): [number, number] => {
      if (!row) return [0, 0]
      const a = colAt(row, c0)
      return [a, colAt(row, c1 + 1)]
    }
    const taken: unknown[][] = order.map((_, i) => {
      const row = d.rows[r0 + i]
      const [a, b] = cut(row)
      return row ? row.slice(a, b) : []
    })
    for (let i = 0; i < order.length; i++) {
      const r = r0 + i
      if (d.pages && !d.pages.has(r)) throw new Error('Row not in memory')
      d.pages?.pin(r)
      const row = d.rows[r]
      const [a, b] = cut(row)
      const next = row ? [...row.slice(0, a), ...taken[order[i]], ...row.slice(b)] : taken[order[i]].slice()
      d.rows[r] = next.length ? next : undefined
      d.rewrite.add(r)
    }
    for (const [key] of drop) d.formulas.delete(key)
    for (const [key, f] of put) {
      d.formulas.set(key, f)
      // (a formula typed and not computed yet holds its own text: the text it has now)
      const row = d.rows[Math.floor(key / MAX_COL)]
      const k = row ? colAt(row, key % MAX_COL) : 0
      if (row && row[k] === key % MAX_COL && row[k + 1] === T_STR && String(row[k + 2]).startsWith('=')) row[k + 2] = '=' + f
    }
  }

  /** the comments on the cells a sort moves go with them (`at[i]`: where row `i` of the range goes) */
  private sortComments(path: string, range: Range, at: number[]): Change['cm'] {
    const store = this.wb.comments
    const before: [string, DocComment | null][] = []
    const after: [string, DocComment | null][] = []
    for (const t of store.threads()) {
      const a = t.root.at
      if (!a || !('sheet' in a) || a.sheet !== path || a.r < range.r0 || a.r > range.r1 || a.c < range.c0 || a.c > range.c1) continue
      const r = range.r0 + at[a.r - range.r0]
      if (r === a.r) continue
      const moved = { ...t.root, at: { ...a, r } }
      before.push([t.root.id, t.root])
      after.push([t.root.id, moved])
    }
    for (const [id, c] of after) store.set(id, c)
    return before.length ? { before, after } : undefined
  }

  // ---------------------------------------------------------------- workbook (sheet list)

  async bookOp(op: BookOp): Promise<XlsxEditResult> {
    if (this.wb.lockStructure) throw new Error('The structure of this workbook is locked (protected): sheets cannot be added, renamed, deleted or moved. Unprotect the workbook (in Excel) to change it.')
    await this.ready()
    const pkg = this.wb.pkg
    const nodes = parseRaw(await pkg.text(this.wb.mainPath))
    const root = rootEl(nodes)!
    const P = prefixOf(root.q)
    const sheetsEl = kidOf(root, 'sheets')!
    // every sheet the workbook lists: among them the chart, dialog and macro sheets, which `sheets` does not hold
    const listed = kidsOf(sheetsEl, 'sheet')
    const rels = await pkg.rels(this.wb.mainPath)
    const sheets = this.wb.sheets
    /** the workbook's entry of worksheet `i` */
    const entry = (i: number): RNode => {
      const path = sheets[i]?.path
      const e = path === undefined ? undefined : listed.find((x) => rels.get(getAttr(x, 'id', true) ?? '')?.target === path)
      if (!e) throw new Error(`No sheet #${i}`)
      return e
    }
    const remap = (order: number[]) => {
      // order[newIndex] = oldIndex
      const data = new Map(this.wb.sheetsData)
      this.wb.sheetsData.clear()
      order.forEach((old, i) => {
        const d = data.get(old)
        if (d) this.wb.sheetsData.set(i, d)
      })
      const next = order.map((old, i) => ({ ...sheets[old], index: i }))
      sheets.splice(0, sheets.length, ...next)
    }
    const names = kidsOf(kidOf(root, 'definedNames'), 'definedName')
    /** rewrites the formulas of every sheet and of the defined names */
    const eachFormula = (fn: (f: string) => string) => {
      for (const d of this.wb.sheetsData.values()) {
        const edits: [number, string][] = []
        for (const [k, f] of d.formulas) {
          const g = fn(f)
          if (g !== f) edits.push([k, g])
        }
        for (const [k, g] of edits) setFormula(d, k, g)
        if (edits.length) this.formulaTouched = true
      }
      for (const n of names) {
        const f = textContent(n)
        const g = fn(f)
        if (g !== f) n.c = [escText(g)]
      }
    }
    let recalc: number[] | undefined
    switch (op.op) {
      case 'add': {
        const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData/></worksheet>'
        const path = pkg.freeName('xl/worksheets', 'sheet', 'xml')
        this.newSheets.set(path, xml)
        pkg.setPart(path, xml)
        await pkg.setContentType(path, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml')
        const rid = await pkg.addRel(this.wb.mainPath, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet', path)
        const ids = listed.map((e) => Number(getAttr(e, 'sheetId') ?? 0))
        // no two sheets of the workbook by one name, the ones not shown here (chart sheets) included
        const taken = new Set(listed.map((e) => (getAttr(e, 'name') ?? '').toLowerCase()))
        let name = sheetName(op.name ?? '') || `Sheet${sheets.length + 1}`
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = op.name ? `${sheetName(op.name).slice(0, 31 - String(n).length - 1)}_${n}` : `Sheet${sheets.length + n}`
        const node = el(P + 'sheet', { name, sheetId: String(Math.max(0, ...ids) + 1), ...relIdAttrs(root, 'id', rid) })
        const after = Math.max(-1, Math.min(op.after ?? sheets.length - 1, sheets.length - 1))
        // right after the worksheet it follows (chart sheets may stand between the worksheets of the list)
        const at = !sheets.length ? sheetsEl.c.length : after < 0 ? sheetsEl.c.indexOf(entry(0)) : sheetsEl.c.indexOf(entry(after)) + 1
        sheetsEl.c.splice(at, 0, node)
        sheetsEl.self = false
        const info = { name, index: after + 1, path, hidden: false }
        const order = sheets.map((_, i) => i)
        sheets.push({ ...info, index: sheets.length })
        order.splice(after + 1, 0, sheets.length - 1)
        remap(order)
        break
      }
      case 'duplicate': {
        const src = sheets[op.index]
        if (!src) throw new Error(`No sheet #${op.index}`)
        if (this.wb.loaders.has(src.path)) throw new Error('A sheet that is still being imported cannot be duplicated yet')
        // the sheet as it is now: its XML with the edits made here written in (what a save would write)
        const sd = this.wb.sheetsData.get(op.index)
        if (sd?.loading && !sd.done) await sd.loading
        // (its dynamic array formulas name a record of the workbook's metadata: there before they are written)
        if (sd?.dynamic.size) await this.linkDynamic(true)
        const source = sd && needsWrite(sd) ? await new Response(this.rewrite(src.path, sd)).text() : (this.newSheets.get(src.path) ?? (await pkg.text(src.path)))
        const taken = new Set(listed.map((e) => (getAttr(e, 'name') ?? '').toLowerCase()))
        let name = ''
        for (let n = 2; !name || taken.has(name.toLowerCase()); n++) name = `${src.name.slice(0, 31 - ` (${n})`.length)} (${n})`
        const xml = duplicateXml(source, src.name, name)
        const path = pkg.freeName('xl/worksheets', 'sheet', 'xml')
        this.newSheets.set(path, xml)
        pkg.setPart(path, xml)
        await pkg.setContentType(path, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml')
        const rid = await pkg.addRel(this.wb.mainPath, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet', path)
        const ids = listed.map((e) => Number(getAttr(e, 'sheetId') ?? 0))
        const node = el(P + 'sheet', { name, sheetId: String(Math.max(0, ...ids) + 1), ...relIdAttrs(root, 'id', rid) })
        const at = sheetsEl.c.indexOf(entry(op.index)) + 1
        sheetsEl.c.splice(at, 0, node)
        sheetsEl.self = false
        const order = sheets.map((_, i) => i)
        sheets.push({ name, index: sheets.length, path, hidden: false })
        order.splice(op.index + 1, 0, sheets.length - 1)
        remap(order)
        break
      }
      case 'rename': {
        const old = sheets[op.index]
        const name = sheetName(op.name)
        if (!old || !name) throw new Error('Invalid sheet name')
        const node = entry(op.index)
        if (listed.some((e) => e !== node && (getAttr(e, 'name') ?? '').toLowerCase() === name.toLowerCase())) throw new Error('Invalid sheet name')
        setAttr(node, 'name', name)
        // what reads the sheet names it as it is called now: the formulas, and the defined names (print areas, named ranges)
        eachFormula((f) => renameSheetInFormula(f, old.name, name))
        await renameInCharts(pkg, old.name, name)
        // validations and conditional formats naming it: the sheets that hold some are written again, with its name of now
        for (const s of sheets) {
          const d = this.wb.sheetsData.get(s.index)
          if (!d) continue
          d.renames.push([old.name, name])
          if (!this.newSheets.has(s.path) && !needsWrite(d) && (await sheetTail(pkg, s.path).catch(() => '')).toLowerCase().includes(old.name.toLowerCase())) d.formulaChanged = true
        }
        old.name = name
        break
      }
      case 'delete': {
        if (sheets.length <= 1) throw new Error('A workbook needs at least one sheet')
        const s = sheets[op.index]
        if (s && !s.hidden && !sheets.some((x, i) => i !== op.index && !x.hidden)) throw new Error('A workbook needs at least one sheet that is not hidden')
        const node = entry(op.index)
        // its comments go with it
        for (const t of this.wb.comments.threads()) {
          const a = t.root.at
          if (!a || !('sheet' in a) || a.sheet !== s.path) continue
          for (const r of t.replies) this.wb.comments.set(r.id, null)
          this.wb.comments.set(t.root.id, null)
        }
        sheetsEl.c.splice(sheetsEl.c.indexOf(node), 1)
        pkg.setPart(s.path, null)
        if (pkg.has(relsPathFor(s.path))) pkg.setPart(relsPathFor(s.path), null)
        await pkg.removeRelsTo(this.wb.mainPath, s.path)
        await pkg.setContentType(s.path, null)
        this.wb.sheetsData.delete(op.index)
        remap(sheets.map((_, i) => i).filter((i) => i !== op.index))
        // what read the sheet reads #REF! from now on, as Excel has it: a reference to a sheet the workbook does not have is not a formula it opens
        eachFormula((f) => dropSheetInFormula(f, s.name))
        // the calculation chain lists its cells: it goes at the next save
        this.formulaTouched = true
        this.wb.calc.invalidate()
        recalc = this.recalcAll()
        break
      }
      case 'move': {
        const node = entry(op.from)
        sheetsEl.c.splice(sheetsEl.c.indexOf(node), 1)
        // before the worksheet that is at `to` once it is taken out, or after the last one
        const rest = sheets.filter((_, i) => i !== op.from).map((x) => listed.find((e) => rels.get(getAttr(e, 'id', true) ?? '')?.target === x.path)!)
        const to = Math.max(0, Math.min(op.to, rest.length))
        sheetsEl.c.splice(to < rest.length ? sheetsEl.c.indexOf(rest[to]) : rest.length ? sheetsEl.c.indexOf(rest[rest.length - 1]) + 1 : sheetsEl.c.length, 0, node)
        const order = sheets.map((_, i) => i)
        order.splice(op.from, 1)
        order.splice(to, 0, op.from)
        remap(order)
        break
      }
    }
    relist(root, listed)
    pkg.setPart(this.wb.mainPath, serialize(nodes))
    this.bookChanged = true
    this.undoStack = []
    this.redoStack = []
    // sheets are known to the formulas by their place in the list and by their name: both changed
    this.wb.calc.invalidate()
    // (so are the names local to a sheet, and the tables: each is of a sheet)
    await this.wb.loadNames().catch(() => {})
    return { sheet: 0, range: { r0: 0, c0: 0, r1: 0, c1: 0 }, sheets: sheets.map((s) => ({ ...s })), ...(recalc ? { recalc } : {}) }
  }

  private bookChanged = false
  /** XML of sheets created in this session (no original to stream from) */
  private newSheets = new Map<string, string>()

  /**
   * Adds a sheet after `after` holding the rows of a delimited text file (CSV / TSV): they stream into the sheet
   * when it is loaded, like a sheet's XML does. `name` defaults to the file's name.
   */
  async importText(after: number, imp: DelimitedImport, name?: string): Promise<XlsxEditResult> {
    const base = sheetName((name ?? imp.source.name ?? '').replace(/\.[^./\\]+$/, '')) || 'Imported'
    const res = await this.bookOp({ op: 'add', name: base, after })
    this.wb.loaders.set(this.wb.sheets[after + 1].path, (d, report) => loadDelimited(d, imp, report))
    return res
  }

  // ---------------------------------------------------------------- save

  async save(): Promise<Blob> {
    // rows still to come from an import are in the model before the sheets are written
    await this.wb.loadPending()
    const pkg = this.wb.pkg
    let any = false
    await this.linkDynamic()
    for (const [index, d] of this.wb.sheetsData) {
      if (d.maxRow >= MAX_ROWS) {
        throw new Error(
          `Sheet “${this.wb.sheets[index].name}” has ${(d.maxRow + 1).toLocaleString()} rows: an Excel workbook holds at most ${MAX_ROWS.toLocaleString()}. Save the sheet as CSV instead.`,
        )
      }
      if (!needsWrite(d)) continue
      any = true
      const info = this.wb.sheets[index]
      pkg.setPart(info.path, () => this.rewrite(info.path, d))
    }
    if (any) {
      // stale cached values / calc chain: let Excel recalculate on open
      const wbNodes = parseRaw(await pkg.text(this.wb.mainPath))
      const root = rootEl(wbNodes)!
      const P = prefixOf(root.q)
      const calc = clone(kidOf(root, 'calcPr') ?? el(P + 'calcPr'))
      setAttr(calc, 'fullCalcOnLoad', '1')
      setOrdered(root, calc, 'calcPr', WB_ORDER)
      pkg.setPart(this.wb.mainPath, serialize(wbNodes))
    }
    // the calculation chain names formula cells that may be gone (Excel repairs a file whose chain does): it builds it again
    const chain = relOfType(this.wb.rels, 'calcChain')
    if (chain && this.formulaTouched && pkg.has(chain.target)) {
      pkg.setPart(chain.target, null)
      await pkg.removeRelsTo(this.wb.mainPath, chain.target)
      await pkg.setContentType(chain.target, null)
    }
    // after the sheets: a sheet given comments here links its drawing of them
    if (this.wb.comments.dirty) await writeXlsxComments(pkg, this.wb.mainPath, this.wb.comments, this.wb.sheets)
    await this.linkStyles()
    return pkg.save(XLSX_MIME)
  }

  /**
   * Dynamic array formulas are told from the array formulas of old by a record of the workbook's metadata part,
   * which their cells name (`cm`): the part gets that record (and is made, when the workbook has none) before the
   * sheets are written.
   */
  private async linkDynamic(now = false): Promise<void> {
    const wb = this.wb
    if (wb.dynamicRecord || (!now && ![...wb.sheetsData.values()].some((d) => d.dynamic.size && needsWrite(d)))) return
    if (wb.dynamicCm.size) {
      wb.dynamicRecord = Math.min(...wb.dynamicCm)
      return
    }
    const pkg = wb.pkg
    const TYPE = 'XLDAPR'
    const XDA = 'http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray'
    const type = `<metadataType name="${TYPE}" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1" cellMeta="1"/>`
    const future = `<futureMetadata name="${TYPE}" count="1"><bk><extLst><ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}"><xda:dynamicArrayProperties xmlns:xda="${XDA}" fDynamic="1" fCollapsed="0"/></ext></extLst></bk></futureMetadata>`
    const rel = relOfType(await pkg.rels(wb.mainPath), 'sheetMetadata')
    if (rel && pkg.has(rel.target)) {
      // a metadata part without the record (it holds others: the pictures in cells…): the record is added to it
      const nodes = parseRaw(await pkg.text(rel.target))
      const root = rootEl(nodes)
      if (!root) return
      const P = prefixOf(root.q)
      const section = (name: string, before: string[]): RNode => {
        let n = kidOf(root, name)
        if (!n) {
          n = el(P + name, { count: '0' })
          const at = root.c.findIndex((c) => isNode(c) && before.includes(local(c.q)))
          root.c.splice(at < 0 ? root.c.length : at, 0, n)
          root.self = false
        }
        return n
      }
      const add = (n: RNode, xml: string) => {
        n.c.push(...parseRaw(P ? xml.replace(/<(\/?)(?!xda:)/g, `<$1${P}`) : xml))
        n.self = false
        const count = kidsOf(n).length
        setAttr(n, 'count', String(count))
        return count
      }
      const types = section('metadataTypes', ['metadataStrings', 'mdxMetadata', 'futureMetadata', 'cellMetadata', 'valueMetadata', 'extLst'])
      const t = add(types, type)
      const at = root.c.findIndex((c) => isNode(c) && ['cellMetadata', 'valueMetadata', 'extLst'].includes(local(c.q)))
      root.c.splice(at < 0 ? root.c.length : at, 0, ...parseRaw(P ? future.replace(/<(\/?)(?!xda:)/g, `<$1${P}`) : future))
      wb.dynamicRecord = add(section('cellMetadata', ['valueMetadata', 'extLst']), `<bk><rc t="${t}" v="0"/></bk>`)
      pkg.setPart(rel.target, serialize(nodes))
    } else {
      const path = 'xl/metadata.xml'
      pkg.setPart(
        path,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><metadataTypes count="1">${type}</metadataTypes>${future}<cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata></metadata>`,
      )
      if (!rel) await pkg.addRel(wb.mainPath, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata', path)
      await pkg.setContentType(path, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml')
      wb.dynamicRecord = 1
    }
    wb.dynamicCm.add(wb.dynamicRecord)
  }

  /**
   * A workbook that came without a styles part gets one when it is formatted: the workbook has to name it
   * (relationship + content type), or nothing that opens the saved file finds its formatting. Also links the part a
   * version before 0.14.2 left unnamed.
   */
  private async linkStyles(): Promise<void> {
    const pkg = this.wb.pkg
    if (relOfType(await pkg.rels(this.wb.mainPath), 'styles')) return
    const path = this.stylesPath ?? DEFAULT_STYLES_PART
    if (!pkg.has(path)) return
    await pkg.addRel(this.wb.mainPath, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles', path)
    await pkg.setContentType(path, 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml')
  }

  /** Streams the original sheet XML, patching only rows that contain edits. */
  private rewrite(path: string, d: SheetData): ReadableStream<Uint8Array> {
    const pkg = this.wb.pkg
    const wb = this.wb
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    // shared formula groups whose master was overwritten → dependents get explicit formulas
    const fix = new Map<number, string>()
    const broken = new Set<number>()
    for (const [si, g] of d.shared) if (d.edited.has(g.master)) broken.add(si)
    if (broken.size) {
      for (const [key, si] of d.depOf) {
        if (!broken.has(si) || d.edited.has(key)) continue
        const g = d.shared.get(si)!
        const dr = Math.floor(key / MAX_COL) - Math.floor(g.master / MAX_COL)
        const dc = (key % MAX_COL) - (g.master % MAX_COL)
        fix.set(key, translateFormula(g.text, dr, dc))
      }
    }
    const rowCols = new Map<number, Set<number>>()
    for (const r of d.dirtyRows) if (!rowCols.has(r)) rowCols.set(r, new Set())
    for (const r of d.rewrite) if (!rowCols.has(r)) rowCols.set(r, new Set())
    // the cells edited, those whose shared formula lost its first cell, and those a formula gave another value
    for (const key of [...d.edited, ...fix.keys(), ...d.revalued]) {
      const r = Math.floor(key / MAX_COL)
      let s = rowCols.get(r)
      if (!s) rowCols.set(r, (s = new Set()))
      s.add(key % MAX_COL)
    }
    const rows = [...rowCols.keys()].sort((a, b) => a - b)
    const enc = new TextEncoder()
    return new ReadableStream<Uint8Array>({
      async start(ctrl) {
        const rw = new RowPatcher(rows, rowCols, d, fix, wb, wb.sheets.find((s) => s.path === path)?.name ?? '')
        const base = self.newSheets.get(path)
        const reader = (base !== undefined ? new Blob([base]).stream() : await pkg.zip.stream(path)).getReader()
        const dec = new TextDecoder()
        for (;;) {
          const { done, value } = await reader.read()
          const text = done ? dec.decode() : dec.decode(value, { stream: true })
          for (const part of await rw.push(text, done)) if (part) ctrl.enqueue(enc.encode(part))
          if (done) break
        }
        ctrl.close()
      },
    })
  }
}

/**
 * A name a sheet can have: at most 31 characters, none of \ / ? * [ ] :, and no apostrophe at either end (Excel
 * refuses those; a name ending with one cannot be quoted in a formula, and other programs drop the sheet).
 */
function sheetName(raw: string): string {
  return raw.trim().slice(0, 31).replace(/[\\/?*[\]:]/g, '_').replace(/^'|'$/g, '_').trim()
}

/**
 * The XML of a copy of a sheet: it keeps the cells, formats, widths and merges, and formulas that name the sheet
 * itself name the copy. What a relationship of the original leads to (drawings, comments, tables, links) is left out:
 * the copy has no relationships of its own, and a reference to one that is not there makes the file unreadable.
 */
function duplicateXml(xml: string, from: string, to: string): string {
  const unesc = (s: string) => (s.indexOf('&') < 0 ? s : decodeEntities(s))
  return xml
    .replace(/<((?:\w+:)?)(drawing|legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|tableParts)\b(?:[^>]*\/>|[\s\S]*?<\/\1\2>)/g, '')
    .replace(/<(?:\w+:)?hyperlink\b[^>]*\br:id="[^"]*"[^>]*\/>/g, '')
    .replace(/(<(?:\w+:)?sheetView\b[^>]*?)\s+tabSelected="[^"]*"/, '$1')
    .replace(/(<(?:\w+:)?(?:worksheet|sheetPr)\b[^>]*?)\s+(?:codeName|xr:uid)="[^"]*"/g, '$1')
    .replace(/(<(?:\w+:)?f\b[^>]*>)([^<]+)(<\/(?:\w+:)?f>)/g, (m, a: string, f: string, b: string) => {
      const g = renameSheetInFormula(unesc(f), from, to)
      return g === unesc(f) ? m : a + escText(g) + b
    })
}

/**
 * After the list of sheets changed: `localSheetId` of the defined names, and `activeTab` / `firstSheet` of the
 * views, count the sheets of the list (`listed`: as it was). They follow their sheet to its new place; a name local
 * to a sheet that is gone goes with it, a view showing it shows the sheet that took its place.
 */
function relist(root: RNode, listed: RNode[]) {
  const now = kidsOf(kidOf(root, 'sheets'), 'sheet')
  const to = (old: number) => now.indexOf(listed[old])
  const dn = kidOf(root, 'definedNames')
  if (dn) {
    dn.c = dn.c.filter((c) => {
      if (!isNode(c)) return true
      const id = getAttr(c, 'localSheetId')
      if (id === undefined) return true
      const i = to(Number(id))
      if (i < 0) return false
      setAttr(c, 'localSheetId', String(i))
      return true
    })
    if (!kidsOf(dn).length) root.c.splice(root.c.indexOf(dn), 1)
  }
  const shown = (i: number) => {
    const st = now[i] && getAttr(now[i], 'state')
    return !!now[i] && (!st || st === 'visible')
  }
  for (const v of kidsOf(kidOf(root, 'bookViews'), 'workbookView')) {
    for (const a of ['activeTab', 'firstSheet']) {
      const old = getAttr(v, a)
      if (old === undefined) continue
      let i = to(Number(old))
      if (i < 0) {
        i = Math.max(0, Math.min(Number(old) || 0, now.length - 1))
        // a sheet that shows, the nearest: first the ones after
        const near = [...now.keys()].filter(shown).sort((x, y) => Math.abs(x - i) - Math.abs(y - i) || y - x)[0]
        if (near !== undefined) i = near
      }
      setAttr(v, a, String(i))
    }
  }
}

/** attributes a rewritten <row> / <col> keeps from the file */
function attrsXml(x: Record<string, string> | undefined): string {
  let out = ''
  if (x) for (const k in x) out += ` ${k}="${escAttr(x[k])}"`
  return out
}

/** text as ST_Xstring (ECMA-376 §22.4.2.4): a literal _xHHHH_ is escaped, what XML cannot hold is written _xHHHH_ (reading decodes both) */
function xText(s: string): string {
  return s.replace(/_(?=x[0-9A-Fa-f]{4}_)/g, '_x005F_').replace(/[\u0000-\u0008\u000b-\u001f\uFFFE\uFFFF]/g, (ch) => `_x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`)
}

/** the name of the table a cell is in (a structured reference without a table name is of that one) */
function tableAt(wb: XlsxWorkbook, d: SheetData, r: number, c: number): string | undefined {
  if (!wb.tables.length) return undefined
  const index = [...wb.sheetsData].find(([, x]) => x === d)?.[0]
  const on = index === undefined ? undefined : wb.sheets[index]?.name
  return wb.tables.find((t) => t.sheet === on && r >= t.r0 && r <= t.r1 && c >= t.c0 && c <= t.c1)?.name
}

function cellXml(d: SheetData, r: number, c: number, P: string, wb: XlsxWorkbook): string {
  const key = r * MAX_COL + c
  const e = getEntry(d, r, c)
  const f = d.formulas.get(key)
  if (!e && !f) return ''
  const ref = colName(c) + (r + 1)
  let s = e?.[2] ? ` s="${e[2]}"` : ''
  if (f) {
    const [t, v] = e ?? [T_EMPTY, '']
    // a dynamic array formula is an array formula over the cells it fills (its own alone when it gives one value),
    // marked as dynamic by the metadata record its cell names
    const dynamic = d.dynamic.has(key) && wb.dynamicRecord > 0
    const arr = d.arrays.get(key) ?? (dynamic ? { r0: r, c0: c, r1: r, c1: c } : undefined)
    if (dynamic) s += ` cm="${wb.dynamicRecord}"`
    // (one cell is named alone, as Excel names it)
    const cells = arr ? `${colName(arr.c0)}${arr.r0 + 1}${arr.r1 > arr.r0 || arr.c1 > arr.c0 ? `:${colName(arr.c1)}${arr.r1 + 1}` : ''}` : ''
    const fx = `<${P}f${arr ? ` t="array" ref="${cells}"` : ''}>${escText(withFunctionPrefixes(f, f.includes('[') ? tableAt(wb, d, r, c) : undefined))}</${P}f>`
    if (t === T_NUM) return `<${P}c r="${ref}"${s}>${fx}<${P}v>${String(v)}</${P}v></${P}c>`
    if (t === T_BOOL) return `<${P}c r="${ref}"${s} t="b">${fx}<${P}v>${v ? 1 : 0}</${P}v></${P}c>`
    if (t === T_ERR) return `<${P}c r="${ref}"${s} t="e">${fx}<${P}v>${escText(String(v))}</${P}v></${P}c>`
    // (a formula typed and not computed yet holds its own text as value; a result that starts with "=" is a result)
    if (t === T_STR && String(v) !== '=' + f) return `<${P}c r="${ref}"${s} t="str">${fx}<${P}v>${escText(xText(String(v)))}</${P}v></${P}c>`
    return `<${P}c r="${ref}"${s}>${fx}</${P}c>`
  }
  const [t, v] = e!
  switch (t) {
    case T_NUM:
      return `<${P}c r="${ref}"${s}><${P}v>${String(v)}</${P}v></${P}c>`
    // a shared string stays one (its runs are rich text, which an inline string could not hold)
    case T_SST:
      return `<${P}c r="${ref}"${s} t="s"><${P}v>${String(v)}</${P}v></${P}c>`
    case T_STR:
      return `<${P}c r="${ref}"${s} t="inlineStr"><${P}is><${P}t xml:space="preserve">${escText(xText(String(v)))}</${P}t></${P}is></${P}c>`
    case T_BOOL:
      return `<${P}c r="${ref}"${s} t="b"><${P}v>${v ? 1 : 0}</${P}v></${P}c>`
    case T_ERR:
      return `<${P}c r="${ref}"${s} t="e"><${P}v>${escText(String(v))}</${P}v></${P}c>`
    case T_DATE:
      return `<${P}c r="${ref}"${s} t="d"><${P}v>${escText(String(v))}</${P}v></${P}c>`
    default:
      return `<${P}c r="${ref}"${s}/>`
  }
}

function needsWrite(d: SheetData): boolean {
  return d.edited.size > 0 || d.structural || d.dirtyCols || d.dirtyMerges || d.dirtyView || d.dirtyRows.size > 0 || d.formulaChanged || d.revalued.size > 0 || d.rewrite.size > 0
}

/** the order that puts back what `order` moved */
/** rows past which a sort does not say the order it made (the operation that carries it to a room would be megabytes) */
const SORT_ORDER_MAX = 20_000

/** whether `order` names each of `n` rows once */
function isOrder(order: unknown, n: number): order is number[] {
  if (!Array.isArray(order) || order.length !== n) return false
  const seen = new Uint8Array(n)
  for (const x of order) {
    if (!Number.isInteger(x) || x < 0 || x >= n || seen[x]) return false
    seen[x] = 1
  }
  return true
}

function inverse(order: number[]): number[] {
  const out = new Array<number>(order.length)
  for (let i = 0; i < order.length; i++) out[order[i]] = i
  return out
}

/** gives the cell of a file the value its formula has now (the formula, the format and the rest of it stay as they are) */
function revalue(cell: RNode, e: Entry | null, P: string, wb: XlsxWorkbook) {
  if (!e) return
  const [t, v] = e
  let type: string | undefined
  let text: string
  if (t === T_NUM) text = String(v)
  else if (t === T_BOOL) [type, text] = ['b', v ? '1' : '0']
  else if (t === T_ERR) [type, text] = ['e', String(v)]
  else if (t === T_SST || t === T_STR) [type, text] = ['str', t === T_SST ? (wb.sst[v as number] ?? '') : String(v)]
  else return
  setAttr(cell, 't', type)
  cell.c = cell.c.filter((c) => !(isNode(c) && (local(c.q) === 'v' || local(c.q) === 'is')))
  cell.c.splice(cell.c.findIndex((c) => isNode(c) && local(c.q) === 'f') + 1, 0, el(P + 'v', {}, [escText(text)]))
  cell.self = false
}

function layoutState(d: SheetData): LayoutState {
  return {
    merges: d.merges.map((m) => ({ ...m })),
    colInfo: d.colInfo.map((c) => ({ ...c })),
    rowAttrs: [...d.rowAttrs].map(([k, v]) => [k, { ...v }]),
    frozen: { ...d.frozen },
    gridLines: d.gridLines,
  }
}

function applyLayout(d: SheetData, l: LayoutState) {
  if (l.merges) d.merges = l.merges.map((m) => ({ ...m }))
  if (l.colInfo) d.colInfo = l.colInfo.map((c) => ({ ...c }))
  if (l.rowAttrs) {
    for (const r of d.rowAttrs.keys()) d.dirtyRows.add(r)
    d.rowAttrs = new Map(l.rowAttrs.map(([k, v]) => [k, { ...v }]))
    for (const r of d.rowAttrs.keys()) d.dirtyRows.add(r)
  }
  if (l.frozen) d.frozen = { ...l.frozen }
  if (l.gridLines !== undefined) d.gridLines = l.gridLines
  d.dirtyCols = d.dirtyMerges = d.dirtyView = true
}

/** hides / shows columns a..b (the width before hiding is kept for unhiding) */
function hideCols(d: SheetData, a: number, b: number, hidden: boolean) {
  const out: ColInfo[] = []
  const covered: [number, number][] = []
  for (const ci of d.colInfo) {
    if (ci.max < a || ci.min > b) {
      out.push(ci)
      continue
    }
    if (ci.min < a) out.push({ ...ci, max: a - 1 })
    if (ci.max > b) out.push({ ...ci, min: b + 1 })
    const lo = Math.max(ci.min, a)
    const hi = Math.min(ci.max, b)
    covered.push([lo, hi])
    if (hidden) out.push(ci.w ? { ...ci, min: lo, max: hi, w: 0, prevW: ci.w } : { ...ci, min: lo, max: hi })
    else if (ci.w) out.push({ ...ci, min: lo, max: hi })
    else {
      const { prevW, ...rest } = ci
      out.push({ ...rest, min: lo, max: hi, w: prevW || d.defaultColW })
    }
  }
  if (hidden) {
    // columns without an explicit width
    covered.sort((x, y) => x[0] - y[0])
    let at = a
    for (const [lo, hi] of [...covered, [b + 1, b + 1] as [number, number]]) {
      if (lo > at) out.push({ min: at, max: Math.min(lo - 1, b), w: 0, prevW: d.defaultColW })
      at = Math.max(at, hi + 1)
    }
  }
  d.colInfo = out.sort((x, y) => x.min - y.min)
  d.dirtyCols = true
}

function borderSides(kind: BorderKind, R: Range, r: number, c: number): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  const edge = { top: r === R.r0, bottom: r === R.r1, left: c === R.c0, right: c === R.c1 }
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    if (kind === 'all') out[side] = true
    else if (kind === 'none') out[side] = false
    else if (kind === 'outer') {
      if (edge[side]) out[side] = true
    } else if (kind === 'inner') {
      if (!edge[side]) out[side] = true
    } else if (kind === side && edge[side]) out[side] = true
  }
  return out
}

/**
 * Streaming sheet rewriter: finds <row> elements with plain string search and copies
 * everything verbatim except rows that contain edits (those are re-serialized).
 * Structural edits regenerate the whole <sheetData>; <cols>, panes and <mergeCells> are patched.
 */
class RowPatcher {
  private buf = ''
  private P = ''
  private next = 0
  private lastRow = -1
  private phase: 'head' | 'data' | 'skip' | 'tail' = 'head'
  private tail = ''

  constructor(
    private rows: number[],
    private rowCols: Map<number, Set<number>>,
    private d: SheetData,
    private fix: Map<number, string>,
    private wb: XlsxWorkbook,
    private sheetName: string,
  ) {}

  /** the columns of the cells row `r` has in the model */
  private modelCols(r: number): number[] {
    const row = this.d.rows[r]
    const cols: number[] = []
    if (row) for (let k = 0; k < row.length; k += 4) cols.push(row[k] as number)
    return cols
  }

  private newRow(r: number): string {
    const cols = this.d.rewrite.has(r) ? this.modelCols(r) : [...(this.rowCols.get(r) ?? [])].sort((a, b) => a - b)
    const cells = cols.map((c) => cellXml(this.d, r, c, this.P, this.wb)).join('')
    const attrs = this.rowAttrXml(r)
    return cells || attrs ? `<${this.P}row r="${r + 1}"${attrs}>${cells}</${this.P}row>` : ''
  }

  private rowAttrXml(r: number): string {
    const a = this.d.rowAttrs.get(r)
    if (!a) return ''
    return (a.ht !== undefined ? ` ht="${a.ht}" customHeight="1"` : '') + (a.hidden ? ' hidden="1"' : '') + attrsXml(a.x)
  }

  private before(r: number): string {
    let out = ''
    while (this.next < this.rows.length && this.rows[this.next] < r) out += this.newRow(this.rows[this.next++])
    return out
  }

  /** every row of the sheet, regenerated from the model (structural edits); a paged sheet is read page by page */
  private async *allRows(): AsyncGenerator<string> {
    const d = this.d
    let last = Math.max(d.rows.length - 1, d.maxRow)
    for (const r of d.rowAttrs.keys()) if (r > last) last = r
    const size = d.pages?.size ?? Infinity
    let chunk = ''
    for (let r = 0; r <= last; r++) {
      if (d.pages && r % size === 0) await d.pages.ensure(r, r + size - 1)
      const row = d.rows[r]
      const attrs = this.rowAttrXml(r)
      if (!row?.length && !attrs) continue
      let cells = ''
      if (row) {
        const cols: number[] = []
        for (let k = 0; k < row.length; k += 4) cols.push(row[k] as number)
        for (const c of cols.sort((a, b) => a - b)) cells += cellXml(d, r, c, this.P, this.wb)
      }
      chunk += `<${this.P}row r="${r + 1}"${attrs}>${cells}</${this.P}row>`
      if (chunk.length > 1 << 16) {
        yield chunk
        chunk = ''
      }
    }
    if (chunk) yield chunk
  }

  private colsXml(): string {
    const P = this.P
    const cols = [...this.d.colInfo].sort((a, b) => a.min - b.min)
    if (!cols.length) return ''
    const width = (c: ColInfo) => +((c.w || c.prevW || this.d.defaultColW) / 7).toFixed(4)
    return `<${P}cols>${cols.map((c) => `<${P}col min="${c.min + 1}" max="${c.max + 1}" width="${width(c)}" customWidth="1"${c.w ? '' : ' hidden="1"'}${attrsXml(c.x)}/>`).join('')}</${P}cols>`
  }

  private headFix(head: string): string {
    const d = this.d
    const P = this.P
    let h = head
    if (d.dirtyCols || d.structural) {
      const re = new RegExp(`<${P}cols\\b[\\s\\S]*?<\\/${P}cols>|<${P}cols\\s*\\/>`)
      h = re.test(h) ? h.replace(re, this.colsXml()) : h + this.colsXml()
    }
    if (d.dirtyView || d.structural) {
      const { rows, cols } = d.frozen
      const pane = rows || cols
        ? `<${P}pane${cols ? ` xSplit="${cols}"` : ''}${rows ? ` ySplit="${rows}"` : ''} topLeftCell="${colName(cols)}${rows + 1}" activePane="${rows && cols ? 'bottomRight' : rows ? 'bottomLeft' : 'topRight'}" state="frozen"/>`
        : ''
      const re = new RegExp(`<${P}sheetViews>[\\s\\S]*?<\\/${P}sheetViews>`)
      const m = re.exec(h)
      if (m) {
        const nodes = parseRaw(m[0])
        const view = kidOf(rootEl(nodes), 'sheetView')
        if (view) {
          view.c = view.c.filter((c) => !(isNode(c) && (local(c.q) === 'pane' || local(c.q) === 'selection')))
          if (pane) view.c.unshift(pane)
          setAttr(view, 'showGridLines', d.gridLines ? undefined : '0')
          view.self = view.c.length === 0
          h = h.replace(m[0], serialize(nodes))
        }
      } else if (pane || !d.gridLines) {
        const block = `<${P}sheetViews><${P}sheetView${d.gridLines ? '' : ' showGridLines="0"'} workbookViewId="0">${pane}</${P}sheetView></${P}sheetViews>`
        const at = h.search(new RegExp(`<${P}(sheetFormatPr|cols)\\b`))
        h = at >= 0 ? h.slice(0, at) + block + h.slice(at) : h + block
      }
    }
    if (d.structural) {
      h = h.replace(new RegExp(`<${P}dimension\\b[^>]*\\/>`), `<${P}dimension ref="A1:${colName(Math.max(0, d.maxCol))}${Math.max(1, d.maxRow + 1)}"/>`)
    }
    return h
  }

  private tailFix(tail: string): string {
    const d = this.d
    // filters, links, validations, conditional formats: with the rows / columns that moved, the sheets that were renamed
    tail = followSheetTail(tail, d.shifts, d.renames, this.sheetName)
    if (!d.dirtyMerges && !d.structural) return tail
    const P = this.P
    const ms = d.merges
    const xml = ms.length ? `<${P}mergeCells count="${ms.length}">${ms.map((m) => `<${P}mergeCell ref="${colName(m.c0)}${m.r0 + 1}:${colName(m.c1)}${m.r1 + 1}"/>`).join('')}</${P}mergeCells>` : ''
    const re = new RegExp(`<${P}mergeCells\\b[\\s\\S]*?<\\/${P}mergeCells>|<${P}mergeCells\\b[^>]*\\/>`)
    if (re.test(tail)) return tail.replace(re, xml)
    // after the elements that precede mergeCells in the schema: each skipped whole, with what it holds (a filter holds its sort state)
    let at = 0
    const open = /\s*<([\w.-]+:)?(sheetCalcPr|sheetProtection|protectedRanges|scenarios|autoFilter|sortState|dataConsolidate|customSheetViews)\b(?:[^>"']|"[^"]*"|'[^']*')*>/y
    for (;;) {
      open.lastIndex = at
      const m = open.exec(tail)
      if (!m) break
      at = m.index + m[0].length
      if (m[0].endsWith('/>')) continue
      const close = `</${m[1] ?? ''}${m[2]}>`
      const end = tail.indexOf(close, at)
      if (end < 0) break
      at = end + close.length
    }
    return tail.slice(0, at) + xml + tail.slice(at)
  }

  /** feeds decoded text; returns what can be written so far */
  async push(text: string, final: boolean): Promise<string[]> {
    const s = this.buf + text
    this.buf = ''
    const out: string[] = []
    if (this.phase === 'tail') {
      this.tail += s
      if (final) out.push(this.tailFix(this.tail))
      return out
    }
    let i = 0
    if (this.phase === 'head') {
      const m = /<([\w.-]+:)?sheetData(\s[^>]*)?(\/?)>/.exec(s)
      if (!m) {
        if (final) out.push(this.headFix(s))
        else this.buf = s
        return out
      }
      this.P = m[1] ?? ''
      out.push(this.headFix(s.slice(0, m.index)))
      const end = m.index + m[0].length
      if (m[3] === '/') {
        out.push(`<${this.P}sheetData>`)
        if (this.d.structural) for await (const part of this.allRows()) out.push(part)
        else {
          let rows = ''
          while (this.next < this.rows.length) rows += this.newRow(this.rows[this.next++])
          out.push(rows)
        }
        out.push(`</${this.P}sheetData>`)
        this.phase = 'tail'
        return [...out, ...(await this.push(s.slice(end), final))]
      }
      out.push(m[0])
      i = end
      this.phase = this.d.structural ? 'skip' : 'data'
    }
    const dataClose = `</${this.P}sheetData>`
    if (this.phase === 'skip') {
      const dc = s.indexOf(dataClose, i)
      if (dc < 0) {
        this.buf = s.slice(Math.max(i, s.length - dataClose.length))
        return out
      }
      for await (const part of this.allRows()) out.push(part)
      out.push(dataClose)
      this.phase = 'tail'
      return [...out, ...(await this.push(s.slice(dc + dataClose.length), final))]
    }
    const rowOpen = `<${this.P}row`
    let chunk = ''
    let dc = s.indexOf(dataClose, i)
    while (i < s.length) {
      const ro = s.indexOf(rowOpen, i)
      if (dc >= 0 && dc < i) dc = s.indexOf(dataClose, i)
      if (dc >= 0 && (ro < 0 || dc < ro)) {
        chunk += s.slice(i, dc) + this.before(Infinity) + dataClose
        out.push(chunk)
        this.phase = 'tail'
        return [...out, ...(await this.push(s.slice(dc + dataClose.length), final))]
      }
      if (ro < 0) break
      const gt = s.indexOf('>', ro)
      if (gt < 0) {
        chunk += s.slice(i, ro)
        i = ro
        break
      }
      const tag = s.slice(ro, gt + 1)
      const after = tag.charCodeAt(rowOpen.length)
      if (after !== 32 && after !== 62 && after !== 47 && after !== 9 && after !== 10 && after !== 13) {
        chunk += s.slice(i, gt + 1)
        i = gt + 1
        continue
      }
      const m = /\sr="(\d+)"/.exec(tag)
      const r = m ? Number(m[1]) - 1 : this.lastRow + 1
      this.lastRow = r
      const self = tag.endsWith('/>')
      let end: number
      if (self) end = gt + 1
      else {
        const ce = s.indexOf(`</${this.P}row>`, gt)
        if (ce < 0) {
          chunk += s.slice(i, ro)
          i = ro
          this.lastRow = r - 1
          break
        }
        end = ce + this.P.length + 6
      }
      chunk += s.slice(i, ro) + this.before(r)
      if (this.next < this.rows.length && this.rows[this.next] === r) {
        this.next++
        chunk += this.patchRow(s.slice(ro, end), r)
      } else chunk += s.slice(ro, end)
      i = end
    }
    out.push(chunk)
    this.buf = s.slice(i)
    if (final) out.push(this.buf)
    return out
  }

  private patchRow(xml: string, r: number): string {
    const nodes = parseRaw(xml)
    const row = rootEl(nodes)
    if (!row) return xml
    const P = prefixOf(row.q)
    setAttr(row, 'spans', undefined)
    if (this.d.dirtyRows.has(r)) {
      const a = this.d.rowAttrs.get(r)
      setAttr(row, 'ht', a?.ht !== undefined ? String(a.ht) : undefined)
      setAttr(row, 'customHeight', a?.ht !== undefined ? '1' : undefined)
      setAttr(row, 'hidden', a?.hidden ? '1' : undefined)
      // (the format of the row itself, when it has one)
      if (a?.x?.s !== undefined) {
        setAttr(row, 's', a.x.s)
        setAttr(row, 'customFormat', a.x.customFormat)
      }
    }
    if (this.d.rewrite.has(r)) {
      // its cells moved as wholes: every cell is written from the model, what else the row holds stays
      const cells = this.modelCols(r).map((c) => cellXml(this.d, r, c, P, this.wb)).join('')
      row.c = row.c.filter((n) => !(isNode(n) && local(n.q) === 'c'))
      if (cells) row.c.unshift(cells)
      row.self = row.c.length === 0
      return serialize(nodes)
    }
    const cols = [...(this.rowCols.get(r) ?? [])].sort((a, b) => a - b)
    // index existing cells by column (the cell read last of a column is the cell, as the reader has it)
    const pos = new Map<number, number>()
    let prev = -1
    let unordered = false
    row.c.forEach((n, i) => {
      if (!isNode(n) || local(n.q) !== 'c') return
      const ref = getAttr(n, 'r')
      const c = ref ? parseRef(ref)[1] : prev + 1
      if (c <= prev) unordered = true
      prev = Math.max(prev, c)
      pos.set(c, i)
    })
    const replacements = new Map<number, RChild>()
    const inserts: { c: number; node: string }[] = []
    for (const c of cols) {
      const key = r * MAX_COL + c
      const at = pos.get(c)
      if (this.d.edited.has(key)) {
        const xml = cellXml(this.d, r, c, P, this.wb)
        if (at !== undefined) replacements.set(at, xml)
        else if (xml) inserts.push({ c, node: xml })
      } else if (at !== undefined) {
        const cell = row.c[at] as RNode
        const f = kidOf(cell, 'f')
        if (f && this.fix.has(key)) {
          f.a = ''
          f.c = [escText(this.fix.get(key)!)]
          f.self = false
        }
        if (this.d.revalued.has(key)) revalue(cell, getEntry(this.d, r, c), P, this.wb)
      } else if (this.d.revalued.has(key)) {
        // a cell an array formula fills that the file did not have
        const xml = cellXml(this.d, r, c, P, this.wb)
        if (xml) inserts.push({ c, node: xml })
      }
    }
    for (const [i, x] of replacements) row.c[i] = x
    if (unordered) {
      // The file has the cells of this row out of column order, or a column twice (this engine wrote such rows before
      // 0.15.0): the row is written in order, each cell once, with the new ones in their place.
      const cells: [number, RChild][] = [...pos].map(([c, i]) => [c, row.c[i]])
      for (const ins of inserts) cells.push([ins.c, ins.node])
      row.c = cells.sort((a, b) => a[0] - b[0]).map((x) => x[1])
      row.self = row.c.length === 0
      return serialize(nodes)
    }
    if (inserts.length) {
      // place new cells before the first existing cell with a greater column, in column order (cells out of order are not a workbook)
      const ordered = [...pos.entries()].sort((a, b) => a[0] - b[0])
      for (const ins of inserts) {
        const after = ordered.find(([c]) => c > ins.c)
        const idx = after ? after[1] : row.c.length
        row.c.splice(idx, 0, ins.node)
        for (const o of ordered) if (o[1] >= idx) o[1]++
      }
      row.self = false
    }
    return serialize(nodes)
  }
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
