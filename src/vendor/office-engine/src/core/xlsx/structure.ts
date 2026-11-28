/**
 * Structural sheet edits on the in-memory SheetData: insert/delete rows & columns,
 * merges, sizes. Formulas (this sheet and others pointing at it) are shifted.
 */
import { shiftFormula, translateFormula, translator } from './formula'
import type { ColInfo, Merge, Range, RowAttrs } from './types'
import type { Shift } from './follow'
import { MAX_COL, MAX_ROWS, T_EMPTY, type SheetData } from './workbook'

export interface Snapshot {
  rows: (unknown[] | undefined)[]
  formulas: Map<number, string>
  arrays: Map<number, Merge>
  dynamic: Set<number>
  shifts: Shift[]
  merges: Merge[]
  colInfo: ColInfo[]
  rowAttrs: Map<number, RowAttrs>
  autoRowH: Map<number, number>
  maxRow: number
  maxCol: number
  frozen: { rows: number; cols: number }
}

/**
 * The state of a sheet, to go back to. The rows are the sheet's own, not copies (a sheet of 300 000 rows was copied
 * twice per inserted row, for Undo): they are marked as held, and what changes a row in place copies a held one
 * first (`ownRow`).
 */
export function snapshot(d: SheetData): Snapshot {
  const held = (d.held ??= new WeakSet())
  for (const row of d.rows) if (row) held.add(row)
  return {
    rows: d.rows.slice(),
    formulas: new Map(d.formulas),
    arrays: new Map(d.arrays),
    dynamic: new Set(d.dynamic),
    shifts: d.shifts.slice(),
    merges: d.merges.map((m) => ({ ...m })),
    colInfo: d.colInfo.map((c) => ({ ...c })),
    rowAttrs: new Map([...d.rowAttrs].map(([k, v]) => [k, { ...v }])),
    autoRowH: new Map(d.autoRowH),
    maxRow: d.maxRow,
    maxCol: d.maxCol,
    frozen: { ...d.frozen },
  }
}

export function restore(d: SheetData, s: Snapshot) {
  // (the rows of the snapshot themselves: they are held, a change copies them)
  d.rows = s.rows.slice()
  d.formulas = new Map(s.formulas)
  d.arrays = new Map(s.arrays)
  d.dynamic = new Set(s.dynamic)
  d.shifts = s.shifts.slice()
  d.merges = s.merges.map((m) => ({ ...m }))
  d.colInfo = s.colInfo.map((c) => ({ ...c }))
  d.rowAttrs = new Map([...s.rowAttrs].map(([k, v]) => [k, { ...v }]))
  d.autoRowH = new Map(s.autoRowH)
  d.maxRow = s.maxRow
  d.maxCol = s.maxCol
  d.frozen = { ...s.frozen }
  d.structural = true
  d.dirtyCols = d.dirtyMerges = d.dirtyView = true
}

/**
 * The cells of the shared formulas each get their own text in `formulas` (in the file only the first cell of a group
 * has it): what computes, fills, sorts or rewrites formulas sees them all. The groups stay known, so that a cell
 * nothing edited is saved as it was. Done once per sheet, before anything edits it: later a cell without a formula
 * is one the user took it from.
 */
export function expandShared(d: SheetData) {
  if (d.sharedExpanded || !d.depOf.size) return
  const by = new Map<number, (dr: number, dc: number) => string>()
  for (const [key, si] of d.depOf) {
    const g = d.shared.get(si)
    if (!g || d.formulas.has(key)) continue
    let tr = by.get(si)
    if (!tr) by.set(si, (tr = translator(g.text)))
    d.formulas.set(key, tr(Math.floor(key / MAX_COL) - Math.floor(g.master / MAX_COL), (key % MAX_COL) - (g.master % MAX_COL)))
  }
  // a sheet still being read has more to come
  if (d.done) d.sharedExpanded = true
}

/** formula of a cell, that of a shared formula's cell included (not expanded yet), without its "=" */
export function formulaAt(d: SheetData, key: number): string | undefined {
  const f = d.formulas.get(key)
  if (f !== undefined || d.sharedExpanded) return f
  const g = d.shared.get(d.depOf.get(key) ?? -1)
  if (!g) return undefined
  return translateFormula(g.text, Math.floor(key / MAX_COL) - Math.floor(g.master / MAX_COL), (key % MAX_COL) - (g.master % MAX_COL))
}

