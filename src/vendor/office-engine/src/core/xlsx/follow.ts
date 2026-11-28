/**
 * What else in a workbook points at the cells of a sheet, besides formulas: filters, links, validations, conditional
 * formats and page breaks of the sheet itself; defined names (named ranges, print areas), tables, the anchors of
 * pictures and charts, and the cells a chart draws. All of it follows the cells when rows / columns are inserted or
 * deleted, and names the sheet as it is called when it is renamed.
 */
import type { OpcPackage } from '../opc'
import { escText, getAttr, isNode, kidOf, kidsOf, local, parseRaw, prefixOf, rootEl, serialize, setAttr, textContent, el, type RChild, type RNode } from '../raw'
import { renameSheetInFormula, shiftFormula } from './formula'
import { colName, MAX_COL, MAX_ROWS, parseRef } from './workbook'

/** rows or columns inserted (delta > 0) or deleted (delta < 0) at `at` */
export interface Shift {
  axis: 'row' | 'col'
  at: number
  delta: number
}

/** a part rewritten by an edit: its text before and after (undoing puts the first back) */
export interface PartEdit {
  path: string
  prev: string
  next: string
}

/** index after the shift; null when it is among those deleted */
function shiftIndex(x: number, s: Shift): number | null {
  if (s.delta >= 0) return x >= s.at ? x + s.delta : x
  return x < s.at ? x : x < s.at - s.delta ? null : x + s.delta
}

/** inclusive span after the shift (an insert inside it widens it, a delete narrows it); null when all of it is deleted */
function shiftSpan(a: number, b: number, s: Shift, max: number): [number, number] | null {
  if (s.delta >= 0) {
    if (a >= s.at) a += s.delta
    if (b >= s.at) b += s.delta
    return a > max ? null : [a, Math.min(b, max)]
  }
  const end = s.at - s.delta
  if (b < s.at) return [a, b]
  if (a >= end) return [a + s.delta, b + s.delta]
  const na = a < s.at ? a : s.at
  const nb = b < end ? s.at - 1 : b + s.delta
  return nb < na ? null : [na, nb]
}

const RANGE = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?([A-Za-z]{1,3})\$?(\d{1,7}))?$/

/** One range of a list (`A1`, `B2:C9`) after the shift; null when deleted; the text itself when it is not a range. */
function shiftRange(text: string, s: Shift): string | null {
  const m = RANGE.exec(text)
  if (!m) return text
  const [r0, c0] = parseRef(`${m[1].toUpperCase()}${m[2]}`)
  const [r1, c1] = m[3] ? parseRef(`${m[3].toUpperCase()}${m[4]}`) : [r0, c0]
  const rows = s.axis === 'row' ? shiftSpan(r0, r1, s, MAX_ROWS - 1) : ([r0, r1] as [number, number])
  const cols = s.axis === 'col' ? shiftSpan(c0, c1, s, MAX_COL - 1) : ([c0, c1] as [number, number])
  if (!rows || !cols) return null
  const a = `${colName(cols[0])}${rows[0] + 1}`
  const b = `${colName(cols[1])}${rows[1] + 1}`
  return m[3] || a !== b ? `${a}:${b}` : a
}

/** A list of ranges (`sqref`, `ref`: space separated) after the shifts; null when none is left. */
export function shiftSqref(text: string, shifts: Shift[]): string | null {
  let parts = text.trim().split(/\s+/)
  for (const s of shifts) parts = parts.flatMap((p) => shiftRange(p, s) ?? [])
  return parts.length ? parts.join(' ') : null
}

