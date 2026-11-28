import { colorOf, officeHex, type ColorCtx } from '../color'
import type { DocComment } from '../comments'
import { readPptxComments, PptxComments, writePptxComments } from './comments'
import { cssFont } from '../fonts'
import { OpcPackage, relOfType, relsOfType, type Rels } from '../opc'
import { parseTheme, type Theme } from '../theme'
import { emuToPx } from '../units'
import { decodeXml, kid, kids, num, path, textOf, type XEl } from '../xml'
import { chartKeys, MAX_READ_POINTS, pointBudget, readSavedChart, showable, type ChartModel } from '../xlsx/chart'
import type { Box, Fill, PParaSpec, PresentationMeta, PRunSet, SlideEl, SlideModel, Stroke, TCell, TextBody, TPara, TRun } from './types'
import {
  clone, el, escText, getAttr, isNode, kidOf, kidsOf, local, parseRaw, prefixOf, removeKids, serialize, setAttr, setOrdered, walkOoxml,
  type RChild, type RNode,
} from '../raw'
import { dict, own } from '../dict'

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

interface GenPara {
  k?: number
  runs: ([number, number] | undefined)[]
}

const RPR_KIDS = ['ln', 'noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill', 'effectLst', 'effectDag', 'highlight', 'uLnTx', 'uLn', 'uFillTx', 'uFill', 'latin', 'ea', 'cs', 'sym', 'hlinkClick', 'hlinkMouseOver', 'rtl', 'extLst']
const FILLS = new Set(['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'])
const ALGN_OUT: Record<string, string> = dict({ left: 'l', center: 'ctr', right: 'r', justify: 'just' })

function findShape(nodes: RChild[], sid: number): RNode | undefined {
  let found: RNode | undefined
  for (const n of nodes) {
    if (!isNode(n)) continue
    walkOoxml(n, (c) => {
      if (found) return true
      if (local(c.q) !== 'sp') return
      const nv = kidOf(c, 'nvSpPr')
      const id = getAttr(kidOf(nv, 'cNvPr') ?? c, 'id')
      if (id !== undefined && Number(id) === sid) found = c
      return true
    })
  }
  return found
}

/** the `a:tc` at [row, col] of the table in graphic frame `sid` */
function findCell(nodes: RChild[], sid: number, cell: [number, number]): RNode | undefined {
  let frame: RNode | undefined
  for (const n of nodes) {
    if (!isNode(n)) continue
    walkOoxml(n, (c) => {
      if (frame) return true
      if (local(c.q) !== 'graphicFrame') return
      const id = getAttr(kidOf(kidOf(c, 'nvGraphicFramePr'), 'cNvPr') ?? c, 'id')
      if (id !== undefined && Number(id) === sid) frame = c
      return true
    })
  }
  let tbl: RNode | undefined
  if (frame) walkOoxml(frame, (c) => {
    if (tbl) return true
    if (local(c.q) === 'tbl') tbl = c
    return !!tbl
  })
  return tbl ? kidsOf(kidsOf(tbl, 'tr')[cell[0]], 'tc')[cell[1]] : undefined
}

/** key of a text target (a shape, or a table cell of a graphic frame) */
const tkey = (path: string, sid: number, cell?: [number, number]) => `${path}#${sid}${cell ? `:${cell[0]}.${cell[1]}` : ''}`

function applyPRunSet(rPr: RNode, set: PRunSet, A: string) {
  if (set.sz !== undefined) setAttr(rPr, 'sz', String(Math.round(set.sz * 100)))
  if (set.b !== undefined) setAttr(rPr, 'b', set.b ? '1' : '0')
  if (set.i !== undefined) setAttr(rPr, 'i', set.i ? '1' : '0')
  if (set.u !== undefined) setAttr(rPr, 'u', set.u ? 'sng' : 'none')
  if (set.strike !== undefined) setAttr(rPr, 'strike', set.strike ? 'sngStrike' : 'noStrike')
  if ('color' in set) {
    removeKids(rPr, (l) => FILLS.has(l))
    const color = officeHex(set.color)
    if (color) setOrdered(rPr, el(A + 'solidFill', {}, [el(A + 'srgbClr', { val: color })]), 'solidFill', RPR_KIDS)
  }
  if (set.font) setOrdered(rPr, el(A + 'latin', { typeface: set.font }), 'latin', RPR_KIDS)
  const hl = officeHex(set.hl)
  if ('hl' in set) setOrdered(rPr, hl ? el(A + 'highlight', {}, [el(A + 'srgbClr', { val: hl })]) : undefined, 'highlight', RPR_KIDS)
  if ('baseline' in set) setAttr(rPr, 'baseline', set.baseline ? String(Math.round(set.baseline * 1000)) : undefined)
}

const PPR_KIDS = ['lnSpc', 'spcBef', 'spcAft', 'buClrTx', 'buClr', 'buSzTx', 'buSzPct', 'buSzPts', 'buFontTx', 'buFont', 'buNone', 'buAutoNum', 'buChar', 'buBlip', 'tabLst', 'defRPr', 'extLst']
const BULLETS = new Set(['buNone', 'buAutoNum', 'buChar', 'buBlip'])

/** paragraph-level changes made in the editor */
function applyPPr(ppr: RNode, spec: PParaSpec, A: string) {
  if (spec.algn) setAttr(ppr, 'algn', ALGN_OUT[spec.algn])
  if (spec.lvl !== undefined && String(spec.lvl) !== (getAttr(ppr, 'lvl') ?? '0')) {
    setAttr(ppr, 'lvl', spec.lvl ? String(spec.lvl) : undefined)
    // explicit margins would pin the old level's indent
    setAttr(ppr, 'marL', undefined)
    setAttr(ppr, 'indent', undefined)
  }
  if (spec.bullet) {
    removeKids(ppr, (l) => BULLETS.has(l))
    if (spec.bullet === 'none') {
      setOrdered(ppr, el(A + 'buNone'), 'buNone', PPR_KIDS)
      if (getAttr(ppr, 'indent')?.startsWith('-')) setAttr(ppr, 'indent', '0')
    } else {
      const node = spec.bullet === 'bullet' ? el(A + 'buChar', { char: '•' }) : el(A + 'buAutoNum', { type: 'arabicPeriod' })
      if (spec.bullet === 'bullet') setOrdered(ppr, el(A + 'buFont', { typeface: 'Arial' }), 'buFont', PPR_KIDS)
      setOrdered(ppr, node, spec.bullet === 'bullet' ? 'buChar' : 'buAutoNum', PPR_KIDS)
      if (!getAttr(ppr, 'marL')) {
        const lvl = Number(getAttr(ppr, 'lvl') ?? 0)
        setAttr(ppr, 'marL', String(342900 + lvl * 457200))
        setAttr(ppr, 'indent', '-342900')
      }
    }
  }
  if (spec.lnPct) setOrdered(ppr, el(A + 'lnSpc', {}, [el(A + 'spcPct', { val: String(Math.round(spec.lnPct * 100000)) })]), 'lnSpc', PPR_KIDS)
  ppr.self = ppr.c.length === 0
}

interface RunProps {
  sz?: number
  b?: boolean
  i?: boolean
  u?: boolean
  strike?: boolean
  color?: string
  font?: string
  baseline?: number
  caps?: boolean
  hl?: string
}

interface LvlProps {
  algn?: TPara['algn']
  marL?: number
  indent?: number
  lnPct?: number
  lnPts?: number
  bef?: { pct?: number; pts?: number }
  aft?: { pct?: number; pts?: number }
  bu?: { kind: 'none' | 'char' | 'auto'; char?: string; autoType?: string; startAt?: number }
  buClr?: string
  buFont?: string
  buSzPct?: number
  r: RunProps
}

type Levels = LvlProps[]

interface Part {
  path: string
  root: XEl
  rels: Rels
  /** the pictures of the part's legacy drawing (VML) by shape id: what an embedded object shows */
  vml?: Map<string, string>
  spTree?: XEl
  byIdx: Map<string, XEl>
  byType: Map<string, XEl>
}