/** shared formulas → explicit per-cell formulas, the groups forgotten (before rows/cols move: every cell is written anew) */
export function materializeShared(d: SheetData) {
  expandShared(d)
  d.depOf.clear()
  d.shared.clear()
}

const holds = (row: unknown[] | undefined, from: number) => {
  if (row) for (let k = 0; k < row.length; k += 4) if ((row[k] as number) >= from && row[k + 1] !== T_EMPTY) return true
  return false
}

/**
 * Whether inserting `n` rows / columns at `at` would push cells that hold something off the sheet (Excel refuses
 * then too). Cells that only hold a format do not count: they fall off.
 */
export function overflows(d: SheetData, axis: 'row' | 'col', at: number, n: number): boolean {
  if (axis === 'row') {
    const from = Math.max(at, MAX_ROWS - n)
    for (let r = from; r < d.rows.length; r++) if (holds(d.rows[r], 0)) return true
    for (const key of d.formulas.keys()) if (Math.floor(key / MAX_COL) >= from) return true
    return false
  }
  const from = Math.max(at, MAX_COL - n)
  if (d.maxCol < from) return false
  for (const row of d.rows) if (holds(row, from)) return true
  for (const key of d.formulas.keys()) if (key % MAX_COL >= from) return true
  return false
}

/** a formula of another sheet rewritten because rows / columns moved in the sheet it reads */
export interface FormulaEdit {
  d: SheetData
  key: number
  prev: string
  next: string
}

function shiftMerges(ms: Merge[], axis: 'row' | 'col', at: number, delta: number): Merge[] {
  const out: Merge[] = []
  for (const m of ms) {
    let [a0, a1] = axis === 'row' ? [m.r0, m.r1] : [m.c0, m.c1]
    if (delta > 0) {
      if (a0 >= at) a0 += delta
      if (a1 >= at) a1 += delta
    } else {
      const end = at - delta // exclusive end of deleted band
      const cut = (v: number) => (v < at ? v : v >= end ? v + delta : at)
      if (a0 >= at && a1 < end) continue
      a0 = cut(a0)
      a1 = a1 >= end ? a1 + delta : a1 >= at ? at - 1 : a1
      if (a1 < a0) continue
    }
    const n = axis === 'row' ? { ...m, r0: a0, r1: a1 } : { ...m, c0: a0, c1: a1 }
    if (n.r0 === n.r1 && n.c0 === n.c1) continue
    out.push(n)
  }
  return out
}

/**
 * Moves rows or columns; delta > 0 inserts at `at`, delta < 0 deletes -delta starting at `at`. What an insert pushes
 * past the last row / column is dropped (the caller checks `overflows` first). Returns the formulas of the other
 * sheets it rewrote: undoing puts them back.
 */
