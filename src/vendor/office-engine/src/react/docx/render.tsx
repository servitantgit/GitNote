import { createElement, memo, useMemo, type CSSProperties, type PointerEvent as RPointerEvent, type ReactElement, type ReactNode } from 'react'
import { cssColor } from '../../core/color'
import type { Block, Inline, Paragraph, ParaStyle, PTab, RunStyle, Table, TableCell, TexMath, TrackMark } from '../../core/docx/types'
import { tabsAttr } from './tabs'
import { texToMathml, type MNode } from '../../core/math/tex'
import { safeHref } from '../../core/url'
import type { DocumentClient } from '../../core/worker/client'
import { chartUrl } from '../common/chart'
import { useMediaUrl } from '../common/hooks'
import { dict } from '../../core/dict'
import { en, type Strings } from '../strings/en'
import { gridOf, type GridCell } from './tables'
import { highlight, languageOf, type Token } from '../../core/syntax'

export interface RenderCtx {
  client: DocumentClient
  /** 0-based page index, -1 while measuring */
  page: number
  pages: number
  measuring: boolean
  editable: boolean
  /** editing: a column edge of the top-level table `bi` was dragged */
  colResize?: (bi: number, cols: number[]) => void
  /** UI texts (tooltips); English when absent */
  t?: Strings
}

/** tooltip of a tracked change */
const tcTitle = (ctx: RenderCtx, tc: TrackMark, date: boolean) => {
  const t = ctx.t ?? en
  const what = tc.k === 'ins' ? t.docx.inserted : t.docx.deleted
  return `${tc.author ? t.docx.changeBy(what, tc.author) : what}${date && tc.date ? ` · ${new Date(tc.date).toLocaleString(t.locale)}` : ''}`
}

const pt = (v: number | undefined) => (v ? `${+v.toFixed(2)}pt` : undefined)

const UNDERLINE_STYLE: Record<string, CSSProperties['textDecorationStyle']> = dict({
  double: 'double', dotted: 'dotted', dottedHeavy: 'dotted', dash: 'dashed', dashedHeavy: 'dashed', dashLong: 'dashed',
  wave: 'wavy', wavyHeavy: 'wavy', wavyDouble: 'wavy',
})

const TRACK_COLORS = ['#c0392b', '#1a73e8', '#188038', '#a142f4', '#e37400', '#00838f', '#d01884', '#5f6368']

const authorSlot = new Map<string, number>()

/** one colour per author of tracked changes, given in the order authors are met (as Word does): the first 8 differ */
export function authorColor(author: string | undefined): string {
  const k = author ?? ''
  let i = authorSlot.get(k)
  if (i === undefined) authorSlot.set(k, (i = authorSlot.size))
  return TRACK_COLORS[i % TRACK_COLORS.length]
}

/** inserted text underlined, deleted text struck through, in the author's colour */
function trackCss(tc: TrackMark): CSSProperties {
  const color = authorColor(tc.author)
  return tc.k === 'ins'
    ? { color, textDecoration: 'underline', textDecorationColor: color }
    : { color, textDecoration: 'line-through', textDecorationColor: color }
}

export function runCss(s: RunStyle | undefined): CSSProperties {
  const css: CSSProperties = {}
  if (!s) return css
  if (s.b) css.fontWeight = 700
  else if (s.b === false) css.fontWeight = 400
  if (s.i) css.fontStyle = 'italic'
  else if (s.i === false) css.fontStyle = 'normal'
  const u = s.u && s.u !== 'none'
  const deco = [u ? 'underline' : '', s.strike || s.dstrike ? 'line-through' : ''].filter(Boolean).join(' ')
  if (deco) css.textDecoration = deco
  else if (s.u === 'none' || s.strike === false) css.textDecoration = 'none'
  if (u && UNDERLINE_STYLE[s.u!]) css.textDecorationStyle = UNDERLINE_STYLE[s.u!]
  if (s.dstrike) css.textDecorationStyle = 'double'
  // colors of the model come from the file, a peer or the clipboard: `background` would load a url() in one
  if (s.color) css.color = cssColor(s.color)
  if (s.sz) css.fontSize = `${s.va ? s.sz * 0.65 : s.sz}pt`
  if (s.font) css.fontFamily = s.font
  if (s.hl || s.shd) css.background = cssColor(s.hl ?? s.shd)
  if (s.va) css.verticalAlign = s.va === 'sup' ? 'super' : 'sub'
  if (s.caps) css.textTransform = 'uppercase'
  if (s.smallCaps) css.fontVariant = 'small-caps'
  if (s.spacing) css.letterSpacing = `${s.spacing}pt`
  return css
}