interface Master extends Part {
  theme: Theme
  clrMap: Record<string, string>
  title?: XEl
  body?: XEl
  other?: XEl
}

interface Layout extends Part {
  master: Master
  clrMap: Record<string, string>
}

const ALGN: Record<string, TPara['algn']> = dict({ l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify', thaiDist: 'justify', justLow: 'justify' })
const DASH: Record<string, string> = dict({
  dash: '4 3', sysDash: '3 1', dot: '1 1', sysDot: '1 1', lgDash: '8 3', dashDot: '4 3 1 3', lgDashDot: '8 3 1 3',
  lgDashDotDot: '8 3 1 3 1 3', sysDashDot: '3 1 1 1', sysDashDotDot: '3 1 1 1 1 1',
})

function nvPr(el: XEl): XEl | undefined {
  const nv = el.c[0]
  return nv ? kid(nv, 'nvPr') : undefined
}

function phOf(el: XEl): { type: string; idx?: string } | undefined {
  const ph = kid(nvPr(el), 'ph')
  if (!ph) return undefined
  return { type: ph.a.type ?? 'body', idx: ph.a.idx }
}

// A slide title as plain text: symbol-font characters (Wingdings arrows, check marks) have no glyph
// outside their font, so the usual ones become their Unicode look-alikes and the rest are dropped.
const TITLE_SYMBOLS: Record<string, string> = {
  '\uF0E0': '➔', '\uF0E8': '➔', '\uF0F0': '⇨', '\uF0D8': '➢', '\uF0FC': '✓', '\uF0FB': '✗', '\uF0B7': '•', '\uF0A7': '▪', '\uF06C': '●',
}
const plainTitle = (paras: string[]) => paras.join(' ').replace(/[\uF000-\uF0FF]/g, (c) => TITLE_SYMBOLS[c] ?? '').replace(/\s+/g, ' ').trim()

/** the text of the title placeholder in a slide's shape tree (groups included), or '' */
function titleOf(tree: XEl | undefined): string {
  for (const c of tree?.c ?? []) {
    const t = c.n === 'grpSp' ? titleOf(c) : c.n === 'sp' && ['title', 'ctrTitle'].includes(phOf(c)?.type ?? '') ? plainTitle(kids(kid(c, 'txBody'), 'p').map((p) => p.c.map((c) => c.n === 'br' ? ' ' : textOf(c)).join(''))) : ''
    if (t) return t
  }
  return ''
}

const masterType = (t: string) => (t === 'ctrTitle' ? 'title' : t === 'subTitle' || t === 'obj' ? 'body' : t)

function indexPlaceholders(spTree: XEl | undefined) {
  const byIdx = new Map<string, XEl>()
  const byType = new Map<string, XEl>()
  const visit = (tree: XEl | undefined) => {
    for (const c of tree?.c ?? []) {
      if (c.n === 'grpSp') visit(c)
      const ph = phOf(c)
      if (!ph) continue
      if (ph.idx !== undefined && !byIdx.has(ph.idx)) byIdx.set(ph.idx, c)
      if (!byType.has(ph.type)) byType.set(ph.type, c)
    }
  }
  visit(spTree)
  return { byIdx, byType }
}

function romanize(n: number): string {
  // a start number comes straight from the file (up to 2^31): past what Roman numerals spell, the number itself
  if (!(n > 0 && n <= 3999)) return String(n)
  const map: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
  let s = ''
  for (const [v, r] of map) while (n >= v) (s += r), (n -= v)
  return s
}

function autoNum(type: string, n: number): string {
  const alpha = (k: number) => (k > 0 && k <= 2600 ? String.fromCharCode(97 + ((k - 1) % 26)).repeat(Math.floor((k - 1) / 26) + 1) : String(k))
  let core = String(n)
  if (type.startsWith('alphaLc')) core = alpha(n)
  else if (type.startsWith('alphaUc')) core = alpha(n).toUpperCase()
  else if (type.startsWith('romanLc')) core = romanize(n)
  else if (type.startsWith('romanUc')) core = romanize(n).toUpperCase()
  if (type.endsWith('ParenBoth')) return `(${core})`
  if (type.endsWith('ParenR')) return `${core})`
  if (type.endsWith('Period')) return `${core}.`
  if (type.endsWith('Minus')) return `- ${core} -`
  return core
}

/** what a part was (null: absent) before and after an edit */
export interface PartPatch {
  path: string
  before: string | null
  after: string | null
}

/**
 * One undoable edit. A shape edit is the slide XML before / after (`path`); a slide list edit (add, delete, move, hide…)
 * is the patches of every part it touched, the comments it removed, and the slide to show after undo / redo.
 */
export interface UndoEntry {
  path: string
  before: string
  after: string
  parts?: PartPatch[]
  gone?: DocComment[]
  focus?: [number, number]
  /** a text edit: the text it is of (slide, shape, cell), so that typing going on in it stays one step */
  text?: string
  /** a text edit: what tells the runs of the slide's edited texts from those of the file, before and after it */
  gen?: [before: GenSnap, after: GenSnap]
}

/** the run maps of the edited texts of one slide (see `genMaps`) */
export type GenSnap = [key: string, map: GenPara[]][]

/** whether a slide part is hidden from the show (`show="0"` on its root) */
export async function slideHidden(pkg: OpcPackage, path: string): Promise<boolean> {
  // the root's attributes open the part: its first bytes are read, not the whole slide (every slide is asked when a deck opens)
  const reader = (await pkg.stream(path)).getReader()
  const chunks: Uint8Array[] = []
  let n = 0
  try {
    while (n < 2048) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      n += value.length
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
  const head = new Uint8Array(n)
  let at = 0
  for (const c of chunks) {
    head.set(c, at)
    at += c.length
  }
  return /<[\w:]*sld\b[^>]*\sshow="(?:0|false)"/.test(decodeXml(head.subarray(0, 4096)))
}

export class PptxPresentation {
  private masters = new Map<string, Promise<Master>>()
  /** the comments (read in `open`) */
  comments = new PptxComments()
  private layouts = new Map<string, Promise<Layout>>()
  /** charts by part, read once however many slides show them */
  private charts = new Map<string, Promise<ChartModel | null>>()
  /** the points the presentation's charts may still read together: one read past them keeps its placeholder */
  private chartPoints = pointBudget()
  private chartKey = chartKeys()
  /** the points of the charts each slide shows: the slides together have a budget of them (a chart on a master is on every slide) */
  private shownPoints = new Map<number, number>()
  private tableStyles?: Promise<Map<string, XEl>>
  readonly meta: PresentationMeta

  private constructor(
    readonly pkg: OpcPackage,
    readonly mainPath: string,
    private defaultTextStyle: XEl | undefined,
    meta: PresentationMeta,
  ) {
    this.meta = meta
  }

  static async open(pkg: OpcPackage, mainPath: string): Promise<PptxPresentation> {
    const root = await pkg.xml(mainPath)
    if (!root) throw new Error('Missing presentation part')
    const rels = await pkg.rels(mainPath)
    const sz = kid(root, 'sldSz')
    const slides: PresentationMeta['slides'] = []
    for (const s of kids(kid(root, 'sldIdLst'), 'sldId')) {
      const rel = rels.get(s.a['r:id'])
      if (rel && pkg.has(rel.target)) slides.push({ index: slides.length, path: rel.target, hidden: false })
    }
    // hidden slides say so on their own root: a show leaves them out, the list dims them
    await Promise.all(slides.map(async (s) => void (s.hidden = await slideHidden(pkg, s.path))))
    const meta: PresentationMeta = {
      w: emuToPx(num(sz?.a.cx, 9144000)),
      h: emuToPx(num(sz?.a.cy, 6858000)),
      count: slides.length,
      slides,
    }
    const pres = new PptxPresentation(pkg, mainPath, kid(root, 'defaultTextStyle'), meta)
    pres.comments = await readPptxComments(pkg, rels, slides, meta).catch((e: Error) => {
      console.warn('[office-engine] comments not read:', e.message)
      return new PptxComments()
    })
    return pres
  }

  private async part(p: string): Promise<Part> {
    const root = await this.pkg.xml(p, false)
    if (!root) throw new Error(`Missing part ${p}`)
    const spTree = path(root, 'cSld', 'spTree')
    const rels = await this.pkg.rels(p)
    return { path: p, root, rels, vml: await this.vmlPictures(rels), spTree, ...indexPlaceholders(spTree) }
  }

  /**
   * An embedded object (a worksheet, a chart of Microsoft Graph, a slide) names the shape of the part's legacy
   * drawing that shows it (`spid`); PowerPoint 2007 files have its picture nowhere else, and newer ones keep the
   * picture of their own in an mc:Fallback, which is not read. The shapes' pictures, by shape id.
   */
  private async vmlPictures(rels: Rels): Promise<Map<string, string> | undefined> {
    let out: Map<string, string> | undefined
    for (const rel of relsOfType(rels, 'vmlDrawing')) {
      if (rel.external || !this.pkg.has(rel.target)) continue
      const [vml, vrels] = await Promise.all([this.pkg.xml(rel.target), this.pkg.rels(rel.target)])
      const walk = (el: XEl | undefined) => {
        if (!el) return
        const img = el.n === 'shape' ? kid(el, 'imagedata') : undefined
        // (o:relid, read without its prefix; r:id in what other writers make)
        const target = img ? vrels.get(img.a.relid ?? img.a['r:id'] ?? '') : undefined
        // a named shape keeps the id objects point at in o:spid
        if (target && !target.external) for (const id of [el.a.spid, el.a.id]) if (id) (out ??= new Map()).set(id, target.target)
        for (const c of el.c) walk(c)
      }
      walk(vml)
    }
    return out
  }

  private master(p: string): Promise<Master> {
    let m = this.masters.get(p)
    if (!m) {
      m = (async () => {
        const part = await this.part(p)
        const themeRel = relOfType(part.rels, 'theme')
        const theme = parseTheme(themeRel ? await this.pkg.xml(themeRel.target) : undefined)
        const clrMap = { ...(kid(part.root, 'clrMap')?.a ?? {}) }
        const tx = kid(part.root, 'txStyles')
        return { ...part, theme, clrMap, title: kid(tx, 'titleStyle'), body: kid(tx, 'bodyStyle'), other: kid(tx, 'otherStyle') }
      })()
      this.masters.set(p, m)
    }
    return m
  }

  private layout(p: string): Promise<Layout> {
    let l = this.layouts.get(p)
    if (!l) {
      l = (async () => {
        const part = await this.part(p)
        const mRel = relOfType(part.rels, 'slideMaster')
        if (!mRel) throw new Error(`Layout ${p} has no master`)
        const master = await this.master(mRel.target)
        return { ...part, master, clrMap: clrMapOf(part.root, master.clrMap) }
      })()
      this.layouts.set(p, l)
    }
    return l
  }

  private getTableStyles(): Promise<Map<string, XEl>> {
    if (!this.tableStyles) {
      this.tableStyles = (async () => {
        const map = new Map<string, XEl>()
        const rel = relOfType(await this.pkg.rels(this.mainPath), 'tableStyles')
        const root = rel ? await this.pkg.xml(rel.target) : undefined
        for (const s of kids(root, 'tblStyle')) map.set(s.a.styleId, s)
        return map
      })()
    }
    return this.tableStyles
  }

  async slide(index: number): Promise<SlideModel> {
    const info = this.meta.slides[index]
    if (!info) throw new Error(`No slide #${index}`)
    const slide = await this.part(info.path)
    const lRel = relOfType(slide.rels, 'slideLayout')
    const layout = lRel ? await this.layout(lRel.target) : undefined
    const master = layout?.master
    const theme = master?.theme ?? parseTheme(undefined)
    const clrMap = clrMapOf(slide.root, layout?.clrMap ?? master?.clrMap ?? {})
    const r = new SlideRenderer(this, slide, layout, master, theme, clrMap, index, await this.getTableStyles())
    const els: SlideEl[] = []
    const showSlideMaster = slide.root.a.showMasterSp !== '0'
    if (master && showSlideMaster && layout?.root.a.showMasterSp !== '0') r.walk(master, master.spTree, identity, els, true)
    if (layout && showSlideMaster) r.walk(layout, layout.spTree, identity, els, true)
    r.walk(slide, slide.spTree, identity, els, false)
    // charts take the place of their frames' placeholders where their parts can be read, and while the slides' charts
    // together are within their budget of points
    const models: (ChartModel | null)[] = []
    for (const c of r.charts) models.push(await this.chart(c.target, theme))
    // (nothing is awaited from here to the slide's share being set: slides read at the same time must not take the same
    // points; the share it had is given back first, the slide being read again)
    this.shownPoints.delete(index)
    let others = 0
    for (const n of this.shownPoints.values()) others += n
    const room = { left: MAX_READ_POINTS - others }
    r.charts.forEach((c, k) => {
      const i = els.indexOf(c.el)
      const model = models[k]
      if (i >= 0 && model && showable(room, model)) els[i] = { t: 'chart', box: c.el.box, model, ...(c.el.top !== undefined ? { top: c.el.top } : {}) }
    })
    this.shownPoints.set(index, MAX_READ_POINTS - others - room.left)
    return {
      index,
      w: this.meta.w,
      h: this.meta.h,
      bg: r.background(),
      els,
      hidden: slide.root.a.show === '0' || slide.root.a.show === 'false',
      title: r.title,
      notes: await this.notesOf(slide.rels),
    }
  }

  private chart(target: string, theme: Theme): Promise<ChartModel | null> {
    let c = this.charts.get(target)
    if (!c) {
      c = (async () => {
        const model = this.pkg.has(target) ? await readSavedChart(await this.pkg.xml(target), theme, this.chartPoints) : null
        return model && { ...model, key: this.chartKey(target) }
      })().catch((e: Error) => {
        console.warn('[office-engine] chart not read:', e.message)
        return null
      })
      this.charts.set(target, c)
    }
    return c
  }

  /** every slide's title placeholder text ('' where there is none): its XML only, nothing laid out */
  async titles(): Promise<string[]> {
    const out: string[] = []
    for (const s of this.meta.slides) out.push(titleOf((await this.part(s.path)).spTree))
    return out
  }

  /** speaker notes: the text of the body placeholder of the slide's notes slide (paragraphs on lines) */
  private async notesOf(slideRels: Rels): Promise<string | undefined> {
    const rel = relOfType(slideRels, 'notesSlide')
    const root = rel && this.pkg.has(rel.target) ? await this.pkg.xml(rel.target) : undefined
    for (const sp of kids(path(root, 'cSld', 'spTree'), 'sp')) {
      if (path(sp, 'nvSpPr', 'nvPr', 'ph')?.a.type !== 'body') continue
      const lines = kids(kid(sp, 'txBody'), 'p').map((p) => p.c.map((r) => (r.n === 'r' || r.n === 'fld' ? textOf(kid(r, 't')) : r.n === 'br' ? '\n' : '')).join(''))
      const text = lines.join('\n')
      return text.trim() ? text : undefined
    }
    return undefined
  }
  get defaults() {
    return this.defaultTextStyle
  }

  // ---------------------------------------------------------------- editing

  private genMaps = new Map<string, GenPara[]>()
  /** structural edits (shapes, slides) */
  touched = false
  /** edits of a slide (its XML before / after: shapes, text) and of the slide list, for undo */
  undoStack: UndoEntry[] = []
  redoStack: UndoEntry[] = []
  private originals = new Map<string, string>()
  private lateShapes = new Map<string, string>()

  /**
   * Takes the slide XML that text edits use as template (their run references point into it).
   * Done lazily on the first text edit; collaboration takes it up front so every client uses the same.
   */
  async keepOriginal(path: string) {
    if (!this.originals.has(path)) this.originals.set(path, await this.pkg.text(path))
  }

  genMap(path: string, sid: number, cell?: [number, number]): GenPara[] | undefined {
    return this.genMaps.get(tkey(path, sid, cell))
  }

  /** the run maps of a slide's edited texts, as they are now */
  genSnap(path: string): GenSnap {
    return [...this.genMaps].filter(([k]) => k.startsWith(path + '#'))
  }

  /** puts back the run maps of a slide (undo / redo of a text edit: they go with the slide's XML) */
  genRestore(path: string, snap: GenSnap) {
    for (const k of [...this.genMaps.keys()]) if (k.startsWith(path + '#')) this.genMaps.delete(k)
    for (const [k, v] of snap) this.genMaps.set(k, v)
  }

  get dirty() {
    return this.genMaps.size > 0 || this.touched || this.comments.dirty
  }

  /** Rewrites the paragraphs of shape `sid` on slide `index` and returns the re-rendered slide. */
  /**
   * `step`: the edit begins a step of its own for undo (the text was just entered). Without it, typing that goes on in
   * the text the last edit was of is one step with it.
   */
  async setText(index: number, sid: number, paras: PParaSpec[], cell?: [number, number], step = false): Promise<SlideModel> {
    const info = this.meta.slides[index]
    if (!info) throw new Error(`No slide #${index}`)
    const p = info.path
    await this.keepOriginal(p)
    const before = await this.pkg.text(p)
    const genBefore = this.genSnap(p)
    const curNodes = parseRaw(before)
    // a table cell (`a:tc`) holds its text like a shape (`p:sp`) does: an `txBody` of `a:p`
    const find = (nodes: RChild[]) => (cell ? findCell(nodes, sid, cell) : findShape(nodes, sid))
    const shape = find(curNodes)
    // a shape added after the slide's original was taken is its own template
    const key = tkey(p, sid, cell)
    if (shape && !this.lateShapes.has(key) && !find(parseRaw(this.originals.get(p)!))) this.lateShapes.set(key, serialize([shape]))
    const late = this.lateShapes.get(key)
    const origShape = late ? (parseRaw(late)[0] as RNode) : find(parseRaw(this.originals.get(p)!))
    if (!shape || !origShape) throw new Error(cell ? `Cell ${cell} of table ${sid} not found` : `Shape ${sid} not found`)
    let txBody = kidOf(shape, 'txBody')
    const origBody = kidOf(origShape, 'txBody')
    const origParas = kidsOf(origBody, 'p')
    const P = prefixOf(shape.q)
    const A = prefixOf((kidOf(origBody, 'bodyPr') ?? origParas[0])?.q ?? 'a:x') || 'a:'
    if (!txBody) {
      txBody = el((cell ? A : P) + 'txBody', {}, [el(A + 'bodyPr'), el(A + 'lstStyle')])
      // in a cell the text body comes before the cell properties
      if (cell) shape.c.unshift(txBody)
      else shape.c.push(txBody)
      shape.self = false
    }
    const origRuns = origParas.map((op) => kidsOf(op).filter((c) => ['r', 'br', 'fld'].includes(local(c.q))))
    const map: GenPara[] = []
    const out: RNode[] = paras.map((spec) => {
      const tpl = spec.k !== undefined ? origParas[spec.k] : origParas[origParas.length - 1]
      const node = el(A + 'p')
      const tplPPr = kidOf(tpl, 'pPr')
      const wants = spec.algn || spec.lvl !== undefined || spec.bullet || spec.lnPct
      const ppr = tplPPr ? clone(tplPPr) : wants ? el(A + 'pPr') : undefined
      if (ppr && wants) applyPPr(ppr, spec, A)
      if (ppr) node.c.push(ppr)
      const end = kidOf(tpl, 'endParaRPr')
      const gp: GenPara = { k: spec.k, runs: [] }
      const baseRPr = (src?: [number, number]) => {
        const r = src ? origRuns[src[0]]?.[src[1]] : undefined
        const rp: RNode | undefined = kidOf(r, 'rPr') ?? (end ? { ...clone(end), q: A + 'rPr' } : undefined)
        return rp ? clone(rp) : el(A + 'rPr', { lang: 'en-US', dirty: '0' })
      }
      for (const run of spec.runs) {
        if (run.fld && run.src) {
          const f = origRuns[run.src[0]]?.[run.src[1]]
          if (f) {
            node.c.push(clone(f))
            gp.runs.push(run.src)
          }
          continue
        }
        const pieces = run.text.split('\n')
        pieces.forEach((piece, i) => {
          const rPr = baseRPr(run.src)
          if (run.set) applyPRunSet(rPr, run.set, A)
          if (i > 0) {
            node.c.push(el(A + 'br', {}, [{ ...clone(rPr) }]))
            gp.runs.push(run.src)
          }
          if (piece) {
            node.c.push(el(A + 'r', {}, [rPr, el(A + 't', {}, [escText(piece)])]))
            gp.runs.push(run.src)
          }
        })
      }
      node.c.push(end ? clone(end) : el(A + 'endParaRPr', { lang: 'en-US', dirty: '0' }))
      node.self = false
      map.push(gp)
      return node
    })
    const keep = txBody.c.filter((c) => !(isNode(c) && local(c.q) === 'p'))
    txBody.c = [...keep, ...out]
    txBody.self = false
    const text = serialize(curNodes)
    this.pkg.setPart(p, text)
    this.genMaps.set(key, map)
    if (text !== before) {
      const top = this.undoStack[this.undoStack.length - 1]
      if (!step && top?.text === key && top.after === before && top.gen) {
        top.after = text
        top.gen[1] = this.genSnap(p)
      } else {
        this.undoStack.push({ path: p, before, after: text, text: key, gen: [genBefore, this.genSnap(p)] })
        if (this.undoStack.length > 200) this.undoStack.shift()
      }
      this.redoStack = []
    }
    return this.slide(index)
  }

  async save(): Promise<Blob> {
    if (this.comments.dirty) await writePptxComments(this.pkg, this.mainPath, this.comments, this.meta.slides)
    return this.pkg.save(PPTX_MIME)
  }
}

function clrMapOf(root: XEl, inherited: Record<string, string>): Record<string, string> {
  const ovr = path(root, 'clrMapOvr', 'overrideClrMapping')
  return ovr ? { ...ovr.a } : inherited
}

type Xform = (b: Box) => Box
const identity: Xform = (b) => b

function readXfrm(x: XEl | undefined): Box | undefined {
  if (!x) return undefined
  const off = kid(x, 'off')
  const ext = kid(x, 'ext')
  if (!off && !ext) return undefined
  const b: Box = {
    x: emuToPx(num(off?.a.x, 0)),
    y: emuToPx(num(off?.a.y, 0)),
    w: emuToPx(num(ext?.a.cx, 0)),
    h: emuToPx(num(ext?.a.cy, 0)),
  }
  const rot = num(x.a.rot)
  if (rot) b.rot = rot / 60000
  if (x.a.flipH === '1') b.flipH = true
  if (x.a.flipV === '1') b.flipV = true
  return b
}

class SlideRenderer {
  /** the text of the slide's title placeholder, once walked */
  title: string | undefined
  /** chart frames walked: their placeholders and their chart parts, read after the walk */
  readonly charts: { el: SlideEl & { t: 'placeholder' }; target: string }[] = []
  constructor(
    private pres: PptxPresentation,
    private slide: Part,
    private layout: Layout | undefined,
    private master: Master | undefined,
    private theme: Theme,
    private clrMap: Record<string, string>,
    private index: number,
    private tableStyles: Map<string, XEl>,
  ) {}

  private cc(phClr?: string): ColorCtx {
    return { theme: this.theme, clrMap: this.clrMap, phClr }
  }

  private font(typeface: string | undefined): string | undefined {
    if (!typeface) return undefined
    if (typeface.startsWith('+mj')) return cssFont(this.theme.major)
    if (typeface.startsWith('+mn')) return cssFont(this.theme.minor)
    return cssFont(typeface)
  }

  // ---- fills & lines --------------------------------------------------------

  fill(parent: XEl | undefined, rels: Rels, phClr?: string): Fill | undefined {
    if (!parent) return undefined
    for (const c of parent.c) {
      switch (c.n) {
        case 'noFill':
          return { t: 'none' }
        case 'solidFill': {
          const col = colorOf(c, this.cc(phClr))
          return col ? { t: 'solid', c: col } : undefined
        }
        case 'gradFill': {
          const stops = kids(kid(c, 'gsLst'), 'gs')
            .map((g) => ({ pos: (num(g.a.pos, 0)! / 1000) | 0, col: colorOf(g, this.cc(phClr)) }))
            .filter((s) => s.col)
            .sort((a, b) => a.pos - b.pos)
          if (!stops.length) return undefined
          if (stops.length === 1) return { t: 'solid', c: stops[0].col! }
          const list = stops.map((s) => `${s.col} ${s.pos}%`).join(', ')
          if (kid(c, 'path')) return { t: 'grad', css: `radial-gradient(circle, ${list})` }
          const ang = (num(kid(c, 'lin')?.a.ang, 0)! / 60000 + 90) % 360
          return { t: 'grad', css: `linear-gradient(${ang}deg, ${list})` }
        }
        case 'blipFill': {
          const id = kid(c, 'blip')?.a['r:embed']
          const rel = id ? rels.get(id) : undefined
          return rel && !rel.external ? { t: 'img', target: rel.target, tile: !!kid(c, 'tile') } : undefined
        }
        case 'pattFill': {
          const col = colorOf(kid(c, 'fgClr'), this.cc(phClr))
          return col ? { t: 'solid', c: col } : undefined
        }
      }
    }
    return undefined
  }

  private themeFill(ref: XEl | undefined, rels: Rels): Fill | undefined {
    if (!ref) return undefined
    const idx = num(ref.a.idx, 0)!
    if (!idx) return undefined
    const phClr = colorOf(ref, this.cc())
    const list = idx >= 1001 ? this.theme.bgFillStyles : this.theme.fillStyles
    const style = list[(idx >= 1001 ? idx - 1001 : idx - 1)]
    if (!style) return phClr ? { t: 'solid', c: phClr } : undefined
    return this.fill({ n: 'x', a: {}, c: [style], t: '' }, rels, phClr) ?? (phClr ? { t: 'solid', c: phClr } : undefined)
  }

  private stroke(ln: XEl | undefined, lnRef: XEl | undefined): Stroke | undefined {
    const refIdx = num(lnRef?.a.idx, 0)!
    const refLn = refIdx ? this.theme.lineStyles[refIdx - 1] : undefined
    const refColor = lnRef ? colorOf(lnRef, this.cc()) : undefined
    if (ln && kid(ln, 'noFill')) return undefined
    let color = ln ? colorOf(kid(ln, 'solidFill'), this.cc(refColor)) : undefined
    if (!color && ln) {
      const gs = path(ln, 'gradFill', 'gsLst', 'gs')
      if (gs) color = colorOf(gs, this.cc(refColor))
    }
    if (!color && refIdx) color = refColor ?? (refLn ? colorOf(kid(refLn, 'solidFill'), this.cc(refColor)) : undefined)
    if (!color) return undefined
    const wEmu = num(ln?.a.w) ?? num(refLn?.a.w) ?? 9525
    const dash = kid(ln, 'prstDash')?.a.val ?? kid(refLn, 'prstDash')?.a.val
    const s: Stroke = { c: color, w: Math.max(0.5, emuToPx(wEmu)) }
    if (dash && DASH[dash]) s.dash = DASH[dash].split(' ').map((d) => +(Number(d) * s.w).toFixed(2)).join(' ')
    const head = kid(ln, 'headEnd')?.a.type
    const tail = kid(ln, 'tailEnd')?.a.type
    if (head && head !== 'none') s.head = head
    if (tail && tail !== 'none') s.tail = tail
    return s
  }

  background(): Fill | undefined {
    for (const part of [this.slide, this.layout, this.master]) {
      if (!part) continue
      const bg = path(part.root, 'cSld', 'bg')
      if (!bg) continue
      const bgPr = kid(bg, 'bgPr')
      if (bgPr) {
        const f = this.fill(bgPr, part.rels)
        if (f) return f
      }
      const ref = kid(bg, 'bgRef')
      if (ref) return this.themeFill(ref, part.rels)
    }
    return { t: 'solid', c: own(this.theme.colors, this.clrMap.bg1 ?? 'lt1') ?? '#ffffff' }
  }

  // ---- text styles -----------------------------------------------------------

  private readRun(rPr: XEl | undefined, out: RunProps = {}): RunProps {
    if (!rPr) return out
    const a = rPr.a
    if (a.sz) out.sz = Number(a.sz) / 100
    if (a.b !== undefined) out.b = a.b === '1' || a.b === 'true'
    if (a.i !== undefined) out.i = a.i === '1' || a.i === 'true'
    if (a.u !== undefined) out.u = a.u !== 'none'
    if (a.strike !== undefined) out.strike = a.strike !== 'noStrike'
    if (a.baseline !== undefined) out.baseline = Number(a.baseline) / 1000
    if (a.cap !== undefined) out.caps = a.cap === 'all'
    const fill = kid(rPr, 'solidFill')
    if (fill) {
      const c = colorOf(fill, this.cc())
      if (c) out.color = c
    } else {
      const gs = path(rPr, 'gradFill', 'gsLst', 'gs')
      const c = gs && colorOf(gs, this.cc())
      if (c) out.color = c
    }
    const hl = colorOf(kid(rPr, 'highlight'), this.cc())
    if (hl) out.hl = hl
    const latin = kid(rPr, 'latin')?.a.typeface ?? kid(rPr, 'ea')?.a.typeface
    const f = this.font(latin)
    if (f) out.font = f
    return out
  }

  private readLvl(pPr: XEl | undefined, base: LvlProps): LvlProps {
    const out: LvlProps = { ...base, r: { ...base.r } }
    if (!pPr) return out
    const a = pPr.a
    if (a.algn) out.algn = ALGN[a.algn] ?? 'left'
    if (a.marL !== undefined) out.marL = emuToPx(Number(a.marL))
    if (a.indent !== undefined) out.indent = emuToPx(Number(a.indent))
    for (const c of pPr.c) {
      switch (c.n) {
        case 'lnSpc': {
          const pct = num(kid(c, 'spcPct')?.a.val)
          const pts = num(kid(c, 'spcPts')?.a.val)
          if (pct !== undefined) (out.lnPct = pct / 100000), (out.lnPts = undefined)
          else if (pts !== undefined) (out.lnPts = pts / 100), (out.lnPct = undefined)
          break
        }
        case 'spcBef':
        case 'spcAft': {
          const pct = num(kid(c, 'spcPct')?.a.val)
          const pts = num(kid(c, 'spcPts')?.a.val)
          const v = pct !== undefined ? { pct: pct / 100000 } : { pts: (pts ?? 0) / 100 }
          if (c.n === 'spcBef') out.bef = v
          else out.aft = v
          break
        }
        case 'buNone':
          out.bu = { kind: 'none' }
          break
        case 'buChar':
          out.bu = { kind: 'char', char: c.a.char ?? '•' }
          break
        case 'buAutoNum':
          out.bu = { kind: 'auto', autoType: c.a.type ?? 'arabicPeriod', startAt: num(c.a.startAt, 1) }
          break
        case 'buClr':
          out.buClr = colorOf(c, this.cc())
          break
        case 'buFont':
          out.buFont = c.a.typeface
          break
        case 'buSzPct':
          out.buSzPct = num(c.a.val, 100000)! / 100000
          break
        case 'defRPr':
          this.readRun(c, out.r)
          break
      }
    }
    return out
  }

  private levels(sources: (XEl | undefined)[]): Levels {
    const out: Levels = []
    for (let l = 1; l <= 9; l++) {
      let cur: LvlProps = { r: {} }
      for (const src of sources) {
        if (!src) continue
        cur = this.readLvl(kid(src, 'defPPr'), cur)
        cur = this.readLvl(kid(src, `lvl${l}pPr`), cur)
      }
      out.push(cur)
    }
    return out
  }

  private textBody(
    txBody: XEl | undefined, chain: XEl[], ph: { type: string } | undefined, styleFont?: XEl, part?: Part, sid?: number, cell?: [number, number],
  ): TextBody | undefined {
    if (!txBody) return undefined
    const paras = kids(txBody, 'p')
    const empty = !paras.some((p) => p.c.some((c) => c.n === 'r' || c.n === 'fld'))
    if (empty && sid === undefined) return undefined
    const gm = sid !== undefined ? this.pres.genMap(this.slide.path, sid, cell) : undefined
    const m = this.master
    let base: XEl | undefined
    if (ph) {
      const t = masterType(ph.type)
      base = t === 'title' ? m?.title : t === 'body' ? m?.body : m?.other
    }
    const sources: (XEl | undefined)[] = ph ? [base] : [m?.other, this.pres.defaults]
    if (styleFont) {
      const col = colorOf(styleFont, this.cc())
      const fnt = styleFont.a.idx === 'major' ? this.theme.major : styleFont.a.idx === 'minor' ? this.theme.minor : undefined
      const synthetic: XEl = { n: 'lstStyle', a: {}, c: [], t: '' }
      const defRPr: XEl = { n: 'defRPr', a: {}, c: [], t: '' }
      if (col) defRPr.c.push({ n: 'solidFill', a: {}, c: [{ n: 'srgbClr', a: { val: col.replace('#', '').slice(0, 6) }, c: [], t: '' }], t: '' })
      if (fnt) defRPr.c.push({ n: 'latin', a: { typeface: fnt }, c: [], t: '' })
      synthetic.c.push({ n: 'defPPr', a: {}, c: [defRPr], t: '' })
      sources.push(synthetic)
    }
    for (const sp of chain) sources.push(path(sp, 'txBody', 'lstStyle'))
    const lv = this.levels(sources)

    // body properties: inherit along the chain
    const bodyAttrs: Record<string, string> = {}
    let autofit: XEl | undefined
    for (const sp of chain) {
      const bp = path(sp, 'txBody', 'bodyPr')
      if (!bp) continue
      Object.assign(bodyAttrs, bp.a)
      const na = kid(bp, 'normAutofit')
      if (na) autofit = na
    }
    const fontScale = autofit ? num(autofit.a.fontScale, 100000)! / 100000 : 1
    const lnReduce = autofit ? num(autofit.a.lnSpcReduction, 0)! / 100000 : 0
    const ins: [number, number, number, number] = [
      emuToPx(num(bodyAttrs.lIns, 91440)),
      emuToPx(num(bodyAttrs.tIns, 45720)),
      emuToPx(num(bodyAttrs.rIns, 91440)),
      emuToPx(num(bodyAttrs.bIns, 45720)),
    ]
    const counters: number[] = []
    const rels = part?.rels ?? this.slide.rels
    const out: TPara[] = paras.map((p, pi) => {
      const pPr = kid(p, 'pPr')
      const lvl = Math.min(8, num(pPr?.a.lvl, 0)!)
      const L = this.readLvl(pPr, lv[lvl])
      const runs: TRun[] = []
      let j = 0
      for (const c of p.c) {
        const src: [number, number] | undefined = c.n === 'r' || c.n === 'fld' || c.n === 'br' ? (gm ? gm[pi]?.runs[j++] : [pi, j++]) : undefined
        if (c.n === 'r' || c.n === 'fld') {
          const rp = this.readRun(kid(c, 'rPr'), { ...L.r })
          let text = textOf(kid(c, 't'))
          if (c.n === 'fld' && c.a.type === 'slidenum') text = String(this.index + 1)
          const hrefId = path(c, 'rPr', 'hlinkClick')?.a['r:id']
          const href = hrefId ? rels.get(hrefId)?.target : undefined
          runs.push({
            text,
            sz: (rp.sz ?? 18) * fontScale,
            b: rp.b, i: rp.i, u: rp.u || !!href, strike: rp.strike,
            color: rp.color ?? (href ? this.theme.colors.hlink : undefined),
            font: rp.font, baseline: rp.baseline, caps: rp.caps, href, hl: rp.hl, src,
            ...(c.n === 'fld' ? { fld: true } : {}),
          })
        } else if (c.n === 'br') {
          const rp = this.readRun(kid(c, 'rPr'), { ...L.r })
          runs.push({ text: '', br: true, sz: (rp.sz ?? 18) * fontScale, src })
        }
      }
      const endR = this.readRun(kid(p, 'endParaRPr'), { ...L.r })
      const firstSz = runs[0]?.sz ?? (endR.sz ?? 18) * fontScale
      const hasText = runs.some((r) => r.text)
      let bullet: TPara['bullet']
      if (L.bu && L.bu.kind !== 'none' && hasText) {
        const sz = firstSz * (L.buSzPct ?? 1)
        const color = L.buClr ?? runs[0]?.color ?? L.r.color
        if (L.bu.kind === 'char') bullet = { text: L.bu.char ?? '•', sz, color, font: L.buFont ? this.font(L.buFont) : undefined }
        else {
          counters[lvl] = (counters[lvl] ?? (L.bu.startAt ?? 1) - 1) + 1
          for (let d = lvl + 1; d < 9; d++) counters[d] = undefined as unknown as number
          bullet = { text: autoNum(L.bu.autoType ?? 'arabicPeriod', counters[lvl]), sz, color }
        }
      } else if (!L.bu || L.bu.kind === 'none') {
        for (let d = lvl; d < 9; d++) counters[d] = undefined as unknown as number
      }
      const spc = (v: LvlProps['bef']) => (!v ? 0 : v.pts !== undefined ? (v.pts * 4) / 3 : (v.pct ?? 0) * firstSz * 1.2 * (4 / 3))
      return {
        algn: L.algn ?? 'left',
        marL: L.marL ?? 0,
        indent: L.indent ?? 0,
        lnPct: L.lnPct !== undefined ? L.lnPct * (1 - lnReduce) : lnReduce ? 1 - lnReduce : undefined,
        lnPx: L.lnPts !== undefined ? (L.lnPts * 4) / 3 : undefined,
        spcBef: spc(L.bef),
        spcAft: spc(L.aft),
        bullet,
        lvl: lvl || undefined,
        buKind: L.bu?.kind === 'char' ? 'bullet' : L.bu?.kind === 'auto' ? 'number' : undefined,
        runs,
        endSz: (endR.sz ?? 18) * fontScale,
        k: gm ? gm[pi]?.k : pi,
      }
    })
    const anchor = bodyAttrs.anchor === 'ctr' ? 'ctr' : bodyAttrs.anchor === 'b' ? 'b' : 't'
    return { anchor, ins, wrap: bodyAttrs.wrap !== 'none', vert: bodyAttrs.vert && bodyAttrs.vert !== 'horz' ? bodyAttrs.vert : undefined, paras: out, empty: empty || undefined }
  }

  // ---- shape tree ----------------------------------------------------------------

  private inheritChain(el: XEl, part: Part): { chain: XEl[]; ph?: { type: string; idx?: string } } {
    const ph = phOf(el)
    if (!ph) return { chain: [el] }
    const chain: XEl[] = []
    const t = masterType(ph.type)
    if (part === this.slide) {
      const lph = this.layout ? (ph.idx !== undefined ? this.layout.byIdx.get(ph.idx) : undefined) ?? this.layout.byType.get(ph.type) : undefined
      const lt = lph ? phOf(lph)?.type ?? t : t
      const mph = this.master?.byType.get(masterType(lt)) ?? this.master?.byType.get(t)
      if (mph) chain.push(mph)
      if (lph) chain.push(lph)
    } else if (part === this.layout) {
      const mph = this.master?.byType.get(t)
      if (mph) chain.push(mph)
    }
    chain.push(el)
    return { chain, ph }
  }

  walk(part: Part, tree: XEl | undefined, xf: Xform, out: SlideEl[], skipPh: boolean, top?: number): void {
    if (!tree) return
    for (const c of tree.c) {
      if (skipPh && (c.n === 'sp' || c.n === 'pic') && phOf(c)) continue
      const idAttr = kid(c.c[0], 'cNvPr')?.a.id
      const myTop = top ?? (part === this.slide && idAttr ? Number(idAttr) : undefined)
      const start = out.length
      try {
        switch (c.n) {
          case 'sp':
          case 'cxnSp':
            this.shape(c, part, xf, out)
            break
          case 'pic':
            this.pic(c, part, xf, out)
            break
          case 'grpSp':
            this.group(c, part, xf, out, skipPh, myTop)
            break
          case 'graphicFrame':
            this.frame(c, part, xf, out)
            break
        }
      } catch {
        // a single malformed shape must not break the slide
      }
      if (myTop !== undefined) for (let k = start; k < out.length; k++) out[k].top = myTop
    }
  }

  private boxOf(chain: XEl[], xfrmPath: string[], xf: Xform): Box | undefined {
    for (let i = chain.length - 1; i >= 0; i--) {
      const b = readXfrm(path(chain[i], ...xfrmPath))
      if (b) return xf(b)
    }
    return undefined
  }

  private shape(el: XEl, part: Part, xf: Xform, out: SlideEl[]) {
    const { chain, ph } = this.inheritChain(el, part)
    const box = this.boxOf(chain, ['spPr', 'xfrm'], xf)
    if (!box) return
    const style = kid(el, 'style')
    let fill: Fill | undefined
    // inherited placeholder fills resolve media against the current part (image fills on layouts are rare)
    for (let i = chain.length - 1; i >= 0 && !fill; i--) fill = this.fill(kid(chain[i], 'spPr'), part.rels)
    if (!fill && style) fill = this.themeFill(kid(style, 'fillRef'), part.rels)
    let ln: XEl | undefined
    for (let i = chain.length - 1; i >= 0 && !ln; i--) ln = path(chain[i], 'spPr', 'ln')
    const stroke = this.stroke(ln, kid(style, 'lnRef'))
    let geom = 'rect'
    let adj: Record<string, number> | undefined
    let pathD: string | undefined
    for (let i = chain.length - 1; i >= 0; i--) {
      const pg = path(chain[i], 'spPr', 'prstGeom')
      if (pg) {
        geom = pg.a.prst ?? 'rect'
        const gds = kids(kid(pg, 'avLst'), 'gd')
        if (gds.length) {
          adj = {}
          for (const g of gds) {
            const m = /val\s+(-?\d+)/.exec(g.a.fmla ?? '')
            if (m) adj[g.a.name] = Number(m[1])
          }
        }
        break
      }
      const cg = path(chain[i], 'spPr', 'custGeom')
      if (cg) {
        geom = 'custom'
        pathD = customPath(cg, box)
        break
      }
    }
    if (el.n === 'cxnSp' && geom === 'rect') geom = 'line'
    const idAttr = path(el, 'nvSpPr', 'cNvPr')?.a.id
    const sid = part === this.slide && el.n === 'sp' && idAttr ? Number(idAttr) : undefined
    const text = el.n === 'sp' ? this.textBody(kid(el, 'txBody'), chain, ph, kid(style, 'fontRef'), part, sid) : undefined
    // the slide's own title placeholder names the slide (outline, slide list)
    if (text && part === this.slide && this.title === undefined && (ph?.type === 'title' || ph?.type === 'ctrTitle')) {
      const t = plainTitle(text.paras.map((p) => p.runs.map((r) => r.br ? ' ' : r.text).join('')))
      if (t) this.title = t
    }
    if ((!fill || fill.t === 'none') && !stroke && !text) return
    out.push({ t: 'shape', box, geom, adj, fill, stroke, text, path: pathD, sid })
  }

  private pic(el: XEl, part: Part, xf: Xform, out: SlideEl[]) {
    const { chain } = this.inheritChain(el, part)
    const box = this.boxOf(chain, ['spPr', 'xfrm'], xf)
    if (!box) return
    const bf = kid(el, 'blipFill')
    const id = kid(bf, 'blip')?.a['r:embed']
    const rel = id ? part.rels.get(id) : undefined
    const sr = kid(bf, 'srcRect')
    const crop: [number, number, number, number] | undefined = sr
      ? [num(sr.a.l, 0)! / 100000, num(sr.a.t, 0)! / 100000, num(sr.a.r, 0)! / 100000, num(sr.a.b, 0)! / 100000]
      : undefined
    const video = !!kid(nvPr(el), 'videoFile') || !!kid(nvPr(el), 'audioFile')
    out.push({
      t: 'pic',
      box,
      target: rel && !rel.external ? rel.target : undefined,
      crop: crop && crop.some((v) => v !== 0) ? crop : undefined,
      stroke: this.stroke(path(el, 'spPr', 'ln'), path(el, 'style', 'lnRef')),
      geom: path(el, 'spPr', 'prstGeom')?.a.prst,
      video,
    })
  }

  private group(el: XEl, part: Part, xf: Xform, out: SlideEl[], skipPh: boolean, top?: number) {
    const x = path(el, 'grpSpPr', 'xfrm')
    const off = kid(x, 'off')
    const ext = kid(x, 'ext')
    const chOff = kid(x, 'chOff')
    const chExt = kid(x, 'chExt')
    if (!off || !ext) return this.walk(part, el, xf, out, skipPh, top)
    const ox = emuToPx(num(off.a.x, 0))
    const oy = emuToPx(num(off.a.y, 0))
    const cx = emuToPx(num(chOff?.a.x, 0))
    const cy = emuToPx(num(chOff?.a.y, 0))
    const sx = chExt && num(chExt.a.cx) ? num(ext.a.cx, 0)! / num(chExt.a.cx, 1)! : 1
    const sy = chExt && num(chExt.a.cy) ? num(ext.a.cy, 0)! / num(chExt.a.cy, 1)! : 1
    const local: Xform = (b) => xf({ ...b, x: ox + (b.x - cx) * sx, y: oy + (b.y - cy) * sy, w: b.w * sx, h: b.h * sy })
    this.walk(part, el, local, out, skipPh, top)
  }

  private frame(el: XEl, part: Part, xf: Xform, out: SlideEl[]) {
    const raw = readXfrm(kid(el, 'xfrm'))
    if (!raw) return
    const box = xf(raw)
    const gd = path(el, 'graphic', 'graphicData')
    if (!gd) return
    const tbl = kid(gd, 'tbl')
    if (tbl) {
      const id = path(el, 'nvGraphicFramePr', 'cNvPr')?.a.id
      return void out.push(this.table(tbl, box, part, part === this.slide && id ? Number(id) : undefined))
    }
    const ole = kid(gd, 'oleObj')
    const olePic = kid(ole, 'pic')
    if (olePic) {
      const id = path(olePic, 'blipFill', 'blip')?.a['r:embed']
      const rel = id ? part.rels.get(id) : undefined
      return void out.push({ t: 'pic', box, target: rel?.target })
    }
    // no picture of its own: the one its shape of the legacy drawing shows
    const shown = ole?.a.spid ? part.vml?.get(ole.a.spid) : undefined
    if (shown) return void out.push({ t: 'pic', box, target: shown })
    const uri = gd.a.uri ?? ''
    const label = uri.includes('chart') ? 'Chart' : uri.includes('diagram') ? 'SmartArt' : uri.includes('ole') ? 'Embedded object' : 'Object'
    const ph: SlideEl & { t: 'placeholder' } = { t: 'placeholder', box, label }
    out.push(ph)
    const chart = uri.includes('chart') ? part.rels.get(kid(gd, 'chart')?.a['r:id'] ?? '') : undefined
    if (chart && !chart.external) this.charts.push({ el: ph, target: chart.target })
  }

  private table(tbl: XEl, box: Box, part: Part, sid?: number): SlideEl {
    const cols = kids(kid(tbl, 'tblGrid'), 'gridCol').map((g) => emuToPx(num(g.a.w, 0)))
    const tblPr = kid(tbl, 'tblPr')
    const flag = (k: string) => tblPr?.a[k] === '1' || tblPr?.a[k] === 'true'
    const styleId = kid(tblPr, 'tableStyleId')?.t.trim()
    const ts = styleId ? this.tableStyles.get(styleId) : undefined
    const trs = kids(tbl, 'tr')
    const nRows = trs.length
    const nCols = cols.length
    const tableFill = this.fill(tblPr, part.rels)

    const parts = (ri: number, ci: number): XEl[] => {
      const out: XEl[] = []
      const add = (n: string) => {
        const p = kid(ts, n)
        if (p) out.push(p)
      }
      add('wholeTbl')
      const bodyRi = ri - (flag('firstRow') ? 1 : 0)
      if (flag('bandRow') && bodyRi >= 0) add(bodyRi % 2 === 0 ? 'band1H' : 'band2H')
      const bodyCi = ci - (flag('firstCol') ? 1 : 0)
      if (flag('bandCol') && bodyCi >= 0) add(bodyCi % 2 === 0 ? 'band1V' : 'band2V')
      if (flag('firstCol') && ci === 0) add('firstCol')
      if (flag('lastCol') && ci === nCols - 1) add('lastCol')
      if (flag('lastRow') && ri === nRows - 1) add('lastRow')
      if (flag('firstRow') && ri === 0) add('firstRow')
      return out
    }

    const fallback = !ts && styleId ? defaultTableLook(this.theme, flag('firstRow'), flag('bandRow')) : undefined

    const rows = trs.map((tr, ri) => {
      const cells: TCell[] = kids(tr, 'tc').map((tc, ci) => {
        const tcPr = kid(tc, 'tcPr')
        let fill: Fill | undefined
        let bold: boolean | undefined
        let color: string | undefined
        const bord: Record<string, Stroke | undefined> = dict({})
        for (const sp of parts(ri, ci)) {
          const tcStyle = kid(sp, 'tcStyle')
          const f = this.fill(kid(tcStyle, 'fill'), part.rels) ?? this.themeFill(kid(tcStyle, 'fillRef'), part.rels)
          if (f) fill = f
          const bdr = kid(tcStyle, 'tcBdr')
          for (const side of bdr?.c ?? []) {
            const s = this.stroke(kid(side, 'ln'), kid(side, 'lnRef'))
            bord[side.n] = s
          }
          const tx = kid(sp, 'tcTxStyle')
          if (tx) {
            if (tx.a.b) bold = tx.a.b === 'on'
            const c = colorOf(tx, this.cc()) ?? colorOf(kid(tx, 'fontRef'), this.cc())
            if (c) color = c
          }
        }
        if (fallback) {
          const fb = fallback(ri)
          fill = fb.fill
          if (fb.color) color = fb.color
          if (fb.bold) bold = true
          bord.insideH = bord.insideV = { c: '#ffffff', w: 1 }
        }
        const own = this.fill(tcPr, part.rels)
        if (own) fill = own
        const edge = (tag: string, side: 'left' | 'right' | 'top' | 'bottom', inner: 'insideV' | 'insideH', outer: boolean) => {
          const el = kid(tcPr, tag)
          if (el) return this.stroke(el, undefined)
          return outer ? bord[side] : bord[inner] ?? bord[side]
        }
        const textEl = kid(tc, 'txBody')
        // the text of a cell of the slide's own table is editable, so an empty one has a body too
        let text = this.textBody(textEl, textEl ? [tc] : [], undefined, undefined, part, sid, [ri, ci])
        if (!text && sid !== undefined && !(tc.a.hMerge === '1' || tc.a.vMerge === '1' || tc.a.hMerge === 'true' || tc.a.vMerge === 'true')) text = this.textBody({ n: 'txBody', a: {}, c: [{ n: 'p', a: {}, c: [], t: '' }], t: '' }, [tc], undefined, undefined, part, sid, [ri, ci])
        if (text) {
          text.ins = [
            emuToPx(num(tcPr?.a.marL, 91440)), emuToPx(num(tcPr?.a.marT, 45720)),
            emuToPx(num(tcPr?.a.marR, 91440)), emuToPx(num(tcPr?.a.marB, 45720)),
          ]
          text.anchor = tcPr?.a.anchor === 'ctr' ? 'ctr' : tcPr?.a.anchor === 'b' ? 'b' : 't'
          if (bold !== undefined || color) {
            for (const p of text.paras) for (const r of p.runs) {
              if (bold && r.b === undefined) r.b = true
              if (color && !r.color) r.color = color
            }
          }
        } else text = undefined
        return {
          text,
          fill: fill ?? tableFill,
          bl: edge('lnL', 'left', 'insideV', ci === 0),
          br: edge('lnR', 'right', 'insideV', ci === nCols - 1),
          bt: edge('lnT', 'top', 'insideH', ri === 0),
          bb: edge('lnB', 'bottom', 'insideH', ri === nRows - 1),
          colSpan: num(tc.a.gridSpan, 1)!,
          rowSpan: num(tc.a.rowSpan, 1)!,
          hidden: tc.a.hMerge === '1' || tc.a.vMerge === '1' || tc.a.hMerge === 'true' || tc.a.vMerge === 'true',
        }
      })
      return { h: emuToPx(num(tr.a.h, 0)), cells }
    })
    return { t: 'table', box, cols, rows, sid }
  }
}

/** Approximation of PowerPoint's default "Medium Style 2 – Accent 1" when the style isn't embedded. */
function defaultTableLook(theme: Theme, firstRow: boolean, bandRow: boolean) {
  const accent = theme.colors.accent1 ?? '#4472c4'
  return (ri: number): { fill?: Fill; color?: string; bold?: boolean } => {
    if (firstRow && ri === 0) return { fill: { t: 'solid', c: accent }, color: '#ffffff', bold: true }
    const bi = ri - (firstRow ? 1 : 0)
    const tint = bandRow && bi % 2 === 0 ? 0.6 : 0.8
    return { fill: { t: 'solid', c: mix(accent, '#ffffff', tint) } }
  }
}

function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16))
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16))
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('')
}