export function shiftSheet(d: SheetData, sheetName: string, axis: 'row' | 'col', at: number, delta: number, others: { name: string; d: SheetData }[]): FormulaEdit[] {
  materializeShared(d)
  d.shifts.push({ axis, at, delta })
  const end = at - delta
  if (axis === 'row') {
    if (delta > 0) d.rows.splice(at, 0, ...new Array<undefined>(delta).fill(undefined))
    else d.rows.splice(at, -delta)
    if (d.rows.length > MAX_ROWS) d.rows.length = MAX_ROWS
    d.maxRow = Math.min(MAX_ROWS - 1, Math.max(-1, d.maxRow + (d.maxRow >= at ? delta : 0)))
    const attrs = new Map<number, RowAttrs>()
    for (const [r, v] of d.rowAttrs) {
      if (delta < 0 && r >= at && r < end) continue
      const to = r >= at ? r + delta : r
      if (to < MAX_ROWS) attrs.set(to, v)
    }
    d.rowAttrs = attrs
    const auto = new Map<number, number>()
    for (const [r, px] of d.autoRowH) {
      if (delta < 0 && r >= at && r < end) continue
      const to = r >= at ? r + delta : r
      if (to < MAX_ROWS) auto.set(to, px)
    }
    d.autoRowH = auto
  } else {
    for (let r = 0; r < d.rows.length; r++) {
      const row = d.rows[r]
      if (!row) continue
      const out: unknown[] = []
      for (let k = 0; k < row.length; k += 4) {
        const c = row[k] as number
        if (delta < 0 && c >= at && c < end) continue
        const to = c >= at ? c + delta : c
        if (to < MAX_COL) out.push(to, row[k + 1], row[k + 2], row[k + 3])
      }
      d.rows[r] = out.length ? out : undefined
    }
    d.maxCol = Math.min(MAX_COL - 1, Math.max(-1, d.maxCol + (d.maxCol >= at ? delta : 0)))
    const cols: ColInfo[] = []
    for (const ci of d.colInfo) {
      let { min, max } = ci
      if (delta > 0) {
        if (min >= at) min += delta
        if (max >= at) max += delta
        if (min >= MAX_COL) continue
        max = Math.min(max, MAX_COL - 1)
      } else {
        if (min >= at && max < end) continue
        min = min < at ? min : min >= end ? min + delta : at
        max = max >= end ? max + delta : max >= at ? at - 1 : max
        if (max < min) continue
      }
      cols.push({ ...ci, min, max })
    }
    d.colInfo = cols
    d.dirtyCols = true
  }
  // formulas of this sheet: move keys + rewrite references
  const op = { sheet: sheetName, formulaSheet: sheetName, axis, at, delta }
  const formulas = new Map<number, string>()
  for (const [key, f] of d.formulas) {
    let r = Math.floor(key / MAX_COL)
    let c = key % MAX_COL
    const v = axis === 'row' ? r : c
    if (delta < 0 && v >= at && v < end) continue
    if (v >= at) {
      if (axis === 'row') r += delta
      else c += delta
    }
    formulas.set(r * MAX_COL + c, shiftFormula(f, op))
  }
  d.formulas = formulas
  // array formulas: with their first cell, over the cells they still fill
  const arrays = new Map<number, Merge>()
  const dynamic = new Set<number>()
  for (const key of d.dynamic) {
    let r = Math.floor(key / MAX_COL)
    let c = key % MAX_COL
    const v = axis === 'row' ? r : c
    if (delta < 0 && v >= at && v < end) continue
    if (v >= at) {
      if (axis === 'row') r += delta
      else c += delta
    }
    if (r < MAX_ROWS && c < MAX_COL) dynamic.add(r * MAX_COL + c)
  }
  d.dynamic = dynamic
  for (const [key, rg] of d.arrays) {
    let r = Math.floor(key / MAX_COL)
    let c = key % MAX_COL
    const v = axis === 'row' ? r : c
    if (delta < 0 && v >= at && v < end) continue
    if (v >= at) {
      if (axis === 'row') r += delta
      else c += delta
    }
    if (r >= MAX_ROWS || c >= MAX_COL) continue
    // its last row / column: moved with the rest, or the last one left of those deleted
    let last = axis === 'row' ? rg.r1 : rg.c1
    if (delta > 0) last += last >= at ? delta : 0
    else last = last >= end ? last + delta : last >= at ? at - 1 : last
    arrays.set(r * MAX_COL + c, axis === 'row' ? { r0: r, c0: c, r1: Math.min(Math.max(r, last), MAX_ROWS - 1), c1: rg.c1 } : { r0: r, c0: c, r1: rg.r1, c1: Math.min(Math.max(c, last), MAX_COL - 1) })
  }
  d.arrays = arrays
  const edits: FormulaEdit[] = []
  for (const o of others) {
    if (o.d === d) continue
    // the cells of a shared formula each get the text that follows the move (the first cell's alone would not say theirs)
    expandShared(o.d)
    for (const [key, f] of o.d.formulas) {
      const g = shiftFormula(f, { ...op, formulaSheet: o.name })
      if (g !== f) edits.push({ d: o.d, key, prev: f, next: g })
    }
  }
  for (const e of edits) setFormula(e.d, e.key, e.next)
  d.merges = shiftMerges(d.merges, axis, at, delta).filter((m) => m.r0 < MAX_ROWS && m.c0 < MAX_COL).map((m) => ({ ...m, r1: Math.min(m.r1, MAX_ROWS - 1), c1: Math.min(m.c1, MAX_COL - 1) })).filter((m) => m.r0 !== m.r1 || m.c0 !== m.c1)
  if (axis === 'row' && d.frozen.rows > at) d.frozen = { ...d.frozen, rows: Math.max(0, d.frozen.rows + (delta > 0 ? delta : Math.max(delta, at - d.frozen.rows))) }
  if (axis === 'col' && d.frozen.cols > at) d.frozen = { ...d.frozen, cols: Math.max(0, d.frozen.cols + (delta > 0 ? delta : Math.max(delta, at - d.frozen.cols))) }
  d.structural = true
  d.dirtyMerges = true
  d.dirtyView = true
  return edits
}