function lineHeight(ps: ParaStyle): string | number | undefined {
  if (!ps.line) return 1.17
  if (ps.lineRule === 'exact') return `${ps.line}pt`
  if (ps.lineRule === 'atLeast') return `max(${ps.line}pt, 1.17em)`
  return +(ps.line * 1.17).toFixed(3)
}

/** contextual spacing flags: 'b' drop space before, 'a' drop space after */
export type Spacing = '' | 'b' | 'a' | 'ba'

export function contextual(p: Block | undefined, prev: Block | undefined, next: Block | undefined): Spacing {
  if (!p || p.t !== 'p' || !p.ps.contextual) return ''
  const b = prev?.t === 'p' && prev.sid === p.sid ? 'b' : ''
  const a = next?.t === 'p' && next.sid === p.sid ? 'a' : ''
  return (b + a) as Spacing
}

function paraCss(ps: ParaStyle, sp: Spacing): CSSProperties {
  const css: CSSProperties = {
    paddingTop: sp.includes('b') ? undefined : pt(ps.before),
    paddingBottom: sp.includes('a') ? undefined : pt(ps.after),
    paddingLeft: pt(ps.indL),
    paddingRight: pt(ps.indR),
    textIndent: pt(ps.indFirst),
    textAlign: ps.align,
    lineHeight: lineHeight(ps),
  }
  if (ps.shd) css.background = cssColor(ps.shd)
  const b = (x: ParaStyle['bTop']) => (x ? `${x.w}pt ${x.style} ${cssColor(x.color) ?? 'currentColor'}` : undefined)
  if (ps.bTop) css.borderTop = b(ps.bTop)
  if (ps.bBottom) css.borderBottom = b(ps.bBottom)
  if (ps.bLeft) css.borderLeft = b(ps.bLeft)
  if (ps.bRight) css.borderRight = b(ps.bRight)
  return css
}

function Img({ ctx, target, w, h, alt }: { ctx: RenderCtx; target: string; w: number; h: number; alt?: string }) {
  const url = useMediaUrl(ctx.client, target, !ctx.measuring)
  const size = { width: `${w}pt`, height: `${h}pt` }
  if (ctx.measuring || !url) return <span className="de-img-missing" style={{ ...size, borderStyle: 'none' }} />
  if (url === 'unsupported') {
    return (
      <span className="de-img-missing" style={size} title={target}>
        {target.split('.').pop()?.toUpperCase()} image
      </span>
    )
  }
  return <img src={url} alt={alt ?? ''} style={{ ...size, verticalAlign: 'bottom', display: 'inline-block' }} draggable={false} />
}

/** a MathML tree as elements (React puts them in the MathML namespace under `math`) */
function mathEl(n: MNode, key?: number): ReactElement {
  return createElement(n.t, { key, ...n.a }, n.x ?? n.k?.map(mathEl))
}

/**
 * A TeX formula, drawn by the browser from its MathML (selectable, read by screen readers, printed); the TeX rides
 * along as an annotation. A formula that cannot be drawn shows its source, its reason as the tooltip.
 */
function MathView({ math, sz, attrs }: { math: TexMath; sz?: number; attrs: { title?: string } }) {
  const display = math.delim === '$$'
  const { node, error } = useMemo(() => texToMathml(math.tex, display), [math.tex, display])
  return (
    <span {...attrs} className="de-math" data-display={display ? '' : undefined} data-error={error ? '' : undefined} title={error ?? attrs.title} style={sz ? { fontSize: `${sz}pt` } : undefined}>
      {mathEl(node)}
    </span>
  )
}

/** a code block longer than this is shown without colors */
const CODE_COLORED = 50_000

interface CodeTokens {
  toks: Token[]
  /** where each token starts in the paragraph's text */
  starts: number[]
}

/**
 * the colors of a code paragraph's text, worked out once per paragraph and text (an edit makes a new paragraph; its
 * unchanged lines come from the tokenizer's cache)
 */
