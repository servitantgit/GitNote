import { chartKeys, pointBudget, readSavedChart, showable, type ChartModel } from '../xlsx/chart'
import { fileHex } from '../color'
import { OpcPackage, relOfType, type Rels } from '../opc'
import type { RNode } from '../raw'
import { parseTheme, type Theme } from '../theme'
import { emuToPt } from '../units'
import { desc, descAll, kid, kids, num, DOCX_UNDERSTOOD, parseXml, parseXmlStream, path, TreeBuilder, type SaxHandler, type XEl } from '../xml'
import { formatNumber, Numbering } from './numbering'
import { ommlText } from './omml'
import { mathOf } from '../math/omml'
import { readDocxComments, type DocxComments } from './comments'
import {
  borderCss, merge, mergePs, readMargins, readPPr, readRPr, readTableBorders, shading, StyleSheet, tabLeader, type NumPr,
} from './styles'
import type {
  Block, CellBorders, DocxMeta, HeaderFooters, HFKind, Inline, ListMarker, PageSet, PageSetup, Paragraph, ParaStyle, PTab, RunSet, RunStyle, SrcRef, Table, TrackMark, TableCell, TableRow,
} from './types'
import { DEFAULT_PAGE, RUN_OBJECTS, RUN_TEXT } from './types'

interface FieldState {
  instr: string
  phase: 'instr' | 'result'
  kind?: 'PAGE' | 'NUMPAGES'
  href?: string
}

interface Sink {
  push(x: Inline): void
  pageBreak(): void
  /** the last character pushed joins comment `id` (a comment without a range of its own) */
  markLast(id: string): void
}

export type Layer = { ps: ParaStyle; rs: RunStyle }

export interface ParaRecord {
  layer?: Layer
  num?: NumPr
  ro: boolean
  sid: string
  lst?: 'bullet' | 'number'
  marker?: ListMarker
}

/** run ordinal → original source (reconversion of generated XML) */
export interface GenRun {
  src?: SrcRef
  d?: RunSet
  /** comment threads covering the run */
  cm?: string[]
}

export interface ConvHooks {
  /** registers an editable paragraph; returns its id */
  para?(el: XEl, rec: ParaRecord): number | undefined
  forced?: { pid: number; root: XEl; map: GenRun[]; layer?: Layer; marker?: ListMarker; rec?: ParaRecord }
  /** body item currently being converted (tables remember it) */
  item?: () => number
  /** comment ranges in the body: the thread root of a w:id (undefined: not a known comment) */
  comment?(num: string | undefined): string | undefined
  /** the number a footnote / endnote reference shows (its place among the document's notes) */
  note?(kind: 'foot' | 'end', id: string | undefined): string | undefined
  /** the chart read from the chart part at `target`, where it could be */
  chart?(target: string): ChartModel | undefined
}

const sameMarks = (a: string[] | undefined, b: string[] | undefined) => (a?.length ?? 0) === (b?.length ?? 0) && (!a || a.every((x, i) => b![i] === x))

function fieldKind(instr: string): 'PAGE' | 'NUMPAGES' | undefined {
  const m = /^\s*(PAGE|NUMPAGES|SECTIONPAGES)\b/i.exec(instr)
  if (!m) return undefined
  return m[1].toUpperCase() === 'PAGE' ? 'PAGE' : 'NUMPAGES'
}

function sameRecord(a: object | undefined, b: object | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return !a && !b
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false
  return true
}