/** elements naming the cells they apply to, by the attribute that does */
const REF_ATTR: Record<string, string> = {
  autoFilter: 'ref', sortState: 'ref', sortCondition: 'ref', hyperlink: 'ref', dataValidation: 'sqref', conditionalFormatting: 'sqref', protectedRange: 'sqref',
  ignoredError: 'sqref',
}
/** lists that go when their last entry does (a list without one is not valid), and the attribute counting the entries */
const LISTS: Record<string, string | undefined> = { hyperlinks: undefined, dataValidations: 'count', protectedRanges: undefined, ignoredErrors: undefined, rowBreaks: 'count', colBreaks: 'count' }
/** elements whose text is a formula */
const FORMULAS = new Set(['formula', 'formula1', 'formula2', 'f'])

/**
 * What follows `</sheetData>` in a sheet (up to and without `</worksheet>`), after rows / columns moved (`shifts`,
 * in the order they were made) and sheets were renamed (`renames`: [old, new]).
 */
export function followSheetTail(xml: string, shifts: Shift[], renames: [string, string][], sheetName: string): string {
  if (!shifts.length && !renames.length) return xml
  // the tail ends with the tag that closes the sheet: not part of what is parsed
  const end = xml.lastIndexOf('</')
  if (end < 0) return xml
  let nodes: RChild[]
  try {
    nodes = parseRaw(xml.slice(0, end))
  } catch {
    return xml
  }
  const formula = (text: string) => {
    for (const [from, to] of renames) text = renameSheetInFormula(text, from, to)
    for (const s of shifts) text = shiftFormula(text, { sheet: sheetName, formulaSheet: sheetName, ...s })
    return text
  }
  const walk = (list: RChild[]): RChild[] => {
    const out: RChild[] = []
    for (const n of list) {
      if (!isNode(n)) {
        out.push(n)
        continue
      }
      const name = local(n.q)
      const attr = REF_ATTR[name]
      if (attr && shifts.length) {
        const ref = getAttr(n, attr)
        if (ref !== undefined) {
          const next = shiftSqref(ref, shifts)
          // its cells are gone: so is it
          if (next === null) continue
          if (next !== ref) setAttr(n, attr, next)
        }
      }
      if (name === 'hyperlink') {
        // a link to a place in the workbook names its sheet
        const to = getAttr(n, 'location')
        const next = to === undefined ? undefined : formula(to)
        if (next !== undefined && next !== to) setAttr(n, 'location', next)
      }
      if (FORMULAS.has(name) && n.c.length) {
        const text = textContent(n)
        const next = formula(text)
        if (next !== text) n.c = [escText(next)]
      } else n.c = walk(n.c)
      if (name === 'rowBreaks' || name === 'colBreaks') {
        // a page break is above a row / left of a column (`id`, 0-based): it goes with it, or to the one that takes its place
        const axis = name === 'rowBreaks' ? 'row' : 'col'
        for (const b of kidsOf(n, 'brk')) {
          let id = Number(getAttr(b, 'id'))
          if (!Number.isInteger(id)) continue
          for (const s of shifts) if (s.axis === axis) id = shiftIndex(id, s) ?? s.at
          setAttr(b, 'id', String(id))
        }
        if (getAttr(n, 'manualBreakCount') !== undefined) setAttr(n, 'manualBreakCount', String(kidsOf(n, 'brk').length))
      }
      if (name in LISTS || name === 'sortState') {
        const kids = kidsOf(n)
        if (name !== 'sortState' && !kids.length) continue
        const count = LISTS[name]
        if (count && getAttr(n, count) !== undefined) setAttr(n, count, String(kids.length))
      }
      out.push(n)
    }
    return out
  }
  return serialize(walk(nodes)) + xml.slice(end)
}

/** rewrites the text of every `<c:f>` (the cells a chart draws) of a chart part */
const chartFormulas = (xml: string, fn: (f: string) => string) =>
  xml.replace(/(<(?:[\w.-]+:)?f>)([^<]*)(<\/(?:[\w.-]+:)?f>)/g, (all, open: string, text: string, close: string) => {
    const f = textContent(text)
    const g = fn(f)
    return g === f ? all : open + escText(g) + close
  })