const codeCache = new WeakMap<Paragraph, { key: string; r: CodeTokens | null }>()

function codeTokens(p: Paragraph): CodeTokens | null {
  // objects count as one character, as they do for the caret
  const text = p.runs.map((x) => (x.t === 'text' ? x.text : '\uFFFC')).join('')
  const key = `${p.code}\u0000${text}`
  const hit = codeCache.get(p)
  if (hit?.key === key) return hit.r
  let r: CodeTokens | null = null
  if (languageOf(p.code) && text.length <= CODE_COLORED) {
    const toks = highlight(p.code, text, CODE_COLORED)
    const starts: number[] = []
    let at = 0
    for (const t of toks) {
      starts.push(at)
      at += t[1].length
    }
    r = { toks, starts }
  }
  codeCache.set(p, { key, r })
  return r
}

/** the colored pieces of the text [a, b) of a code paragraph: only drawn, the run stays as it is */
function codePieces(c: CodeTokens, a: number, b: number): ReactNode[] {
  const { toks, starts } = c
  let lo = 0
  let hi = toks.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= a) lo = mid
    else hi = mid - 1
  }
  const out: ReactNode[] = []
  for (let k = lo; k < toks.length && starts[k] < b; k++) {
    const [cls, t] = toks[k]
    const s = Math.max(a, starts[k])
    const e = Math.min(b, starts[k] + t.length)
    if (e <= s) continue
    const piece = t.slice(s - starts[k], e - starts[k])
    out.push(cls ? <span key={k} className={`de-tk-${cls}`}>{piece}</span> : piece)
  }
  return out
}

/** text with each of its tabs an element of its own: given its width by `layoutTabs` (the first one of an absolute position tab says where it goes) */
function tabPieces(text: string, ptab?: PTab): ReactNode {
  if (!text.includes('\t')) return text
  const out: ReactNode[] = []
  text.split('\t').forEach((part, i) => {
    if (i > 0) {
      const abs = i === 1 ? ptab : undefined
      out.push(
        <span key={i} className="de-tabchar" data-ptab={abs?.a} data-rel={abs?.indent ? 'indent' : undefined} data-ld={abs?.ld}>
          {'\t'}
        </span>,
      )
    }
    if (part) out.push(part)
  })
  return out
}

function InlineView({ x, ctx, o, pieces, tabs }: { x: Inline; ctx: RenderCtx; o: number; pieces?: ReactNode[]; tabs?: boolean }): ReactNode {
  // an object inside a tracked change: outlined in the author's colour (dimmed when deleted)
  const objTc = x.t !== 'text' ? x.tc : undefined
  const obj = {
    'data-o': o,
    'data-obj': '',
    contentEditable: ctx.editable ? false : undefined,
    ...(objTc ? { 'data-tc': objTc.k, title: tcTitle(ctx, objTc, false) } : {}),
  } as const
  switch (x.t) {
    case 'text': {
      const tc = x.tc
      const span = (
        <span
          data-o={o}
          style={tc ? { ...runCss(x.s), ...trackCss(tc) } : runCss(x.s)}
          data-cm={x.cm?.join(' ')}
          data-tc={tc?.k}
          title={tc ? tcTitle(ctx, tc, true) : undefined}
        >
          {pieces ?? (tabs ? tabPieces(x.text) : x.text)}
        </span>
      )
      const href = ctx.measuring || ctx.editable ? undefined : safeHref(x.href)
      return href ? (
        <a href={href} target={href.startsWith('#') ? undefined : '_blank'} rel="noreferrer noopener">
          {span}
        </a>
      ) : (
        span
      )
    }
    case 'field': {
      const v = x.kind === 'PAGE' ? (ctx.page >= 0 ? ctx.page + 1 : 1) : ctx.pages || 1
      return (
        <span {...obj} style={runCss(x.s)}>
          {v}
        </span>
      )
    }
    case 'ref':
      if (x.math) return <MathView attrs={obj} math={x.math} sz={x.s.sz} />
      return (
        <span {...obj} style={runCss(x.s)}>
          {tabs ? tabPieces(x.text, x.ptab) : x.text}
        </span>
      )
    case 'img': {
      const img = <Img ctx={ctx} target={x.target} w={x.w} h={x.h} alt={x.alt} />
      const href = ctx.measuring || ctx.editable ? undefined : safeHref(x.href)
      return (
        <span {...obj} data-cm={x.cm?.join(' ')}>
          {href ? (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {img}
            </a>
          ) : (
            img
          )}
        </span>
      )
    }
    case 'box':
      return (
        <span
          {...obj}
          className="de-tbox"
          style={{ width: x.w ? `${x.w}pt` : undefined, minHeight: x.h ? `${x.h}pt` : undefined, background: cssColor(x.fill), border: x.border }}
        >
          {x.blocks.map((b, i) => (
            <BlockView key={i} block={b} ctx={ctx} />
          ))}
        </span>
      )
    case 'shape': {
      // a chart drawn at its size (pt), else (and while measuring) its label in a box of that size
      const url = x.chart && !ctx.measuring ? chartUrl(x.chart, (x.w * 96) / 72, (x.h * 96) / 72) : ''
      if (url) return <img {...obj} src={url} alt={x.label} style={{ width: `${x.w}pt`, height: `${x.h}pt`, verticalAlign: 'bottom', display: 'inline-block' }} draggable={false} />
      return x.label ? (
        <span {...obj} className="de-ph" style={{ width: `${x.w}pt`, height: `${x.h}pt` }}>
          {x.label}
        </span>
      ) : (
        <span {...obj} />
      )
    }
  }
}