function cssLen(style: string | undefined, prop: string): number | undefined {
  if (!style) return undefined
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([\\d.]+)\\s*(pt|in|px|cm|mm)?`, 'i').exec(style)
  if (!m) return undefined
  const v = Number(m[1])
  switch ((m[2] ?? 'px').toLowerCase()) {
    case 'pt': return v
    case 'in': return v * 72
    case 'cm': return (v * 72) / 2.54
    case 'mm': return (v * 72) / 25.4
    default: return v * 0.75
  }
}

export function pageSetup(sectPr: XEl | undefined): PageSetup {
  if (!sectPr) return { ...DEFAULT_PAGE }
  const sz = kid(sectPr, 'pgSz')
  const mar = kid(sectPr, 'pgMar')
  const t = (v: string | undefined, d: number) => (v === undefined ? d : Math.abs(Number(v)) / 20)
  let w = t(sz?.a.w, DEFAULT_PAGE.w)
  let h = t(sz?.a.h, DEFAULT_PAGE.h)
  if (sz?.a.orient === 'landscape' && h > w) [w, h] = [h, w]
  const cols = kid(sectPr, 'cols')
  const n = Number(cols?.a.num ?? 1)
  return {
    w, h,
    mt: t(mar?.a.top, 72), mr: t(mar?.a.right ?? mar?.a.end, 72), mb: t(mar?.a.bottom, 72), ml: t(mar?.a.left ?? mar?.a.start, 72),
    header: t(mar?.a.header, 36), footer: t(mar?.a.footer, 36),
    ...(n > 1 && n <= 12 ? { cols: n, colGap: t(cols?.a.space, 36) } : {}),
  }
}

// runs inside w:del / w:moveFrom count: deleted text is shown (tracked changes) and written back
const RUN_STOP = new Set(['p', 'oMath', 'oMathPara', 'pPr', 'rPr', 'r', 'fldSimple'])
/** inline elements that stand in the run order like a run: kept as a whole, copied verbatim on write-back */
const RUN_LIKE = new Set(['r', 'oMath', 'oMathPara', 'fldSimple'])

/** Runs of a paragraph in preorder (the ordinal is the run's identity for write-back). */
export function collectRuns(p: XEl): Map<XEl, number> {
  const m = new Map<XEl, number>()
  const rec = (n: XEl) => {
    for (const c of n.c) {
      if (RUN_LIKE.has(c.n)) m.set(c, m.size)
      if (!RUN_STOP.has(c.n)) rec(c)
    }
  }
  rec(p)
  return m
}

/** the text of an element made of runs (a simple field, ruby), tabs and breaks as the converter reads them */
function textOfRuns(e: XEl): string {
  let s = ''
  for (const c of e.c) {
    switch (c.n) {
      case 't': case 'delText': s += c.t; break
      case 'tab': case 'ptab': s += '\t'; break
      case 'br': if (c.a.type !== 'page') s += '\n'; break
      case 'cr': s += '\n'; break
      case 'noBreakHyphen': s += '\u2011'; break
      case 'softHyphen': s += '\u00AD'; break
      case 'rPr': case 'rubyPr': case 'rt': break
      default: s += textOfRuns(c)
    }
  }
  return s
}

/**
 * Runs lying inside a PAGE / NUMPAGES complex field (begin … end): the converter models those as one field, every other
 * field run is kept as it is. A field left open at the end of the list is not one of them.
 */
function pageFieldRuns(runs: Iterable<XEl>): Set<XEl> {
  const out = new Set<XEl>()
  const open: { instr: string; runs: XEl[]; phase: 'instr' | 'result' }[] = []
  for (const r of runs) {
    if (r.n !== 'r') continue
    for (const f of open) f.runs.push(r)
    for (const c of r.c) {
      if (c.n === 'fldChar') {
        if (c.a.fldCharType === 'begin') open.push({ instr: '', runs: [r], phase: 'instr' })
        else if (c.a.fldCharType === 'separate' && open.length) open[open.length - 1].phase = 'result'
        else if (c.a.fldCharType === 'end') {
          const f = open.pop()
          // (a field inside the instruction of another is not one the converter models: its runs are kept as they are)
          if (f && fieldKind(f.instr) && !open.some((o) => o.phase === 'instr')) for (const x of f.runs) out.add(x)
        }
      } else if (c.n === 'instrText' && open.length && open[open.length - 1].phase === 'instr') open[open.length - 1].instr += c.t
    }
  }
  return out
}

const RPR_READ = new Set(['b', 'bCs', 'i', 'iCs', 'strike', 'dstrike', 'caps', 'smallCaps', 'vanish', 'u', 'color', 'sz', 'szCs', 'rFonts', 'highlight', 'shd', 'vertAlign', 'spacing'])

/** a signature of the run properties the converter does not read into a style (language, character style, direction…) */
function rprExtra(rPr: XEl | undefined): string | undefined {
  let sig: string | undefined
  for (const c of rPr?.c ?? []) if (!RPR_READ.has(c.n)) (sig ??= ''), (sig += c.n + JSON.stringify(c.a) + ';')
  return sig
}

const pick = (o: { src?: SrcRef }, _k: 'src'): { src?: SrcRef } => (o.src ? { src: o.src } : {})

/** run children the converter reads (or that carry nothing): any other child makes the run one to keep as it is */
const RUN_KNOWN = new Set([
  'rPr', 'fldChar', 'instrText', 't', 'delText', 'tab', 'ptab', 'br', 'cr', 'noBreakHyphen', 'softHyphen', 'sym', 'drawing', 'commentReference',
  'pict', 'object', 'footnoteReference', 'endnoteReference', 'lastRenderedPageBreak', 'annotationRef', 'footnoteRef', 'endnoteRef', 'separator',
  'continuationSeparator', 'pgNum', 'dayShort', 'dayLong', 'monthShort', 'monthLong', 'yearShort', 'yearLong', 'contentPart', 'ruby',
])

/** Paragraphs of a body item (root included) in preorder. */
export function collectParas(roots: XEl[], into = new Map<XEl, number>()): Map<XEl, number> {
  const rec = (n: XEl) => {
    if (n.n === 'p') into.set(n, into.size)
    for (const c of n.c) rec(c)
  }
  for (const r of roots) rec(r)
  return into
}

export function markerOf(numbering: Numbering, num: NumPr, markRs: RunStyle): { marker: ListMarker; lst: 'bullet' | 'number' } | undefined {
  const listed = numbering.next(num.numId, num.ilvl)
  if (!listed) return undefined
  const ms = merge<RunStyle>(markRs, listed.level.rs)
  delete ms.u
  delete ms.hl
  return {
    marker: { text: listed.level.suff === 'space' ? listed.text + ' ' : listed.text, s: ms, tab: listed.level.suff === 'tab' },
    lst: listed.level.fmt === 'bullet' ? 'bullet' : 'number',
  }
}

export class Converter {
  private fields: FieldState[] = []
  private tableLayer?: Layer
  /** the tracked change (w:ins / w:del) the runs being read belong to */
  private tc?: TrackMark
  private boxDepth = 0
  /** the wrapper elements (content control, smart tag…) the runs being read lie in, by number */
  private wraps: number[] = []
  private wrapSeq = 0
  private tableDepth = 0
  private cur?: { pid?: number; runs: Map<XEl, number>; forced?: ConvHooks['forced'] }
  /** inlines made so far (a run that makes none is kept as an opaque one) */
  private made = 0
  /** runs of the paragraph being read that lie inside a field modeled as one */
  private inField = new Set<XEl>()
  /** comment threads whose range is open at this point of the body, in the order they opened */
  private open: string[] = []
  /** threads whose range was seen */
  readonly seen = new Set<string>()

  constructor(
    private styles: StyleSheet,
    private numbering: Numbering,
    private theme: Theme,
    private rels: Rels,
    private hooks: ConvHooks = {},
  ) {}

  blocks(el: XEl, out: Block[]): void {
    switch (el.n) {
      case 'p':
        this.paragraph(el, out)
        break
      case 'tbl':
        out.push(this.table(el))
        break
      case 'sdt':
        for (const c of kid(el, 'sdtContent')?.c ?? []) this.blocks(c, out)
        break
      case 'customXml':
      case 'ins':
      case 'smartTag':
      case 'sdtContent':
        for (const c of el.c) this.blocks(c, out)
        break
      case 'commentRangeStart':
      case 'commentRangeEnd':
        this.rangeMark(el)
        break
    }
  }

  /** a comment range opens or closes (generated paragraphs carry their marks in `forced.map` instead) */
  private rangeMark(el: XEl) {
    if (this.hooks.forced || !this.hooks.comment) return
    const id = this.hooks.comment(el.a.id)
    if (!id) return
    if (el.n === 'commentRangeStart') {
      if (!this.open.includes(id)) this.open.push(id)
      this.seen.add(id)
    } else this.open = this.open.filter((x) => x !== id)
  }

  /** comment threads covering what is converted now */
  private marks(): string[] | undefined {
    return this.open.length ? [...this.open] : undefined
  }

  paragraph(el: XEl, out: Block[]): void {
    const pPr = kid(el, 'pPr')
    const d = readPPr(pPr)
    const st = this.styles.para(d.styleId)
    const forced = this.hooks.forced?.root === el ? this.hooks.forced : undefined
    const layer = forced ? forced.layer : this.tableLayer
    const numPr = d.numPr ?? st.numPr
    const level = numPr && numPr.numId !== '0' ? this.numbering.level(numPr.numId, numPr.ilvl) : undefined
    const ps = mergePs(this.styles.docPs, layer?.ps, st.ps, level?.ps, d.ps)
    // (the stops taken away are not stops of the paragraph)
    if (ps.tabs) {
      const tabs = ps.tabs.filter((t) => t.a !== 'clear')
      if (tabs.length) ps.tabs = tabs
      else delete ps.tabs
    }
    const base = merge<RunStyle>(this.styles.docRs, layer?.rs, st.rs)
    const markRs = merge<RunStyle>(base, readRPr(kid(pPr, 'rPr'), this.theme))
    const sid = d.styleId ?? this.styles.defaultPara ?? ''
    const code = this.styles.code(sid)
    let cur: Paragraph = { t: 'p', ps, runs: [], markSz: markRs.sz, markFont: markRs.font, sid, ...(code !== undefined ? { code } : {}) }
    if (ps.pageBreakBefore) cur.pb = true
    let lst: 'bullet' | 'number' | undefined
    if (level && numPr) {
      if (forced) {
        lst = level.fmt === 'bullet' ? 'bullet' : 'number'
        if (forced.marker) cur.marker = forced.marker
        else cur.marker = { text: level.fmt === 'bullet' ? '•' : '', s: merge<RunStyle>(markRs, level.rs), tab: level.suff === 'tab' }
      } else {
        const m = markerOf(this.numbering, numPr, markRs)
        if (m) {
          cur.marker = m.marker
          lst = m.lst
        }
      }
      if (lst) {
        cur.lst = lst
        cur.ilvl = numPr.ilvl
      }
    }
    const rec: ParaRecord = {
      layer,
      num: numPr && numPr.numId !== '0' ? numPr : undefined,
      ro: this.fields.length > 0 || this.boxDepth > 0 || this.tableDepth > 1,
      sid,
      lst,
      marker: cur.marker,
    }
    if (forced) forced.rec = rec
    const pid = forced ? forced.pid : this.hooks.para?.(el, rec)
    if (pid !== undefined) cur.pid = pid
    const saved = this.cur
    this.cur = { pid, runs: collectRuns(el), forced }
    const savedField = this.inField
    this.inField = pageFieldRuns(this.cur.runs.keys())
    const parts: Paragraph[] = [cur]
    // comments without a range whose reference stands before any text: they take the next character
    let waiting: string[] = []
    const sink: Sink = {
      push: (x) => {
        if (waiting.length && (x.t === 'img' || (x.t === 'text' && x.text))) {
          const cm = [...new Set([...(x.cm ?? []), ...waiting])]
          waiting = []
          if (x.t === 'text' && x.text.length > 1) {
            sink.push({ ...x, text: x.text.slice(0, 1), cm })
            sink.push({ ...x, text: x.text.slice(1) })
            return
          }
          x = { ...x, cm }
        }
        this.made++
        // pictures, boxes, fields, note references inside w:ins / w:del belong to the change too
        if (this.tc && x.t !== 'text' && !x.tc) x = { ...x, tc: this.tc } as Inline
        const runs = cur.runs
        const last = runs[runs.length - 1]
        if (x.t === 'text' && !x.cm) delete x.cm
        if (
          x.t === 'text' && last?.t === 'text' && last.href === x.href && last.lk === x.lk && last.rp === x.rp &&
          sameRecord(last.s, x.s) && sameRecord(last.d, x.d) && sameMarks(last.cm, x.cm) && sameRecord(last.tc, x.tc)
        )
          last.text += x.text
        else runs.push(x)
      },
      markLast: (id) => {
        const runs = cur.runs
        const i = runs.length - 1
        const last = runs[i]
        if (!last || (last.t !== 'text' && last.t !== 'img')) {
          waiting.push(id)
          return
        }
        if (last.cm?.includes(id)) return
        const cm = [...(last.cm ?? []), id]
        if (last.t === 'img' || last.text.length <= 1) runs[i] = { ...last, cm }
        else runs.splice(i, 1, { ...last, text: last.text.slice(0, -1) }, { ...last, text: last.text.slice(-1), cm })
      },
      pageBreak: () => {
        cur = { t: 'p', ps, runs: [], markSz: markRs.sz, markFont: markRs.font, pb: true, sid, ...(code !== undefined ? { code } : {}) }
        if (pid !== undefined) cur.pid = pid
        parts.push(cur)
      },
    }
    this.inlines(el.c, base, undefined, undefined, sink)
    this.cur = saved
    this.inField = savedField
    if (this.fields.length > 0) rec.ro = true
    for (const p of parts) {
      if (rec.ro) p.ro = true
      out.push(p)
    }
    if (d.sectPr) out.push({ t: 'sect', page: pageSetup(d.sectPr), kind: kid(d.sectPr, 'type')?.a.val ?? 'nextPage' })
  }

  /** source reference + user formatting (+ comment marks) of a run element */
  private srcOf(r: XEl): { src?: SrcRef; d?: RunSet; cm?: string[] } {
    const cur = this.cur
    if (!cur) return { cm: this.marks() }
    const k = cur.runs.get(r)
    if (cur.forced) {
      const g = k === undefined ? undefined : cur.forced.map[k]
      return g ? { src: g.src, d: g.d, cm: g.cm } : {}
    }
    if (k === undefined) return { cm: this.marks() }
    return cur.pid !== undefined ? { src: [cur.pid, k], cm: this.marks() } : { cm: this.marks() }
  }

  private inlines(children: XEl[], base: RunStyle, href: string | undefined, lk: string | undefined, sink: Sink): void {
    for (const c of children) {
      switch (c.n) {
        case 'r':
          this.run(c, base, href, lk, sink)
          break
        case 'hyperlink': {
          const id = c.a['r:id']
          const target = id ? this.rels.get(id)?.target : c.a.anchor ? '#' + c.a.anchor : undefined
          const link = id ? 'r:' + id : c.a.anchor ? 'a:' + c.a.anchor : undefined
          this.inlines(c.c, base, target ?? href, link ?? lk, sink)
          break
        }
        case 'fldSimple': {
          const kind = fieldKind(c.a.instr ?? '')
          const r = kid(c, 'r')
          const s = merge(base, readRPr(kid(r, 'rPr'), this.theme))
          if (kind) sink.push({ t: 'field', kind, s, ...this.srcOf(c) })
          else if (this.cur && !desc(c, 'drawing') && !desc(c, 'pict')) {
            // a field (DATE, MERGEFIELD…) shows its result and stays whole: one object, written back as it is
            const text = textOfRuns(c)
            if (text) sink.push({ t: 'ref', text, s, ...pick(this.srcOf(c), 'src'), ...(this.tc ? { tc: this.tc } : {}) })
            else sink.push({ t: 'shape', w: 0, h: 0, ...pick(this.srcOf(c), 'src'), ...(this.tc ? { tc: this.tc } : {}) })
          } else this.inlines(c.c, base, href, lk, sink)
          break
        }
        case 'ins':
        case 'moveTo':
        case 'del':
        case 'moveFrom': {
          const prev = this.tc
          this.tc = { k: c.n === 'ins' || c.n === 'moveTo' ? 'ins' : 'del', id: c.a.id, author: c.a.author, date: c.a.date, ...(c.n === 'moveTo' || c.n === 'moveFrom' ? { mv: true } : {}) }
          // a deletion inside an insertion: both stay (rejecting everything must take the text out)
          if (this.tc.k === 'del' && prev?.k === 'ins') this.tc.ins = prev
          this.inlines(c.c, base, href, lk, sink)
          this.tc = prev
          break
        }
        case 'smartTag':
        case 'customXml':
        case 'bdo':
        case 'dir':
        case 'sdt':
          // (the wrappers are kept by the writer; runs in different ones must not merge, see `rp`)
          this.wraps.push(++this.wrapSeq)
          this.inlines(c.n === 'sdt' ? kid(c, 'sdtContent')?.c ?? [] : c.c, base, href, lk, sink)
          this.wraps.pop()
          break
        case 'commentRangeStart':
        case 'commentRangeEnd':
          this.rangeMark(c)
          break
        case 'oMath':
        case 'oMathPara': {
          const text = ommlText(c)
          const s = { ...base, i: true, font: '"Cambria Math", "STIX Two Math", serif' }
          // a formula of a Markdown file (ours): its TeX comes along, to be drawn and saved as it was written
          const math = mathOf(c.a)
          // an equation is one object: it is written back as it was, not as the flat text shown here
          if (this.cur) sink.push({ t: 'ref', text, s, ...pick(this.srcOf(c), 'src'), ...(this.tc ? { tc: this.tc } : {}), ...(math ? { math } : {}) })
          else if (text) sink.push({ t: 'text', text, s })
          break
        }
      }
    }
  }

  private run(r: XEl, base: RunStyle, href: string | undefined, lk: string | undefined, sink: Sink): void {
    const rPr = kid(r, 'rPr')
    const s = merge<RunStyle>(base, this.styles.char(kid(rPr, 'rStyle')?.a.val), readRPr(rPr, this.theme))
    const { src, d, cm } = this.srcOf(r)
    const tc = this.tc
    const made = this.made
    // several objects in one run, or text next to one: each object is told which it is, or saving would write the whole run once per object
    const objs = src && src.length === 2 && !this.cur?.forced ? r.c.filter((c) => RUN_OBJECTS.has(c.n)) : []
    const shared = objs.length > 1 || (objs.length === 1 && r.c.some((c) => RUN_TEXT.has(c.n)))
    const objSrc = (c: XEl): SrcRef | undefined => (shared && src ? [src[0], src[1], objs.indexOf(c)] : src)
    // what the run holds that is not read into text or an object is not lost: the run stays as an object that is written back as it is
    const keep = () => {
      if (this.made === made && src) sink.push({ t: 'shape', w: 0, h: 0, src, ...(tc ? { tc } : {}) })
    }
    if (s.vanish) return keep()
    if (r.c.some((c) => c.n === 'ruby')) {
      // ruby: the base text is shown, the run with its annotation stays whole
      const text = textOfRuns(kid(r, 'ruby')!.c.find((c) => c.n === 'rubyBase') ?? r)
      sink.push({ t: 'ref', text, s, ...(src ? { src } : {}), ...(tc ? { tc } : {}) })
      return
    }
    // a column break, a break that clears a float, an absolute position tab: the run is kept whole (the text model has only '\n' and '\t')
    if (src && !this.fields.length && r.c.some((c) => c.n === 'ptab' || (c.n === 'br' && (c.a.type === 'column' || c.a.clear !== undefined)))) {
      const pt = r.c.find((c) => c.n === 'ptab')
      const al = pt?.a.alignment
      const ld = tabLeader(pt?.a.leader)
      const ptab: PTab | undefined = pt ? { a: al === 'center' ? 'center' : al === 'right' ? 'right' : 'left', ...(ld ? { ld } : {}), ...(pt.a.relativeTo === 'indent' ? { indent: true } : {}) } : undefined
      sink.push({ t: 'ref', text: textOfRuns(r), s, src, ...(tc ? { tc } : {}), ...(ptab ? { ptab } : {}) })
      return
    }
    const rp = (rprExtra(rPr) ?? '') + (this.wraps.length ? '|w' + this.wraps.join('.') : '') || undefined
    const text = (t: string, style = s, link = href) => sink.push({ t: 'text', text: t, s: style, href: link, lk: link === href ? lk : undefined, src, d, cm, ...(tc ? { tc } : {}), ...(rp ? { rp } : {}) })
    for (const c of r.c) {
      const f = this.fields[this.fields.length - 1]
      // only the result of the outermost field is shown: no instruction, and nothing of a field inside an instruction
      const hidden = this.fields.some((x) => x.phase === 'instr' || x.kind)
      const inInstr = (n: number) => this.fields.slice(0, n).some((x) => x.phase === 'instr')
      switch (c.n) {
        case 'fldChar': {
          const type = c.a.fldCharType
          if (type === 'begin') this.fields.push({ instr: '', phase: 'instr' })
          else if (type === 'separate' && f) {
            f.phase = 'result'
            f.kind = fieldKind(f.instr)
            const link = /HYPERLINK\s+(?:\\l\s+)?"([^"]+)"/.exec(f.instr)
            if (link) f.href = /\\l/.test(f.instr) ? '#' + link[1] : link[1]
            if (f.kind && !inInstr(this.fields.length - 1)) sink.push({ t: 'field', kind: f.kind, s, src })
          } else if (type === 'end') {
            if (f && f.phase === 'instr') {
              const kind = fieldKind(f.instr)
              if (kind && !inInstr(this.fields.length - 1)) sink.push({ t: 'field', kind, s, src })
            }
            this.fields.pop()
          }
          break
        }
        case 'instrText':
          if (f) f.instr += c.t
          break
        case 't':
        case 'delText':
          if (hidden) break
          if (c.t) text(c.t, s, [...this.fields].reverse().find((x) => x.href)?.href ?? href)
          break
        case 'tab':
        case 'ptab':
          if (!hidden) text('\t')
          break
        case 'br':
          if (c.a.type === 'page') sink.pageBreak()
          else text('\n')
          break
        case 'cr':
          text('\n')
          break
        case 'noBreakHyphen':
          text('\u2011')
          break
        case 'softHyphen':
          text('\u00AD')
          break
        case 'sym': {
          const code = parseInt(c.a.char ?? '', 16)
          if (code) text(String.fromCharCode(code >= 0xf000 ? code - 0xf000 : code), { ...s, font: c.a.font ? `"${c.a.font}", ${s.font ?? 'serif'}` : s.font })
          break
        }
        case 'drawing':
          this.drawing(c, href, sink, objSrc(c), cm)
          break
        case 'commentReference': {
          // a comment without a range: it covers the character before it
          const id = !this.hooks.forced && this.hooks.comment ? this.hooks.comment(c.a.id) : undefined
          if (id && !this.seen.has(id)) {
            this.seen.add(id)
            sink.markLast(id)
          }
          break
        }
        case 'pict':
        case 'object':
          this.vml(c, href, sink, objSrc(c))
          break
        case 'footnoteReference':
        case 'endnoteReference':
          sink.push({ t: 'ref', text: this.hooks.note?.(c.n === 'footnoteReference' ? 'foot' : 'end', c.a.id) ?? c.a.id ?? '*', s: { ...s, va: 'sup' }, src: objSrc(c) })
          break
      }
    }
    // the runs of a field the converter does not model as one (DATE, MERGEFIELD, TOC…), and runs made of markup it does not read
    // (and the text of a field nested in an instruction, which is not shown)
    if (r.c.some((c) => !RUN_KNOWN.has(c.n) || ((c.n === 'fldChar' || c.n === 'instrText' || c.n === 't' || c.n === 'delText' || c.n === 'tab' || c.n === 'ptab') && !this.inField.has(r))) || r.a['#mc']) keep()
  }

  private target(id: string | undefined): string | undefined {
    if (!id) return undefined
    const rel = this.rels.get(id)
    return rel && !rel.external ? rel.target : undefined
  }

  private boxBlocks(roots: XEl[]): Block[] {
    const blocks: Block[] = []
    const saved = this.cur
    this.boxDepth++
    for (const t of roots) for (const c of t.c) this.blocks(c, blocks)
    this.boxDepth--
    this.cur = saved
    return blocks
  }

  private drawing(d: XEl, href: string | undefined, sink: Sink, src?: SrcRef, cm?: string[]): void {
    const box = kid(d, 'inline') ?? kid(d, 'anchor')
    if (!box) return
    const ext = kid(box, 'extent')
    const w = emuToPt(num(ext?.a.cx, 0))
    const h = emuToPt(num(ext?.a.cy, 0))
    const docPr = kid(box, 'docPr')
    const gd = path(box, 'graphic', 'graphicData')
    const txbx = descAll(gd, 'txbxContent')
    if (txbx.length) {
      const blocks = this.boxBlocks(txbx)
      const spPr = desc(gd, 'spPr')
      // hex digits only: the fill becomes a CSS background, where anything more (a url()) would be loaded
      const fill = fileHex(path(spPr, 'solidFill', 'srgbClr')?.a.val)
      const ln = fileHex(path(spPr, 'ln', 'solidFill', 'srgbClr')?.a.val)
      sink.push({ t: 'box', w, h, blocks, fill, border: ln ? `1px solid ${ln}` : undefined, src })
      return
    }
    const blip = desc(gd, 'blip')
    const target = this.target(blip?.a['r:embed'])
    if (target) {
      const click = this.rels.get(kid(docPr, 'hlinkClick')?.a['r:id'] ?? '')?.target
      sink.push({ t: 'img', target, w, h, alt: docPr?.a.descr || docPr?.a.title || undefined, href: click ?? href, src, rid: blip?.a['r:embed'], ...(cm ? { cm } : {}) })
      return
    }
    const chart = desc(gd, 'chart')
    if (chart) {
      const model = this.hooks.chart?.(this.target(chart.a['r:id']) ?? '')
      sink.push({ t: 'shape', w, h, label: 'Chart', ...(model ? { chart: model } : {}), src })
    }
    else if (desc(gd, 'relIds')) sink.push({ t: 'shape', w, h, label: 'Diagram', src })
    else sink.push({ t: 'shape', w: 0, h: 0, src })
  }

  private vml(el: XEl, href: string | undefined, sink: Sink, src?: SrcRef): void {
    const tb = desc(el, 'txbxContent')
    const shape = desc(el, 'shape') ?? desc(el, 'rect')
    const style = shape?.a.style
    const w = cssLen(style, 'width') ?? 0
    const h = cssLen(style, 'height') ?? 0
    if (tb) {
      sink.push({ t: 'box', w, h, blocks: this.boxBlocks([tb]), src })
      return
    }
    const target = this.target(desc(el, 'imagedata')?.a['r:id'])
    if (target && w && h) sink.push({ t: 'img', target, w, h, href, src })
    else sink.push({ t: 'shape', w: 0, h: 0, src })
  }

  table(el: XEl): Table {
    this.tableDepth++
    try {
      const t = this.tableInner(el)
      if (this.tableDepth === 1 && this.hooks.item) t.item = this.hooks.item()
      return t
    } finally {
      this.tableDepth--
    }
  }

  private tableInner(el: XEl): Table {
    const tblPr = kid(el, 'tblPr')
    const ts = this.styles.table(kid(tblPr, 'tblStyle')?.a.val)
    const look = readLook(kid(tblPr, 'tblLook'))
    const borders = { ...ts.borders, ...readTableBorders(kid(tblPr, 'tblBorders')) }
    const mar = { top: 0, bottom: 0, left: 5.4, right: 5.4, ...ts.cellMar, ...readMargins(kid(tblPr, 'tblCellMar')) }
    const cols = kids(kid(el, 'tblGrid'), 'gridCol').map((g) => (num(g.a.w) ?? 0) / 20)
    const jc = kid(tblPr, 'jc')?.a.val
    const ind = kid(tblPr, 'tblInd')
    const rowEls = flatten(el, 'tr')

    interface Tmp extends TableCell { gs: number; vm?: 'restart' | 'continue'; tcB: ReturnType<typeof readTableBorders>; gone?: boolean; ri: number }
    const grid: { row: TableRow; cells: Tmp[] }[] = []
    let nCols = cols.length
    rowEls.forEach((tr, ri) => {
      const trPr = kid(tr, 'trPr')
      const th = kid(trPr, 'trHeight')
      const row: TableRow = { cells: [], src: ri }
      if (th?.a.val) {
        row.h = Number(th.a.val) / 20
        row.exact = th.a.hRule === 'exact'
      }
      if (kid(trPr, 'tblHeader')) row.header = true
      let col = num(kid(trPr, 'gridBefore')?.a.val, 0)!
      const cells: Tmp[] = []
      for (const [tci, tc] of flatten(tr, 'tc').entries()) {
        const tcPr = kid(tc, 'tcPr')
        const span = Math.max(1, num(kid(tcPr, 'gridSpan')?.a.val, 1)!)
        const vmEl = kid(tcPr, 'vMerge')
        const conds: string[] = []
        if (!look.noVBand) conds.push((col - (look.firstCol ? 1 : 0)) % 2 === 0 ? 'band1Vert' : 'band2Vert')
        if (!look.noHBand) {
          const bi = ri - (look.firstRow ? 1 : 0)
          if (bi >= 0) conds.push(bi % 2 === 0 ? 'band1Horz' : 'band2Horz')
        }
        if (look.firstCol && col === 0) conds.push('firstCol')
        if (look.lastCol && nCols && col + span >= nCols) conds.push('lastCol')
        if (look.firstRow && ri === 0) conds.push('firstRow')
        if (look.lastRow && ri === rowEls.length - 1) conds.push('lastRow')
        let shd = ts.shd
        let crs: RunStyle = {}
        for (const k of conds) {
          const cf = ts.cond[k]
          if (!cf) continue
          if (cf.shd) shd = cf.shd
          crs = merge(crs, cf.rs)
        }
        shd = shading(kid(tcPr, 'shd')) ?? shd
        const prev = this.tableLayer
        this.tableLayer = { ps: ts.ps, rs: merge(ts.rs, crs) }
        const blocks: Block[] = []
        for (const c of tc.c) if (c.n !== 'tcPr') this.blocks(c, blocks)
        this.tableLayer = prev
        const cm = readMargins(kid(tcPr, 'tcMar'))
        const va = kid(tcPr, 'vAlign')?.a.val
        const tcW = kid(tcPr, 'tcW')
        cells.push({
          blocks,
          src: [ri, tci],
          colSpan: span,
          rowSpan: 1,
          w: tcW && (tcW.a.type ?? 'dxa') === 'dxa' ? Number(tcW.a.w) / 20 : undefined,
          shd,
          vAlign: va === 'center' ? 'middle' : va === 'bottom' ? 'bottom' : undefined,
          borders: {},
          pad: [cm.top ?? mar.top, cm.right ?? mar.right, cm.bottom ?? mar.bottom, cm.left ?? mar.left],
          gs: col,
          vm: vmEl ? (vmEl.a.val === 'restart' ? 'restart' : 'continue') : undefined,
          tcB: readTableBorders(kid(tcPr, 'tcBorders')),
          ri,
        })
        col += span
      }
      nCols = Math.max(nCols, col)
      grid.push({ row, cells })
    })

    // vertical merges
    for (let ri = 0; ri < grid.length; ri++) {
      for (const cell of grid[ri].cells) {
        if (cell.gone || !cell.vm) continue
        for (let rj = ri + 1; rj < grid.length; rj++) {
          const below = grid[rj].cells.find((c) => c.gs === cell.gs)
          if (!below || below.vm !== 'continue') break
          below.gone = true
          cell.rowSpan++
        }
      }
    }
    const nRows = grid.length
    const rows: TableRow[] = grid.map(({ row, cells }) => {
      for (const c of cells) {
        if (c.gone) continue
        const lastRow = c.ri + c.rowSpan - 1 === nRows - 1
        const b: CellBorders = {
          t: borderCss(c.tcB.top !== undefined ? c.tcB.top : c.ri === 0 ? borders.top : borders.insideH),
          b: borderCss(c.tcB.bottom !== undefined ? c.tcB.bottom : lastRow ? borders.bottom : borders.insideH),
          l: borderCss(c.tcB.left !== undefined ? c.tcB.left : c.gs === 0 ? borders.left : borders.insideV),
          r: borderCss(c.tcB.right !== undefined ? c.tcB.right : c.gs + c.colSpan >= nCols ? borders.right : borders.insideV),
        }
        const { gs: _gs, vm: _vm, tcB: _tcB, gone: _g, ri: _ri, ...cell } = c
        row.cells.push({ ...cell, borders: b })
      }
      return row
    })
    return {
      t: 'tbl',
      cols,
      rows,
      align: jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : undefined,
      indL: ind && (ind.a.type ?? 'dxa') === 'dxa' ? Number(ind.a.w) / 20 : undefined,
    }
  }
}

function flatten(el: XEl, name: string): XEl[] {
  const out: XEl[] = []
  for (const c of el.c) {
    if (c.n === name) out.push(c)
    else if (c.n === 'sdt') out.push(...flatten(kid(c, 'sdtContent') ?? c, name))
    else if (c.n === 'customXml' || c.n === 'sdtContent') out.push(...flatten(c, name))
  }
  return out
}

function readLook(el: XEl | undefined) {
  const look = { firstRow: true, lastRow: false, firstCol: true, lastCol: false, noHBand: false, noVBand: true }
  if (!el) return look
  const hex = el.a.val
  if (hex && /^[0-9a-fA-F]+$/.test(hex) && el.a.firstRow === undefined) {
    const v = parseInt(hex, 16)
    return {
      firstRow: !!(v & 0x20), lastRow: !!(v & 0x40), firstCol: !!(v & 0x80), lastCol: !!(v & 0x100),
      noHBand: !!(v & 0x200), noVBand: !!(v & 0x400),
    }
  }
  const b = (k: string, d: boolean) => (el.a[k] === undefined ? d : el.a[k] === '1' || el.a[k] === 'true')
  return {
    firstRow: b('firstRow', true), lastRow: b('lastRow', false), firstCol: b('firstColumn', true),
    lastCol: b('lastColumn', false), noHBand: b('noHBand', false), noVBand: b('noVBand', true),
  }
}

// ---------------------------------------------------------------------------

export interface DocxStreamCallbacks {
  onBlocks(blocks: Block[]): void
  onMeta(meta: DocxMeta): void
  onProgress?(loaded: number, total: number): void
  signal?: AbortSignal
  /** Hold blocks until this much time passed so small docs render in one go (ms). */
  initialHoldMs?: number
}

export interface PInfo extends ParaRecord {
  item: number
  ord: number
  /** a paragraph of a table the editor regenerates: the XML it was last converted from (not converted again while the same) */
  xml?: string
}

/** Splits document.xml into prefix / body items / suffix while streaming, keeping exact source text. */
class Capture implements SaxHandler {
  prefix = ''
  items: string[] = []
  suffix = ''
  private buf = ''
  private tail = ''
  private pending = ''
  private inItem = false
  private depth = 0
  private els: XEl[] = []

  constructor(
    private tb: TreeBuilder,
    private onItem: (index: number, els: XEl[]) => void,
  ) {}

  raw = (seg: string) => {
    this.flush()
    this.pending = seg
  }

  /** TreeBuilder onElement target */
  element = (el: XEl) => {
    this.els.push(el)
  }

  private flush() {
    if (!this.pending) return
    if (this.inItem) this.buf += this.pending
    else this.tail += this.pending
    this.pending = ''
  }

  open(name: string, attrs: Record<string, string>): boolean | void {
    if (this.depth === 2) {
      if (this.items.length) this.items[this.items.length - 1] += this.tail
      else this.prefix += this.tail
      this.tail = ''
      this.inItem = true
      this.buf = ''
      this.els = []
    }
    this.flush()
    const skip = this.tb.open(name, attrs)
    if (!skip) this.depth++
    return skip
  }

  close(name: string): void {
    this.flush()
    this.tb.close(name)
    this.depth--
    if (this.depth === 2 && this.inItem) {
      this.inItem = false
      this.items.push(this.buf)
      this.buf = ''
      this.onItem(this.items.length - 1, this.els)
      this.els = []
    }
  }

  text(t: string): void {
    this.flush()
    this.tb.text(t)
  }

  finish() {
    this.flush()
    if (!this.items.length) this.prefix += this.tail
    else this.suffix = this.tail
    this.tail = ''
  }
}

export class DocxDocument {
  // ---- edit state ----
  /** raw XML of each body child (exact source) */
  items: string[] = []
  prefix = ''
  suffix = ''
  info = new Map<number, PInfo>()
  /** where each original paragraph lives in the source (never changes) */
  origLoc = new Map<number, { item: number; ord: number }>()
  /** original paragraph id per (item, ord) */
  ordPid = new Map<string, number>()
  itemParas = new Map<number, number[]>()
  /** (item:ord) → paragraph ids now standing in for that original paragraph */
  groups = new Map<string, number[]>()
  /** paragraphs removed with nothing in their place → the member of their group they followed (undefined: none), see applyEdit */
  gone = new Map<number, number | undefined>()
  genXml = new Map<number, string>()
  /** whole body items replaced by the editor (regenerated tables; '' = deleted) */
  itemXml = new Map<number, string>()
  /**
   * The paragraphs of the tables the editor regenerates, in document order (list numbering counts them there): a table
   * of the file by its body item (none once deleted), a new one by its id (placed in a paragraph group).
   */
  itemTables = new Map<number, number[]>()
  newTables = new Map<number, number[]>()
  /** styles the editor changed → their definition in the file as opened (parsed, and as source) */
  styleOrig = new Map<string, { x: XEl; raw: RNode }>()
  /** page setup of the final section as opened, and the changes made to it (written to every section on save) */
  page: PageSetup = { ...DEFAULT_PAGE }
  pageSet?: PageSet
  /** w:id of the next tracked change written (high: clear of the file's own ids) */
  nextTrackId = 900_000
  private nextPid = 1
  private captured = false
  private edited = false

  private constructor(
    readonly pkg: OpcPackage,
    readonly mainPath: string,
    public rels: Rels,
    readonly styles: StyleSheet,
    public numbering: Numbering,
    readonly theme: Theme,
    readonly comments: DocxComments,
  ) {}

  /** the body's charts by part, read from the values saved with them; a part not read has none (its label shows) */
  readonly charts = new Map<string, ChartModel>()

  private async readCharts() {
    // the document's charts share a budget of points: one read past it keeps its label
    const budget = pointBudget()
    const key = chartKeys()
    for (const rel of this.rels.values()) {
      if (rel.external || !rel.type.endsWith('/chart') || !this.pkg.has(rel.target) || this.charts.has(rel.target)) continue
      const model = await readSavedChart(await this.pkg.xml(rel.target), this.theme, budget).catch((e: Error) => {
        console.warn('[office-engine] chart not read:', e.message)
        return null
      })
      if (model) this.charts.set(rel.target, { ...model, key: key(rel.target) })
    }
  }

  static async open(pkg: OpcPackage, mainPath: string): Promise<DocxDocument> {
    const rels = await pkg.rels(mainPath)
    const themeRel = relOfType(rels, 'theme')
    const theme = parseTheme(themeRel ? await pkg.xml(themeRel.target) : undefined)
    const stylesRel = relOfType(rels, 'styles')
    const numRel = relOfType(rels, 'numbering')
    const styles = new StyleSheet(stylesRel ? await pkg.xml(stylesRel.target) : undefined, theme)
    const numbering = new Numbering(numRel ? await pkg.xml(numRel.target) : undefined, theme)
    const comments = await readDocxComments(pkg, mainPath, rels).catch((e: Error) => {
      console.warn('[office-engine] comments not read:', e.message)
      return readDocxComments(pkg, mainPath, new Map())
    })
    const doc = new DocxDocument(pkg, mainPath, rels, styles, numbering, theme, comments)
    await doc.readCharts()
    const setRel = relOfType(rels, 'settings')
    const settings = setRel ? await pkg.xml(setRel.target).catch(() => undefined) : undefined
    if (settings) {
      const on = (e: XEl | undefined) => !!e && e.a.val !== '0' && e.a.val !== 'false' && e.a.val !== 'off'
      doc.evenOdd = on(kid(settings, 'evenAndOddHeaders'))
      for (const [k, tag] of [['foot', 'footnotePr'], ['end', 'endnotePr']] as const) {
        const pr = kid(settings, tag)
        const fmt = kid(pr, 'numFmt')?.a.val
        if (fmt) doc.noteFmt[k] = fmt
        doc.noteStart[k] = Math.max(1, Math.min(num(kid(pr, 'numStart')?.a.val, 1)!, 999_999))
      }
    }
    return doc
  }

  get dirty() {
    return this.edited || this.pkg.dirty || this.comments.dirty
  }

  markEdited() {
    this.edited = true
  }

  /** relationship ids of the headers / footers shown (final section) */
  hfRefs?: Record<HFKind, string | undefined>
  /** the parts of even pages (shown when `evenOdd`); the editor does not change them */
  evenRefs: { header?: string; footer?: string } = {}
  /** the file sets different headers / footers for odd and even pages */
  evenOdd = false
  /** number format and first number of footnotes / endnotes (settings.xml; Word's defaults otherwise) */
  noteFmt = { foot: 'decimal', end: 'lowerRoman' }
  noteStart = { foot: 1, end: 1 }
  private noteSeq = { foot: new Map<string, number>(), end: new Map<string, number>() }

  /** what a footnote / endnote reference shows: its place among the notes of the document, in the format of its kind */
  noteText = (kind: 'foot' | 'end', id: string | undefined): string | undefined => {
    if (id === undefined) return undefined
    const seq = this.noteSeq[kind]
    let n = seq.get(id)
    if (n === undefined) seq.set(id, (n = seq.size + this.noteStart[kind]))
    return formatNumber(n, this.noteFmt[kind])
  }
  /** headers / footers created by the editor: referenced from the sections on save */
  hfNew = new Map<HFKind, string>()
  /** "different first page" as set by the editor (undefined: as in the file) */
  titlePgSet?: boolean
  /** "different first page" in the file */
  titlePg = false
  /** page setup or header / footer references were changed in this session (sections rebuilt on save) */
  sectTouched = false

  /** the headers / footers, converted with the styles as they are now; undefined when the document has none */
  async headers(): Promise<HeaderFooters | undefined> {
    const r = this.hfRefs
    if (!r || !(Object.values(r).some(Boolean) || this.evenRefs.header || this.evenRefs.footer)) return undefined
    return {
      header: await this.headerFooter(r.header),
      footer: await this.headerFooter(r.footer),
      firstHeader: await this.headerFooter(r.firstHeader),
      firstFooter: await this.headerFooter(r.firstFooter),
      evenHeader: await this.headerFooter(this.evenRefs.header),
      evenFooter: await this.headerFooter(this.evenRefs.footer),
    }
  }

  private async headerFooter(id: string | undefined): Promise<Block[] | undefined> {
    const rel = id ? this.rels.get(id) : undefined
    if (!rel) return undefined
    const root = await this.pkg.xml(rel.target)
    if (!root) return undefined
    const conv = new Converter(this.styles, this.numbering, this.theme, await this.pkg.rels(rel.target))
    const out: Block[] = []
    for (const c of root.c) conv.blocks(c, out)
    return out
  }

  async stream(cb: DocxStreamCallbacks): Promise<void> {
    let item = 0
    let ords = new Map<XEl, number>()
    // the places charts are shown at share a budget of points: one past it keeps its label
    const shown = pointBudget()
    const hooks: ConvHooks = {
      item: () => item,
      para: (el, rec) => {
        const ord = ords.get(el)
        if (ord === undefined) return undefined
        const pid = this.nextPid++
        const info = rec as PInfo
        info.item = item
        info.ord = ord
        this.info.set(pid, info)
        this.origLoc.set(pid, { item, ord })
        this.ordPid.set(`${item}:${ord}`, pid)
        let list = this.itemParas.get(item)
        if (!list) this.itemParas.set(item, (list = []))
        list[ord] = pid
        return pid
      },
      comment: (num) => this.comments.rootOfNum(num),
      note: this.noteText,
      chart: (target) => {
        const model = this.charts.get(target)
        return model && showable(shown, model) ? model : undefined
      },
    }
    const conv = new Converter(this.styles, this.numbering, this.theme, this.rels, hooks)
    const baseMeta = {
      font: this.styles.docRs.font ?? '"Times New Roman", serif',
      sz: this.styles.docRs.sz ?? 10,
      styles: this.styles.quickStyles(),
    }
    let pending: Block[] = []
    let finalSect: XEl | undefined
    let firstSect: PageSetup | undefined
    const started = Date.now()
    const hold = cb.initialHoldMs ?? 350
    let lastFlush = 0
    let held = true
    const onItem = (index: number, els: XEl[]) => {
      item = index
      ords = collectParas(els)
      for (const el of els) {
        if (el.n === 'sectPr') {
          finalSect = el
          continue
        }
        const before = pending.length
        conv.blocks(el, pending)
        if (!firstSect)
          for (let i = before; i < pending.length; i++) {
            const b = pending[i]
            if (b.t === 'sect') firstSect = b.page
          }
      }
    }
    let capture: Capture | undefined
    const tb = new TreeBuilder({ understood: DOCX_UNDERSTOOD, emitDepth: 2, onElement: (el) => capture!.element(el) })
    capture = new Capture(tb, onItem)
    const flush = () => {
      if (!pending.length) return
      cb.onBlocks(pending)
      pending = []
      lastFlush = Date.now()
    }
    const stream = await this.pkg.zip.stream(this.mainPath, cb.onProgress)
    await parseXmlStream(stream, capture, {
      signal: cb.signal,
      raw: capture.raw,
      onChunk: async () => {
        const now = Date.now()
        if (held) {
          if (now - started < hold) return
          held = false
          cb.onMeta({ page: firstSect ?? { ...DEFAULT_PAGE }, ...baseMeta })
          flush()
          return
        }
        if (pending.length >= 400 || (pending.length && now - lastFlush > 120)) {
          flush()
          // yield so RPC requests (images, etc.) get served during long parses
          await new Promise((r) => setTimeout(r, 0))
        }
      },
    })
    capture.finish()
    for (const id of conv.seen) this.comments.inBody.add(id)
    this.items = capture.items
    this.prefix = capture.prefix
    this.suffix = capture.suffix
    // tracked changes written later get ids above every annotation id of the file (one saved here before included)
    let maxId = 0
    for (const x of this.items) for (const m of x.matchAll(/:id="(\d{1,9})"/g)) maxId = Math.max(maxId, Number(m[1]))
    this.nextTrackId = Math.max(this.nextTrackId, maxId + 1)
    this.captured = true
    const sect = finalSect
    this.page = pageSetup(sect)
    const meta: DocxMeta = { page: { ...this.page }, ...baseMeta, final: true }
    if (sect) {
      meta.sectKind = kid(sect, 'type')?.a.val ?? 'nextPage'
      const ref = (tag: string, type: string) => kids(sect, tag).find((r) => (r.a.type ?? 'default') === type)?.a['r:id']
      meta.titlePg = !!kid(sect, 'titlePg') && kid(sect, 'titlePg')?.a.val !== '0' && kid(sect, 'titlePg')?.a.val !== 'false'
      this.titlePg = meta.titlePg
      // first-page parts are known even when "different first page" is off (turning it on shows them)
      const first = (tag: string) => ref(tag, 'first')
      this.evenRefs = { header: ref('headerReference', 'even'), footer: ref('footerReference', 'even') }
      if (this.evenOdd) meta.evenOdd = true
      this.hfRefs = { header: ref('headerReference', 'default'), footer: ref('footerReference', 'default'), firstHeader: first('headerReference'), firstFooter: first('footerReference') }
      Object.assign(meta, await this.headers())
    }
    cb.onMeta(meta)
    flush()
  }

  get ready() {
    return this.captured
  }

  /** Re-converts generated paragraph XML into blocks (styles, list levels resolved by the engine). */
  reconvert(pid: number, xml: string, map: GenRun[], layer: Layer | undefined, marker?: ListMarker): { blocks: Block[]; rec: ParaRecord } {
    const root = parseXml(xml, undefined, DOCX_UNDERSTOOD)
    const forced: NonNullable<ConvHooks['forced']> = { pid, root, map, layer, marker }
    const conv = new Converter(this.styles, this.numbering, this.theme, this.rels, { forced, note: this.noteText, chart: (target) => this.charts.get(target) })
    const out: Block[] = []
    conv.paragraph(root, out)
    return { blocks: out, rec: forced.rec! }
  }

  /** Recomputes list markers in document order; returns changed ones. */
  recomputeMarkers(): Map<number, PInfo> {
    const changed = new Map<number, PInfo>()
    this.numbering.reset()
    const visit = (pid: number) => {
      const inf = this.info.get(pid)
      if (!inf) return
      let next: ListMarker | undefined
      let lst: 'bullet' | 'number' | undefined
      if (inf.num) {
        const base = inf.marker?.s ?? {}
        const m = markerOf(this.numbering, inf.num, base)
        if (m) {
          next = { ...m.marker, s: inf.marker?.s ?? m.marker.s }
          lst = m.lst
        }
      }
      if ((next?.text ?? null) !== (inf.marker?.text ?? null) || lst !== inf.lst) {
        inf.marker = next
        inf.lst = lst
        changed.set(pid, inf)
      }
    }
    const items = [...this.itemParas.keys()].sort((a, b) => a - b)
    for (const item of items) {
      const regenerated = this.itemTables.get(item)
      if (regenerated) {
        regenerated.forEach(visit)
        continue
      }
      const arr = this.itemParas.get(item)!
      for (let ord = 0; ord < arr.length; ord++) {
        const pid0 = arr[ord]
        if (pid0 === undefined) continue
        for (const pid of this.groups.get(`${item}:${ord}`) ?? [pid0]) (this.newTables.get(pid) ?? [pid]).forEach(visit)
      }
    }
    return changed
  }
}