const isChart = (path: string) => /^xl\/charts\/[^/]+\.xml$/i.test(path)

/** `fn` over the text of each part of `paths` that the package has: the parts it changed */
async function editParts(pkg: OpcPackage, paths: Iterable<string>, fn: (xml: string, path: string) => string): Promise<PartEdit[]> {
  const out: PartEdit[] = []
  for (const path of new Set(paths)) {
    if (!pkg.has(path)) continue
    let prev: string
    try {
      prev = await pkg.text(path)
    } catch {
      continue
    }
    const next = fn(prev, path)
    if (next === prev) continue
    pkg.setPart(path, next)
    out.push({ path, prev, next })
  }
  return out
}

/** the defined names of the workbook part, each rewritten by `fn` */
function definedNames(xml: string, fn: (f: string) => string): string {
  if (!xml.includes('definedName')) return xml
  const nodes = parseRaw(xml)
  let changed = false
  for (const n of kidsOf(kidOf(rootEl(nodes), 'definedNames'), 'definedName')) {
    const f = textContent(n)
    const g = fn(f)
    if (g === f) continue
    n.c = [escText(g)]
    changed = true
  }
  return changed ? serialize(nodes) : xml
}

/**
 * A sheet was renamed: the defined names are done with the list of sheets; here the charts that draw its cells.
 * (The validations and conditional formats of the sheets follow when they are written: `followSheetTail`.)
 */
export function renameInCharts(pkg: OpcPackage, from: string, to: string): Promise<PartEdit[]> {
  return editParts(pkg, pkg.paths().filter(isChart), (xml) => chartFormulas(xml, (f) => renameSheetInFormula(f, from, to)))
}

/** a header cell to write: a table got a column */
export interface NewHeader {
  r: number
  c: number
  text: string
}

/**
 * Rows / columns of sheet `sheetPath` (called `sheetName`) moved: the defined names, the tables of the sheet, the
 * anchors of its pictures and charts, and the cells any chart draws of it, follow. Returns the parts rewritten,
 * and the header cells of the columns tables got (a table names each of its columns in its first row).
 */
export async function followParts(pkg: OpcPackage, mainPath: string, sheetPath: string, sheetName: string, s: Shift): Promise<{ parts: PartEdit[]; headers: NewHeader[] }> {
  const parts: PartEdit[] = []
  const headers: NewHeader[] = []
  const formula = (f: string) => shiftFormula(f, { sheet: sheetName, ...s })
  parts.push(...(await editParts(pkg, [mainPath], (xml) => definedNames(xml, formula))))
  parts.push(...(await editParts(pkg, pkg.paths().filter(isChart), (xml) => chartFormulas(xml, formula))))
  const rels = await pkg.rels(sheetPath).catch(() => undefined)
  const of = (type: string) => [...(rels?.values() ?? [])].filter((r) => r.type.endsWith('/' + type) && !r.external).map((r) => r.target)
  parts.push(...(await editParts(pkg, of('table'), (xml) => followTable(xml, s, headers))))
  parts.push(...(await editParts(pkg, of('drawing'), (xml) => followDrawing(xml, s))))
  return { parts, headers }
}

