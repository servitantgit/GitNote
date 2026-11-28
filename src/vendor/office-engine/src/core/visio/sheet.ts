/**
 * The ShapeSheet of a Visio drawing: every shape, page, master and style is a sheet of named cells, some of them in
 * sections of rows (Geometry, Character, Paragraph…). A file stores only the cells that differ from what the sheet
 * inherits: a shape from its master's shape, then from its line, fill and text styles, which have parents of their
 * own. A stored value is the result (`V`), in inches and radians whatever unit it shows, so no formula is evaluated.
 */
import { SaxParser, type Attrs, type SaxHandler } from '../xml'

/** an element of a Visio part; inside `Text`, the text between the elements is kept in order as `#text` children */
export interface VNode {
  n: string
  a: Attrs
  c: VNode[]
  t: string
}

/** sections never read: data, connection points, handles, events */
const SKIP_SECTIONS = new Set(['User', 'Property', 'Actions', 'Connection', 'Control', 'Scratch', 'Hyperlink', 'Reviewer', 'Annotation', 'ActionTag', 'Field', 'Tabs'])
const SKIP_ELEMENTS = new Set(['Connects', 'Data1', 'Data2', 'Data3', 'Trigger', 'RefBy', 'Icon', 'PageProps'])

class Builder implements SaxHandler {
  root: VNode | null = null
  private stack: VNode[] = []

  open(name: string, a: Attrs): boolean | void {
    if (SKIP_ELEMENTS.has(name) || (name === 'Section' && SKIP_SECTIONS.has(a.N))) return true
    const el: VNode = { n: name, a, c: [], t: '' }
    const parent = this.stack[this.stack.length - 1]
    if (parent) parent.c.push(el)
    else this.root ??= el
    this.stack.push(el)
  }

  close(): void {
    this.stack.pop()
  }

  text(t: string): void {
    const top = this.stack[this.stack.length - 1]
    if (!top) return
    if (top.n === 'Text') top.c.push({ n: '#text', a: {}, c: [], t })
    else top.t += t
  }
}

export function parseVisioXml(xml: string): VNode {
  const b = new Builder()
  const p = new SaxParser(b)
  p.write(xml)
  p.end()
  if (!b.root) throw new Error('Empty XML document')
  return b.root
}

export const vkid = (el: VNode | undefined, name: string): VNode | undefined => el?.c.find((c) => c.n === name)
export const vkids = (el: VNode | undefined, name: string): VNode[] => (el ? el.c.filter((c) => c.n === name) : [])

export interface Row {
  /** IX, or the name of a named row */
  key: string
  ix: number
  /** row type (LineTo, ArcTo…) */
  t?: string
  del: boolean
  cells: Map<string, string>
}

export interface Section {
  name: string
  ix: number
  del: boolean
  cells: Map<string, string>
  rows: Map<string, Row>
}

function readCells(el: VNode, into: Map<string, string>): void {
  for (const c of el.c) {
    if (c.n !== 'Cell' || c.a.N === undefined) continue
    const v = c.a.V ?? (c.t || undefined)
    if (v !== undefined) into.set(c.a.N, v)
  }
}

/** the cells and sections an element (Shape, PageSheet, StyleSheet) stores itself */
export class Sheet {
  readonly cells = new Map<string, string>()
  /** by name; Geometry sections by `Geometry` + IX */
  readonly sections = new Map<string, Section>()

  constructor(el?: VNode) {
    if (!el) return
    readCells(el, this.cells)
    for (const s of el.c) {
      if (s.n !== 'Section' || !s.a.N) continue
      const ix = Number(s.a.IX ?? 0) || 0
      const sec: Section = { name: s.a.N, ix, del: s.a.Del === '1', cells: new Map(), rows: new Map() }
      readCells(s, sec.cells)
      let auto = 0
      for (const r of s.c) {
        if (r.n !== 'Row') continue
        const key = r.a.IX ?? r.a.N ?? String(auto)
        auto++
        const row: Row = { key, ix: Number(r.a.IX ?? auto - 1) || 0, t: r.a.T, del: r.a.Del === '1', cells: new Map() }
        readCells(r, row.cells)
        sec.rows.set(key, row)
      }
      this.sections.set(s.a.N === 'Geometry' ? `Geometry${ix}` : s.a.N, sec)
    }
  }
}

/** a style of the document: a sheet, and the styles its line, fill and text cells inherit from */
export interface Style {
  sheet: Sheet
  line?: string
  fill?: string
  text?: string
}

export type StyleKind = 'line' | 'fill' | 'text'

const LINE_CELLS = new Set([
  'LineWeight', 'LineColor', 'LinePattern', 'Rounding', 'EndArrowSize', 'BeginArrow', 'EndArrow', 'LineCap', 'BeginArrowSize', 'LineColorTrans', 'CompoundType',
  'QuickStyleLineColor', 'QuickStyleLineMatrix', 'LineGradientEnabled',
])
const FILL_CELLS = new Set([
  'FillForegnd', 'FillBkgnd', 'FillPattern', 'ShdwForegnd', 'ShdwPattern', 'FillForegndTrans', 'FillBkgndTrans', 'ShdwForegndTrans', 'ShapeShdwType', 'ShapeShdwOffsetX',
  'ShapeShdwOffsetY', 'FillGradientEnabled', 'FillGradientDir', 'FillGradientAngle', 'QuickStyleFillColor', 'QuickStyleFillMatrix', 'QuickStyleShadowColor', 'QuickStyleEffectsMatrix',
])
const TEXT_CELLS = new Set([
  'LeftMargin', 'RightMargin', 'TopMargin', 'BottomMargin', 'VerticalAlign', 'TextBkgnd', 'DefaultTabStop', 'TextDirection', 'TextBkgndTrans', 'QuickStyleFontColor',
  'QuickStyleFontMatrix',
])
const SECTION_KIND: Record<string, StyleKind> = { Character: 'text', Paragraph: 'text', FillGradient: 'fill', LineGradient: 'line' }
const KINDS: StyleKind[] = ['line', 'fill', 'text']