/**
 * A paragraph, or the characters [from, to) of one split across pages: lines as the whole paragraph has them there.
 * A part after the first has no first-line indent, no space or border above; one before the last no space or border
 * below, its height the measured one (`height`, px), and its last line justified when the paragraph is.
 */
function ParaView({ p, ctx, pa, sp, from = 0, to, height }: { p: Paragraph; ctx: RenderCtx; pa?: string; sp: Spacing; from?: number; to?: number; height?: number }) {
  const hang = p.ps.indFirst && p.ps.indFirst < 0 ? -p.ps.indFirst : 0
  const visible = p.runs.length > 0
  const style = paraCss(p.ps, sp)
  if (!visible) {
    style.fontSize = pt(p.markSz)
    if (p.markFont) style.fontFamily = p.markFont
  }
  const first = from === 0
  const last = to === undefined
  if (!first) style.paddingTop = style.textIndent = style.borderTop = undefined
  if (!last) {
    style.paddingBottom = style.borderBottom = undefined
    style.boxSizing = 'border-box'
    style.height = height
  }
  const editable = ctx.editable && pa !== undefined
  // a code block: its text colored by its language (not while measuring: colors do not change the layout)
  const code = p.code !== undefined && !ctx.measuring ? codeTokens(p) : null
  // the paragraph sets tab stops, or holds a tab to a place of the page: its tabs are laid out (see tabs.ts)
  const tabs = !!p.ps.tabs?.length || p.runs.some((x) => x.t === 'ref' && x.ptab)
  let o = 0
  const runs: ReactNode[] = []
  p.runs.forEach((x, i) => {
    const n = x.t === 'text' ? x.text.length : 1
    const a = Math.max(from, o)
    const b = Math.min(to ?? Infinity, o + n)
    if (b > a || (n === 0 && first && last)) {
      // (a tracked change keeps its author's color)
      const pieces = code && x.t === 'text' && !x.tc ? codePieces(code, a, b) : undefined
      runs.push(<InlineView key={i} x={x.t === 'text' && (a > o || b < o + n) ? { ...x, text: x.text.slice(a - o, b - o) } : x} ctx={ctx} o={a} pieces={pieces} tabs={tabs} />)
    }
    o += n
  })
  return (
    <div
      className={`${p.code !== undefined ? 'de-p de-code' : 'de-p'}${!last && p.ps.align === 'justify' ? ' de-just' : ''}`}
      style={style}
      data-pa={pa}
      data-from={first ? undefined : from}
      data-to={to}
      data-tabs={tabs ? tabsAttr(p.ps.tabs) : undefined}
      data-code={p.code}
      spellCheck={p.code !== undefined ? false : undefined}
      contentEditable={ctx.editable && !editable ? false : undefined}
    >
      {first && p.marker && (
        <span className="de-marker" contentEditable={ctx.editable ? false : undefined} style={{ ...runCss(p.marker.s), minWidth: p.marker.tab && hang ? `${hang}pt` : undefined }}>
          {p.marker.text}
          {p.marker.tab && !hang ? '\t' : ''}
        </span>
      )}
      {runs}
      {!visible &&
        (editable ? (
          <span data-o={0} data-empty="">
            {'\u200B'}
          </span>
        ) : (
          '\u200B'
        ))}
    </div>
  )
}