/** A table after the shift: its range and filter moved; columns inserted in it or deleted from it are its own. */
function followTable(xml: string, s: Shift, headers: NewHeader[]): string {
  const nodes = parseRaw(xml)
  const table = rootEl(nodes)
  const ref = table && getAttr(table, 'ref')
  const m = ref ? RANGE.exec(ref) : null
  if (!table || !m || !m[3]) return xml
  const next = shiftSqref(ref!, [s])
  // all its cells deleted: left as it is (taking a table out of a workbook is more than its part)
  if (next === null) return xml
  const [r0, c0] = parseRef(`${m[1].toUpperCase()}${m[2]}`)
  const c1 = parseRef(`${m[3].toUpperCase()}${m[4]}`)[1]
  const list = kidOf(table, 'tableColumns')
  const cols = kidsOf(list, 'tableColumn')
  if (s.axis === 'col' && list && cols.length === c1 - c0 + 1) {
    const P = prefixOf(table.q)
    if (s.delta > 0 && s.at > c0 && s.at <= c1) {
      // columns inserted inside: each is a column of the table, named in its header row
      const names = new Set(cols.map((c) => (getAttr(c, 'name') ?? '').toLowerCase()))
      let id = Math.max(0, ...cols.map((c) => Number(getAttr(c, 'id')) || 0))
      const added: RNode[] = []
      const hasHeader = getAttr(table, 'headerRowCount') !== '0'
      for (let k = 0, n = cols.length + 1; k < s.delta; k++) {
        while (names.has(`column${n}`)) n++
        const name = `Column${n}`
        names.add(name.toLowerCase())
        added.push(el(P + 'tableColumn', { id: String(++id), name }))
        // (the sheet's own row, where the table moved to if rows moved before)
        if (hasHeader) headers.push({ r: r0, c: s.at + k, text: name })
      }
      list.c.splice(list.c.indexOf(cols[s.at - c0]), 0, ...added)
    } else if (s.delta < 0) {
      const gone = new Set<RChild>(cols.filter((_, i) => c0 + i >= s.at && c0 + i < s.at - s.delta))
      if (gone.size) list.c = list.c.filter((c) => !gone.has(c))
    }
    if (getAttr(list, 'count') !== undefined) setAttr(list, 'count', String(kidsOf(list, 'tableColumn').length))
  }
  setAttr(table, 'ref', next)
  const filter = kidOf(table, 'autoFilter')
  const fref = filter && getAttr(filter, 'ref')
  if (filter && fref) {
    const f = shiftSqref(fref, [s])
    if (f) setAttr(filter, 'ref', f)
    for (const st of kidsOf(filter, 'sortState')) {
      const sr = getAttr(st, 'ref')
      const moved = sr ? shiftSqref(sr, [s]) : null
      if (moved) setAttr(st, 'ref', moved)
    }
  }
  return serialize(nodes)
}

/** A drawing after the shift: the cells its pictures and charts are anchored to moved. */
function followDrawing(xml: string, s: Shift): string {
  const tag = s.axis === 'row' ? 'row' : 'col'
  const max = (s.axis === 'row' ? MAX_ROWS : MAX_COL) - 1
  // <xdr:row>12</xdr:row> inside <xdr:from> / <xdr:to>: a corner in a deleted row / column lands on the first one after
  return xml.replace(new RegExp(`(<((?:[\\w.-]+:)?)${tag}>)\\s*(\\d+)\\s*(</\\2${tag}>)`, 'g'), (all, open: string, _p: string, v: string, close: string) => {
    const x = Number(v)
    const y = Math.min(max, shiftIndex(x, s) ?? s.at)
    return y === x ? all : `${open}${y}${close}`
  })
}

/**
 * The text of a sheet part from the end of its rows on (the filters, validations, conditional formats… after
 * `</sheetData>`), read without holding the rows.
 */
export async function sheetTail(pkg: OpcPackage, path: string): Promise<string> {
  const reader = (await pkg.stream(path)).getReader()
  const dec = new TextDecoder()
  let tail = ''
  let found = false
  for (;;) {
    const { done, value } = await reader.read()
    const text = done ? dec.decode() : dec.decode(value, { stream: true })
    if (found) tail += text
    else {
      // (the closing tag may straddle two reads: the end of the last one is kept)
      const s = tail + text
      const m = /<\/(?:[\w.-]+:)?sheetData>|<(?:[\w.-]+:)?sheetData\s*\/>/.exec(s)
      if (m) {
        found = true
        tail = s.slice(m.index + m[0].length)
      } else tail = s.slice(-32)
    }
    if (done) break
  }
  return found ? tail : ''
}