/** the styles of a document, and the chain each one inherits through */
export class Styles {
  private byId = new Map<string, Style>()

  add(id: string, el: VNode): void {
    this.byId.set(id, { sheet: new Sheet(el), line: el.a.LineStyle, fill: el.a.FillStyle, text: el.a.TextStyle })
  }

  /** the sheets of style `id` and its parents of one kind, nearest first */
  chain(id: string | undefined, kind: StyleKind): Sheet[] {
    const out: Sheet[] = []
    const seen = new Set<string>()
    while (id !== undefined && !seen.has(id)) {
      seen.add(id)
      const s = this.byId.get(id)
      if (!s) break
      out.push(s.sheet)
      id = s[kind]
    }
    return out
  }
}

/**
 * A shape as it is drawn: its own sheet, then its master's, then the styles. Cells and rows are looked up through
 * all of them; a row or section marked deleted hides what it inherits.
 */
export class Resolved {
  private chains: Record<StyleKind, Sheet[]>
  /** own sheets, nearest first: the shape's, its master shape's */
  readonly own: Sheet[]

  constructor(
    own: (Sheet | undefined)[],
    styles: Styles,
    ids: Record<StyleKind, string | undefined>,
  ) {
    this.own = own.filter((s): s is Sheet => !!s)
    this.chains = { line: styles.chain(ids.line, 'line'), fill: styles.chain(ids.fill, 'fill'), text: styles.chain(ids.text, 'text') }
  }

  private sheetsFor(kind: StyleKind | undefined): Sheet[] {
    if (kind) return [...this.own, ...this.chains[kind]]
    return [...this.own, ...this.chains.line, ...this.chains.fill, ...this.chains.text]
  }

  /** a cell's stored value */
  cell(name: string): string | undefined {
    for (const s of this.own) {
      const v = s.cells.get(name)
      if (v !== undefined) return v
    }
    const kind: StyleKind | undefined = LINE_CELLS.has(name) ? 'line' : FILL_CELLS.has(name) ? 'fill' : TEXT_CELLS.has(name) ? 'text' : undefined
    for (const k of kind ? [kind] : KINDS) {
      for (const s of this.chains[k]) {
        const v = s.cells.get(name)
        if (v !== undefined) return v
      }
    }
    return undefined
  }

  /** a cell as a number; `def` when it is missing or not a number (a themed value, a name) */
  num(name: string, def = 0): number {
    return toNum(this.cell(name), def)
  }

  /** a cell of a row: the shape's row, its master's, then the styles' (their row of that key, else their first) */
  rowCell(section: string, key: string, name: string): string | undefined {
    const sheets = this.sheetsFor(SECTION_KIND[section])
    for (let i = 0; i < sheets.length; i++) {
      const sec = sheets[i].sections.get(section)
      if (!sec) continue
      const row = sec.rows.get(key) ?? (i >= this.own.length ? sec.rows.values().next().value : undefined)
      const v = row?.cells.get(name)
      if (v !== undefined) return v
    }
    return undefined
  }

  /** the keys of a section's rows the shape or its master has, in row order */
  rowKeys(section: string): string[] {
    const keys = new Map<string, number>()
    const deleted = new Set<string>()
    for (const s of this.own) {
      const sec = s.sections.get(section)
      if (!sec) continue
      for (const r of sec.rows.values()) {
        if (deleted.has(r.key)) continue
        if (r.del) deleted.add(r.key)
        else if (!keys.has(r.key)) keys.set(r.key, r.ix)
      }
      if (sec.del) break
    }
    return [...keys.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k)
  }

  /** the Geometry sections, merged over the shape and its master, in order */
  geometry(): Geometry[] {
    const ixs = new Set<number>()
    for (const s of this.own) for (const sec of s.sections.values()) if (sec.name === 'Geometry') ixs.add(sec.ix)
    const out: Geometry[] = []
    for (const ix of [...ixs].sort((a, b) => a - b)) {
      const key = `Geometry${ix}`
      const cells = new Map<string, string>()
      const rows = new Map<string, GeomRow>()
      const deleted = new Set<string>()
      let gone = false
      for (const s of this.own) {
        const sec = s.sections.get(key)
        if (!sec) continue
        if (sec.del) {
          // deleted by the shape: nothing of it is inherited (rows the shape gives after that are its own)
          gone = !sec.rows.size && !rows.size
          break
        }
        for (const [n, v] of sec.cells) if (!cells.has(n)) cells.set(n, v)
        for (const r of sec.rows.values()) {
          if (deleted.has(r.key)) continue
          if (r.del) {
            if (!rows.has(r.key)) deleted.add(r.key)
            continue
          }
          let row = rows.get(r.key)
          if (!row) rows.set(r.key, (row = { ix: r.ix, t: r.t ?? '', cells: new Map() }))
          if (!row.t && r.t) row.t = r.t
          for (const [n, v] of r.cells) if (!row.cells.has(n)) row.cells.set(n, v)
        }
      }
      if (gone || !rows.size) continue
      out.push({ ix, cells, rows: [...rows.values()].sort((a, b) => a.ix - b.ix) })
    }
    return out
  }
}

export interface GeomRow {
  ix: number
  t: string
  cells: Map<string, string>
}

export interface Geometry {
  ix: number
  cells: Map<string, string>
  rows: GeomRow[]
}

export function toNum(v: string | undefined, def = 0): number {
  if (v === undefined || v === '') return def
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}