/** custGeom → SVG path in box-local px coordinates. */
function customPath(cg: XEl, box: Box): string | undefined {
  const paths = kids(kid(cg, 'pathLst'), 'path')
  let d = ''
  for (const p of paths) {
    const pw = num(p.a.w) || 1
    const ph = num(p.a.h) || 1
    const sx = box.w / pw
    const sy = box.h / ph
    const pt = (el: XEl | undefined) => `${(num(el?.a.x, 0)! * sx).toFixed(2)} ${(num(el?.a.y, 0)! * sy).toFixed(2)}`
    let cx = 0
    let cy = 0
    for (const c of p.c) {
      const pts = kids(c, 'pt')
      switch (c.n) {
        case 'moveTo':
          d += `M${pt(pts[0])} `
          cx = num(pts[0]?.a.x, 0)! * sx
          cy = num(pts[0]?.a.y, 0)! * sy
          break
        case 'lnTo':
          d += `L${pt(pts[0])} `
          cx = num(pts[0]?.a.x, 0)! * sx
          cy = num(pts[0]?.a.y, 0)! * sy
          break
        case 'cubicBezTo':
          d += `C${pts.map(pt).join(' ')} `
          cx = num(pts[2]?.a.x, 0)! * sx
          cy = num(pts[2]?.a.y, 0)! * sy
          break
        case 'quadBezTo':
          d += `Q${pts.map(pt).join(' ')} `
          cx = num(pts[1]?.a.x, 0)! * sx
          cy = num(pts[1]?.a.y, 0)! * sy
          break
        case 'arcTo': {
          const wR = num(c.a.wR, 0)! * sx
          const hR = num(c.a.hR, 0)! * sy
          const st = (num(c.a.stAng, 0)! / 60000) * (Math.PI / 180)
          const sw = (num(c.a.swAng, 0)! / 60000) * (Math.PI / 180)
          const ccx = cx - wR * Math.cos(st)
          const ccy = cy - hR * Math.sin(st)
          const ex = ccx + wR * Math.cos(st + sw)
          const ey = ccy + hR * Math.sin(st + sw)
          d += `A${wR.toFixed(2)} ${hR.toFixed(2)} 0 ${Math.abs(sw) > Math.PI ? 1 : 0} ${sw > 0 ? 1 : 0} ${ex.toFixed(2)} ${ey.toFixed(2)} `
          cx = ex
          cy = ey
          break
        }
        case 'close':
          d += 'Z '
          break
      }
    }
  }
  return d.trim() || undefined
}