const grids = new WeakMap<Table, ReturnType<typeof gridOf>>()
const gridCached = (t: Table) => {
  let g = grids.get(t)
  if (!g) grids.set(t, (g = gridOf(t)))
  return g
}
const gridRows = new WeakMap<Table, GridCell[][]>()
/** the cells of each row with their grid column */
const gridRowsOf = (t: Table) => {
  let r = gridRows.get(t)
  if (!r) {
    const rows: GridCell[][] = t.rows.map(() => [])
    for (const c of gridCached(t).cells) rows[c.ri].push(c)
    gridRows.set(t, (r = rows))
  }
  return r
}

/**
 * A table, or the rows [from, to) of one split across pages. A part after the first starts with copies of the header
 * rows (`head`): display only, not editable, not addressed. A merged cell cut by the page end is cut too: its content
 * stays on the page it starts on, an empty cell of the same look goes on below.
 */
function TableView({ t, ctx, pa, from = 0, to, head = 0 }: { t: Table; ctx: RenderCtx; pa?: string; from?: number; to?: number; head?: number }) {
  const total = t.cols.reduce((a, b) => a + b, 0)
  const style: CSSProperties = { width: total ? `${total}pt` : '100%' }
  if (t.align === 'center') style.margin = '0 auto'
  else if (t.align === 'right') style.marginLeft = 'auto'
  else if (t.indL) style.marginLeft = `${t.indL}pt`
  const end = Math.min(to ?? t.rows.length, t.rows.length)
  const cut = from > 0 || end < t.rows.length
  // (a continued merged cell is keyed by its grid column: two of them in one row may come from the same cell index of different rows)
  const cellView = (c: TableCell, ri: number, ci: number, rowSpan: number, copy: boolean, rest = false, gcol = ci) => (
    <td
      key={rest ? `m${gcol}` : ci}
      colSpan={c.colSpan > 1 ? c.colSpan : undefined}
      rowSpan={rowSpan > 1 ? rowSpan : undefined}
      contentEditable={rest && ctx.editable ? false : undefined}
      style={{
        borderTop: c.borders.t,
        borderRight: c.borders.r,
        borderBottom: c.borders.b,
        borderLeft: c.borders.l,
        background: cssColor(c.shd),
        verticalAlign: c.vAlign,
        padding: `${c.pad[0]}pt ${c.pad[1]}pt ${c.pad[2]}pt ${c.pad[3]}pt`,
      }}
    >
      {!rest &&
        c.blocks.map((b, i) => (
          <BlockView
            key={b.t === 'p' ? `${i}:${b.ver ?? 0}` : i}
            block={b}
            ctx={ctx}
            pa={!copy && pa !== undefined && b.t === 'p' && b.pid !== undefined && !b.ro ? `${pa}.${ri}.${ci}.${i}` : undefined}
            sp={contextual(b, c.blocks[i - 1], c.blocks[i + 1])}
            nested
          />
        ))}
    </td>
  )
  /** row `ri`, its merged cells cut at row `limit` */
  const rowView = (ri: number, limit: number, copy: boolean) => {
    const row = t.rows[ri]
    let cells: ReactNode[]
    if (!cut) cells = row.cells.map((c, ci) => cellView(c, ri, ci, c.rowSpan, false))
    else {
      const at: { g: number; node: ReactNode }[] = []
      for (const gc of gridRowsOf(t)[ri]) at.push({ g: gc.g, node: cellView(gc.cell, ri, gc.ci, Math.min(gc.cell.rowSpan, limit - ri), copy) })
      // merged cells from the page before go on here, empty
      if (!copy && ri === from)
        for (const gc of gridCached(t).cells) if (gc.ri < from && gc.ri + gc.cell.rowSpan > from) at.push({ g: gc.g, node: cellView(gc.cell, ri, gc.ci, Math.min(gc.ri + gc.cell.rowSpan, limit) - ri, false, true, gc.g) })
      cells = at.sort((a, b) => a.g - b.g).map((x) => x.node)
    }
    return (
      <tr key={copy ? `h${ri}` : ri} className={copy ? 'de-head-copy' : undefined} contentEditable={copy && ctx.editable ? false : undefined} style={{ height: row.h ? `${row.h}pt` : undefined }}>
        {cells}
      </tr>
    )
  }
  const resize = ctx.colResize && pa !== undefined && !pa.includes('.') && total > 0 ? ctx.colResize : undefined
  const drag = (i: number) => (e: RPointerEvent<HTMLDivElement>) => {
    const tbl = (e.currentTarget.parentElement as HTMLElement).querySelector('table')
    if (!tbl || !resize) return
    e.preventDefault()
    e.stopPropagation()
    const ptPerPx = total / tbl.getBoundingClientRect().width
    const x0 = e.clientX
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const widths = (dx: number) => {
      const cols = [...t.cols]
      const d = dx * ptPerPx
      if (i < cols.length - 1) {
        const room = Math.max(-(cols[i] - 12), Math.min(d, cols[i + 1] - 12))
        cols[i] += room
        cols[i + 1] -= room
      } else cols[i] = Math.max(12, cols[i] + d)
      return cols
    }
    const move = (ev: PointerEvent) => {
      const cols = widths(ev.clientX - x0)
      tbl.querySelectorAll('col').forEach((c, k) => ((c as HTMLElement).style.width = `${cols[k]}pt`))
      tbl.style.width = `${cols.reduce((a, b) => a + b, 0)}pt`
    }
    const up = (ev: PointerEvent) => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      if (Math.abs(ev.clientX - x0) > 1) resize(Number(pa), widths(ev.clientX - x0))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }
  let edge = 0
  const handles = resize
    ? t.cols.map((w, i) => {
        edge += w
        return <div key={i} className="de-col-resize" contentEditable={false} style={{ left: `calc(${edge}pt - 3px)` }} onPointerDown={drag(i)} />
      })
    : null
  const table = (
    <table className="de-tbl" style={style}>
      {total > 0 && (
        <colgroup>
          {t.cols.map((w, i) => (
            <col key={i} style={{ width: `${w}pt` }} />
          ))}
        </colgroup>
      )}
      <tbody>
        {from > 0 && Array.from({ length: Math.min(head, from) }, (_, ri) => rowView(ri, head, true))}
        {Array.from({ length: end - from }, (_, k) => rowView(from + k, end, false))}
      </tbody>
    </table>
  )
  if (!handles) return table
  const off = style.marginLeft && style.marginLeft !== 'auto' ? style.marginLeft : undefined
  return (
    <div className="de-tbl-wrap" style={{ marginLeft: off, width: style.width, marginRight: t.align === 'center' ? 'auto' : undefined, ...(t.align === 'center' ? { marginLeft: 'auto' } : t.align === 'right' ? { marginLeft: 'auto' } : {}) }}>
      {table}
      {handles}
    </div>
  )
}

export interface BlockViewProps {
  block: Block
  ctx: RenderCtx
  /** editable address (top-level: block index; table: block index used as prefix) */
  pa?: string
  sp?: Spacing
  nested?: boolean
  /**
   * A part of a block split across pages: the characters [from, to) of a paragraph, the rows [from, to) of a table;
   * to undefined: to its end
   */
  from?: number
  to?: number
  /** a table part after the first: its header rows shown again above it */
  head?: number
  /** a paragraph part before the last: its height (px) */
  height?: number
}

export const BlockView = memo(function BlockView({ block, ctx, pa, sp = '', nested, from, to, head, height }: BlockViewProps) {
  switch (block.t) {
    case 'p':
      return <ParaView p={block} ctx={ctx} pa={pa} sp={sp} from={from} to={to} height={height} />
    case 'tbl':
      return (
        <div style={{ overflow: 'visible' }} contentEditable={ctx.editable && (nested || pa === undefined) ? false : undefined}>
          <TableView t={block} ctx={ctx} pa={nested ? undefined : pa} from={from} to={to} head={head} />
        </div>
      )
    default:
      return <div />
  }
})