/** gives a formula cell another text (a reference in it moved, its sheet was renamed…): saved with the sheet */
export function setFormula(d: SheetData, key: number, text: string) {
  d.formulas.set(key, text)
  d.edited.add(key)
  d.formulaChanged = true
}

export function setMerge(d: SheetData, range: Range, merge: boolean) {
  const hit = (m: Merge) => m.r1 >= range.r0 && m.r0 <= range.r1 && m.c1 >= range.c0 && m.c0 <= range.c1
  d.merges = d.merges.filter((m) => !hit(m))
  if (merge && (range.r0 !== range.r1 || range.c0 !== range.c1)) d.merges.push({ ...range })
  d.dirtyMerges = true
}

export function setColWidth(d: SheetData, c0: number, c1: number, px: number) {
  const w = Math.max(0, Math.round(px))
  const out: ColInfo[] = []
  const covered: [number, number][] = []
  for (const ci of d.colInfo) {
    if (ci.max < c0 || ci.min > c1) out.push(ci)
    else {
      if (ci.min < c0) out.push({ ...ci, max: c0 - 1 })
      if (ci.max > c1) out.push({ ...ci, min: c1 + 1 })
      // the columns keep their style, outline level…: only their width is new
      const { prevW: _p, ...rest } = ci
      const lo = Math.max(ci.min, c0)
      const hi = Math.min(ci.max, c1)
      covered.push([lo, hi])
      out.push({ ...rest, min: lo, max: hi, w })
    }
  }
  covered.sort((x, y) => x[0] - y[0])
  let from = c0
  for (const [lo, hi] of [...covered, [c1 + 1, c1 + 1] as [number, number]]) {
    if (lo > from) out.push({ min: from, max: Math.min(lo - 1, c1), w })
    from = Math.max(from, hi + 1)
  }
  d.colInfo = out.sort((a, b) => a.min - b.min)
  d.dirtyCols = true
}

/** gives columns c0..c1 the format `style` makes of the one they have (0: none), keeping their widths */
export function setColStyle(d: SheetData, c0: number, c1: number, style: (st: number) => number) {
  const out: ColInfo[] = []
  const covered: [number, number][] = []
  const withStyle = (ci: ColInfo): ColInfo => {
    const st = style(Number(ci.x?.style ?? 0) || 0)
    const { style: _s, ...rest } = ci.x ?? {}
    const x = st ? { ...rest, style: String(st) } : rest
    const { x: _x, ...bare } = ci
    return Object.keys(x).length ? { ...bare, x } : bare
  }
  for (const ci of d.colInfo) {
    if (ci.max < c0 || ci.min > c1) out.push(ci)
    else {
      if (ci.min < c0) out.push({ ...ci, max: c0 - 1 })
      if (ci.max > c1) out.push({ ...ci, min: c1 + 1 })
      const lo = Math.max(ci.min, c0)
      const hi = Math.min(ci.max, c1)
      covered.push([lo, hi])
      out.push(withStyle({ ...ci, min: lo, max: hi }))
    }
  }
  // the columns without a record: one of the default width
  covered.sort((x, y) => x[0] - y[0])
  let from = c0
  for (const [lo, hi] of [...covered, [c1 + 1, c1 + 1] as [number, number]]) {
    if (lo > from) {
      const ci = withStyle({ min: from, max: Math.min(lo - 1, c1), w: d.defaultColW })
      if (ci.x) out.push(ci)
    }
    from = Math.max(from, hi + 1)
  }
  d.colInfo = out.sort((x, y) => x.min - y.min)
  d.dirtyCols = true
}

export function setRowHeight(d: SheetData, r0: number, r1: number, px: number) {
  for (let r = r0; r <= r1; r++) {
    const cur = d.rowAttrs.get(r)
    d.rowAttrs.set(r, px > 0 ? { ht: +(px * 0.75).toFixed(2), ...(cur?.x && { x: cur.x }) } : { ...(cur ?? {}), hidden: true })
    d.dirtyRows.add(r)
  }
}
