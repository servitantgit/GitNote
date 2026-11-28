/**
 * An Excel chart part (`xl/charts/chartN.xml`) read into what the SVG renderer (chart-svg.ts) draws: its plot groups
 * (bar / column, line, area, pie, doughnut, scatter, bubble, radar, stock, surface; 3D ones with their view; several
 * groups make a combo chart, each on its own axes), series with their values, axes, title, legend and the plot area's
 * manual layout, and the looks the file gives them: fills (a color, a gradient, a pattern), lines, text colors and sizes,
 * and the built-in chart style (`c:style`) for what it leaves to that.
 *
 * Series values are read from the workbook's cells (`RangeReader`), so a chart follows edited cells; where a reference
 * cannot be read there (a defined name, another workbook, an unknown sheet) the values the file saved with the chart
 * (`numCache` / `strCache`) stand in. Colors are resolved here against the workbook's theme: the view gets CSS colors.
 * A chart of the newer chartex kinds (waterfall, treemap, ...) is in another part and has no model: it stays a placeholder.
 */
import { colorOf, cssColor, drawingColor, type ColorCtx } from '../color'
import { dict } from '../dict'
import type { Theme } from '../theme'
import { kid, kids, num, textOf, type XEl } from '../xml'
import { formatValue } from './numfmt'

export type ChartType = 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter' | 'bubble' | 'radar' | 'stock' | 'surface'
export type Grouping = 'clustered' | 'stacked' | 'percentStacked' | 'standard'

export interface ChartText {
  text: string
  /** pt */
  size: number
  bold: boolean
  color?: string
}

/** a fill that is more than one color; the shape's plain `fill` holds a color standing in for it */
export type FillLook =
  | {
      kind: 'gradient'
      /** pos 0…1 along the gradient */
      stops: { pos: number; color: string }[]
      /** degrees clockwise from left-to-right (linear) */
      angle: number
      radial: boolean
    }
  | { kind: 'pattern'; preset: string; fg: string; bg: string }

/** text's own size (pt), weight and color, where the file gives them */
export interface TextLook {
  size?: number
  bold?: boolean
  color?: string
}

export interface LineLook {
  color: string
  /** pt */
  width: number
  dash?: string
}

/** a fill with its look: a color (null: none) and a gradient or pattern over it */
export interface Fill {
  fill: string | null
  look?: FillLook
}

export interface DataLabels {
  value: boolean
  percent: boolean
  category: boolean
  series: boolean
  /** ctr, inEnd, inBase, outEnd, t, b, l, r, bestFit */
  pos?: string
  format?: string
  sep?: string
  text?: TextLook
  /** points with labels of their own (`c:dLbl`), by index; null: that point shows none */
  points?: Record<number, DataLabels | null>
}

export interface ChartPoint {
  color?: string
  look?: FillLook
  /** pie slices: % of the radius */
  explosion?: number
}

export interface ChartSeries {
  name: string
  /** the name is Excel's own ("Series1"): the file gives the series none */
  unnamed?: boolean
  /** category labels (bar, line, area, pie) */
  cats: string[]
  /** x values (scatter, bubble) */
  xs?: (number | null)[]
  /** the x values' number format, for an x axis linked to its source */
  xFormat?: string
  /** the categories as numbers where they are (dates: their serials), for a date axis that places them by value */
  catValues?: (number | null)[]
  values: (number | null)[]
  /** bubble sizes */
  sizes?: (number | null)[]
  /** 3D bars: the series' own shape, over its group's */
  shape?: string
  /** the values' number format */
  format?: string
  /** fill (bars, areas, slices, bubbles); null: none */
  fill: string | null
  /** a gradient or pattern over the fill */
  look?: FillLook
  /** line (lines, scatter; bar outlines); null: none */
  line: { color: string; width: number; dash?: string } | null
  marker: { symbol: string; size: number; fill?: string; line?: string } | null
  smooth: boolean
  invertIfNegative: boolean
  points: Record<number, ChartPoint>
  labels?: DataLabels
}

export interface ChartGroup {
  type: ChartType
  /** bars: 'col' upright, 'bar' horizontal */
  dir: 'col' | 'bar'
  grouping: Grouping
  /** % of a bar's width */
  gapWidth: number
  /** % of a bar's width, -100…100 */
  overlap: number
  varyColors: boolean
  /** doughnut: % of the radius */
  holeSize: number
  /** pie: degrees clockwise from 12 o'clock */
  firstSliceAng: number
  scatterStyle?: string
  /** radar: 'standard' (lines), 'marker' (lines with markers), 'filled' */
  radarStyle?: string
  /** bubble: the largest bubble's size, % of Excel's default (a quarter of the plot's smaller side) */
  bubbleScale?: number
  /** bubble: a size gives the bubble's area ('area') or its width ('w') */
  sizeRepresents?: 'area' | 'w'
  showNegBubbles?: boolean
  /** stock: lines from each category's highest to its lowest value; null: none */
  hiLow?: LineLook | null
  /** stock: bars from the first series (open) to the last (close), rising and falling */
  upDown?: { gapWidth: number; up: Fill & { line?: LineLook | null }; down: Fill & { line?: LineLook | null } }
  /** surface: drawn as a mesh of lines without fills */
  wireframe?: boolean
  /** a 3D kind (`c:bar3DChart`, ...): drawn in the chart's 3D view */
  three?: boolean
  /** 3D bars: their shape (box, cylinder, cone, coneToMax, pyramid, pyramidToMax) */
  shape?: string
  /** 3D: the gap between rows of the depth axis, % of a bar's depth */
  gapDepth?: number
  /** surface: the bands' own fills, by band */
  bands?: Record<number, Fill>
  /** surface: the built-in style's color for each band without a fill of its own */
  bandColors?: string[]
  /** the ids of its category (x) and value (y) axes */
  axIds: string[]
  series: ChartSeries[]
}

export interface ChartAxis {
  id: string
  /** 'ser': a surface chart's series axis */
  kind: 'cat' | 'val' | 'date' | 'ser'
  /** where it is drawn: l, r, t, b */
  pos: string
  deleted: boolean
  reverse: boolean
  logBase?: number
  min?: number
  max?: number
  major?: number
  format?: string
  gridlines: boolean
  /** the major gridlines' own line; null: none drawn */
  grid?: LineLook | null
  /** the axis line's own line; null: none drawn */
  line?: LineLook | null
  /** tick labels shown */
  labels: boolean
  /** the tick labels' own look */
  text?: TextLook
  /** the tick labels' angle the file fixes, degrees clockwise; undefined: Excel's own choice */
  rot?: number
  /** a date axis' band: a day, a month or a year (`c:baseTimeUnit`); undefined: as the dates' spacing suggests */
  baseUnit?: 'days' | 'months' | 'years'
  title?: ChartText
  crossAx: string
  crosses: 'autoZero' | 'min' | 'max'
  crossesAt?: number
}

/** fractions of the chart's size */
export interface ChartLayout {
  x: number
  y: number
  w: number
  h: number
  /** 'inner': the plot's own box; 'outer': with its axis labels */
  target: 'inner' | 'outer'
}

/** a 3D chart's view (`c:view3D`) and its walls and floor */
export interface View3D {
  /** degrees the chart is tipped toward the viewer (seen from above when positive) */
  rotX: number
  /** degrees the chart is turned about its upright axis */
  rotY: number
  /** right-angle axes: the front stays square to the viewer and depth is drawn obliquely */
  rightAngle: boolean
  /** the field of view, degrees (0: none, a parallel projection) */
  perspective: number
  /** the depth of a row of the depth axis, % of a category's width */
  depthPercent: number
  /** the height, % of the width; undefined: as the plot area allows */
  hPercent?: number
  floor?: Fill & { line?: LineLook | null }
  side?: Fill & { line?: LineLook | null }
  back?: Fill & { line?: LineLook | null }
}

export interface ChartModel {
  /**
   * A name of its own for a chart that never changes (one saved in a Word document or on a slide, `chartKeys`). Its
   * model is posted again with every slide and batch of paragraphs read; the copies are told by it to be one chart, so
   * a view draws its picture once.
   */
  key?: string
  title?: ChartText
  /** a 3D chart's view; absent for a flat chart */
  view3d?: View3D
  legend?: { pos: string; overlay: boolean; deleted: number[]; text?: TextLook }
  groups: ChartGroup[]
  axes: ChartAxis[]
  plot?: ChartLayout
  /** pt: the chart's base text size */
  fontSize: number
  textColor: string
  /** the chart area's fill (null: none, undefined: white) */
  bg?: string | null
  bgLook?: FillLook
  border?: string | null
  /** the plot area's own fill and border (null / undefined: none) */
  plotFill?: string | null
  plotLook?: FillLook
  plotBorder?: LineLook | null
  /** gridlines, and axis lines and the chart's border, where the file gives them no line: the theme's grays, or the
   *  built-in style's (a dark one has lighter ones) */
  gridColor: string
  axisColor: string
  /** how lines show empty cells (`c:dispBlanksAs`): a gap, as zero, or spanned by the line */
  blanks: 'gap' | 'zero' | 'span'
  date1904: boolean
}

/** a reference's cells, row by row: values (numbers or text), number formats, and which lie in hidden rows / columns */
export interface RangeValues {
  values: (number | string | null)[]
  formats: (string | undefined)[]
  hidden: boolean[]
}

/** reads a series reference (`'Sheet 1'!$B$2:$B$9`) from the workbook; null where it cannot */
export type RangeReader = (ref: string) => Promise<RangeValues | null>

const GROUPS: Record<string, ChartType> = dict({
  barChart: 'bar', bar3DChart: 'bar', lineChart: 'line', line3DChart: 'line', areaChart: 'area', area3DChart: 'area',
  pieChart: 'pie', pie3DChart: 'pie', ofPieChart: 'pie', doughnutChart: 'doughnut', scatterChart: 'scatter',
  bubbleChart: 'bubble', radarChart: 'radar', stockChart: 'stock', surfaceChart: 'surface', surface3DChart: 'surface',
})

const val = (el: XEl | undefined, def?: string) => el?.a.val ?? def
/** `v` kept to Excel's range for it, `def` when it is not a number */
const within = (v: number, lo: number, hi: number, def: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def)
const on = (el: XEl | undefined, def = false) => (el ? el.a.val === undefined || el.a.val === '1' || el.a.val === 'true' : def)
const EMU_PER_PT = 12700

/** the text of a title / rich text body, its size and look from the first run or the body's defaults */
function richText(el: XEl | undefined, ctx: ColorCtx, defSize: number, defBold: boolean): ChartText | undefined {
  const rich = kid(kid(el, 'tx'), 'rich')
  if (!rich) return undefined
  const paras = kids(rich, 'p')
  const text = paras.map((p) => kids(p, 'r').map((r) => textOf(kid(r, 't'))).join('') + kids(p, 'fld').map((f) => textOf(kid(f, 't'))).join('')).join('\n').trim()
  if (!text) return undefined
  // the first run's own look over its paragraph's defaults (`a:pPr/a:defRPr`), over the body's (`a:lstStyle`)
  const para = kid(kid(paras[0], 'pPr'), 'defRPr')
  const list = kid(kid(kid(rich, 'lstStyle'), 'lvl1pPr'), 'defRPr')
  const look = runLook(list, ctx, defSize, defBold)
  const own = runLook(kid(kids(paras[0], 'r')[0], 'rPr'), ctx, 0, defBold)
  const mid = runLook(para, ctx, 0, defBold)
  return {
    text,
    size: own.size || mid.size || look.size,
    bold: own.boldGiven ?? mid.boldGiven ?? look.boldGiven ?? defBold,
    color: own.color ?? mid.color ?? look.color,
  }
}

function runLook(rPr: XEl | undefined, ctx: ColorCtx, defSize: number, defBold: boolean) {
  const sz = num(rPr?.a.sz)
  const boldGiven = rPr?.a.b !== undefined ? rPr.a.b === '1' || rPr.a.b === 'true' : undefined
  return {
    size: sz ? sz / 100 : defSize,
    bold: boldGiven ?? defBold,
    boldGiven,
    color: safe(colorOf(kid(rPr, 'solidFill'), ctx)),
  }
}

const safe = (c: string | undefined) => (c && cssColor(c) ? c : undefined)

/** a text body's default run size and look (`c:txPr`) */
function txLook(el: XEl | undefined, ctx: ColorCtx) {
  const rPr = kid(kid(kids(kid(el, 'txPr'), 'p')[0], 'pPr'), 'defRPr')
  if (!rPr) return undefined
  const { size, bold, color } = runLook(rPr, ctx, 0, false)
  return { size, bold, color }
}

/** the text look an element's `c:txPr` gives (size 0 there: none given), or undefined */
function textLookOf(el: XEl | undefined, ctx: ColorCtx): TextLook | undefined {
  const rPr = kid(kid(kids(kid(el, 'txPr'), 'p')[0], 'pPr'), 'defRPr')
  if (!rPr) return undefined
  const sz = num(rPr.a.sz)
  const look: TextLook = {
    ...(sz ? { size: sz / 100 } : {}),
    ...(rPr.a.b !== undefined ? { bold: rPr.a.b === '1' || rPr.a.b === 'true' } : {}),
    ...(safe(colorOf(kid(rPr, 'solidFill'), ctx)) ? { color: safe(colorOf(kid(rPr, 'solidFill'), ctx)) } : {}),
  }
  return Object.keys(look).length ? look : undefined
}

const mod = (n: string, v: number): XEl => ({ n, a: { val: String(Math.round(v)) }, c: [], t: '' })
const scheme = (name: string, mods: XEl[], ctx: ColorCtx, def: string) => drawingColor({ n: 'schemeClr', a: { val: name }, c: mods, t: '' }, ctx) ?? def

/**
 * The colors series take where they have none of their own, from the built-in chart style (`c:style`, 1…48, 2 when
 * absent): eight columns of styles (gray shades, the theme's accents in turn, shades of one accent each) in six rows of
 * effects, of which the fifth has tinted plot areas and the sixth dark backgrounds. Effects (bevels, shadows, gradients)
 * are not drawn: each style is drawn by its flat colors.
 */
interface ChartStyle {
  /** the color of series `i` of `n` */
  color(i: number, n: number): string
  bg?: string
  plot?: string
  text: string
  /** gridlines, axis lines and the chart's border, where the file gives them no line */
  grid: string
  axis: string
}

function chartStyle(style: number | undefined, ctx: ColorCtx): ChartStyle {
  const s = style && style >= 1 && style <= 48 ? style : 2
  const col = (s - 1) % 8
  const row = Math.floor((s - 1) / 8)
  // a spread from dark to light: series i of n
  const spread = (name: string, lo: number, hi: number) => (i: number, n: number) => {
    const t = n > 1 ? lo + ((hi - lo) * i) / (n - 1) : (lo + hi) / 2
    return t < 0 ? scheme(name, [mod('lumMod', (1 + t) * 100000)], ctx, '#808080') : scheme(name, [mod('lumMod', (1 - t) * 100000), mod('lumOff', t * 100000)], ctx, '#808080')
  }
  const color =
    col === 0
      ? (i: number, n: number) => spread('tx1', 0.25, 0.85)(i, n)
      : col === 1
        ? (i: number) => accentRound(i, ctx)
        : spread(`accent${col - 1}`, -0.5, 0.5)
  // Excel's own grays are shades of the theme's text color: text at 65 %, axis lines at 25 %, gridlines at 15 %
  const gray = (pct: number, def: string) => scheme('tx1', [mod('lumMod', pct * 1000), mod('lumOff', (100 - pct) * 1000)], ctx, def)
  const out: ChartStyle = { color, text: gray(65, '#595959'), axis: gray(25, '#bfbfbf'), grid: gray(15, '#d9d9d9') }
  if (row === 4) out.plot = col <= 1 ? scheme('bg1', [mod('lumMod', 95000)], ctx, '#f2f2f2') : scheme(`accent${col - 1}`, [mod('lumMod', 20000), mod('lumOff', 80000)], ctx, '#f2f2f2')
  if (row === 5) {
    out.bg = scheme('tx1', [mod('lumMod', 85000), mod('lumOff', 15000)], ctx, '#262626')
    out.plot = scheme('tx1', [mod('lumMod', 75000), mod('lumOff', 25000)], ctx, '#404040')
    out.text = scheme('bg1', [], ctx, '#ffffff')
    out.grid = scheme('bg1', [mod('lumMod', 50000)], ctx, '#808080')
    out.axis = scheme('bg1', [mod('lumMod', 65000)], ctx, '#a6a6a6')
  }
  return out
}

/** an accent of the theme, darker or lighter in later rounds (series 7 on), as Excel colors series without their own */
function accentRound(i: number, ctx: ColorCtx): string {
  const round = Math.floor(i / 6)
  const mods: XEl[] = []
  if (round % 4 === 1) mods.push(mod('lumMod', 60000))
  else if (round % 4 === 2) mods.push(mod('lumMod', 80000), mod('lumOff', 20000))
  else if (round % 4 === 3) mods.push(mod('lumMod', 80000))
  return scheme(`accent${(i % 6) + 1}`, mods, ctx, '#4472c4')
}

/** a shape's fill: a color, null for none, undefined where it says nothing; a gradient or pattern stands as one color */
function fillOf(spPr: XEl | undefined, ctx: ColorCtx): string | null | undefined {
  if (!spPr) return undefined
  if (kid(spPr, 'noFill')) return null
  const solid = kid(spPr, 'solidFill')
  if (solid) return safe(colorOf(solid, ctx)) ?? undefined
  const look = lookOf(spPr, ctx)
  if (look?.kind === 'gradient') return look.stops[0].color
  if (look?.kind === 'pattern') return look.fg
  return undefined
}

/** a shape's gradient or pattern fill */
function lookOf(spPr: XEl | undefined, ctx: ColorCtx): FillLook | undefined {
  const grad = kid(spPr, 'gradFill')
  if (grad) {
    const stops = kids(kid(grad, 'gsLst'), 'gs')
      .map((gs) => ({ pos: Math.max(0, Math.min(1, num(gs.a.pos, 0)! / 100000)), color: safe(colorOf(gs, ctx)) }))
      .filter((s): s is { pos: number; color: string } => !!s.color)
      .sort((a, b) => a.pos - b.pos)
    if (!stops.length) return undefined
    const lin = kid(grad, 'lin')
    return { kind: 'gradient', stops, angle: lin ? num(lin.a.ang, 0)! / 60000 : 90, radial: !lin && !!kid(grad, 'path') }
  }
  const patt = kid(spPr, 'pattFill')
  if (patt) {
    const fg = safe(colorOf(kid(patt, 'fgClr'), ctx)) ?? '#000000'
    const bg = safe(colorOf(kid(patt, 'bgClr'), ctx)) ?? '#ffffff'
    return { kind: 'pattern', preset: patt.a.prst ?? 'pct5', fg, bg }
  }
  return undefined
}

/** a shape's fill and its look together */
function fullFill(spPr: XEl | undefined, ctx: ColorCtx, def: string | null): Fill {
  const f = fillOf(spPr, ctx)
  const look = lookOf(spPr, ctx)
  return { fill: f === undefined ? def : f, ...(look ? { look } : {}) }
}

function lineOf(spPr: XEl | undefined, ctx: ColorCtx): { color?: string; width?: number; dash?: string } | null | undefined {
  const ln = kid(spPr, 'ln')
  if (!ln) return undefined
  if (kid(ln, 'noFill')) return null
  const w = num(ln.a.w)
  const dash = val(kid(ln, 'prstDash'))
  return { color: safe(colorOf(kid(ln, 'solidFill'), ctx)), width: w !== undefined ? w / EMU_PER_PT : undefined, dash: dash && dash !== 'solid' ? dash : undefined }
}

/** a line the file gives in full (its color at least); null where it says none, undefined where it says nothing */
function ownLine(spPr: XEl | undefined, ctx: ColorCtx, defWidth: number): LineLook | null | undefined {
  const l = lineOf(spPr, ctx)
  if (l === null) return null
  if (!l?.color) return undefined
  return { color: l.color, width: l.width ?? defWidth, ...(l.dash ? { dash: l.dash } : {}) }
}

function labelsOf(el: XEl | undefined, ctx: ColorCtx): DataLabels | undefined {
  if (!el || on(kid(el, 'delete'))) return undefined
  const l = labelOf(el, ctx, undefined)
  // a point's own label (`c:dLbl`) over the series': shown, hidden or placed elsewhere
  const points: Record<number, DataLabels | null> = {}
  for (const d of kids(el, 'dLbl')) {
    const k = num(val(kid(d, 'idx')), -1)!
    if (k < 0 || !Number.isInteger(k)) continue
    const own = on(kid(d, 'delete')) ? null : labelOf(d, ctx, l)
    points[k] = own && (own.value || own.percent || own.category || own.series) ? own : null
  }
  const shown = l.value || l.percent || l.category || l.series
  if (Object.keys(points).length) return { ...l, points }
  return shown ? l : undefined
}

/** a `c:dLbls` or `c:dLbl` element's labels, what it leaves out taken from `under` */
function labelOf(el: XEl, ctx: ColorCtx, under: DataLabels | undefined): DataLabels {
  const flag = (n: string, def: boolean) => (kid(el, n) ? on(kid(el, n)) : def)
  const text = textLookOf(el, ctx) ?? under?.text
  const format = kid(el, 'numFmt')?.a.formatCode ?? under?.format
  const sep = textOf(kid(el, 'separator')) || under?.sep
  const pos = val(kid(el, 'dLblPos')) ?? under?.pos
  return {
    value: flag('showVal', under?.value ?? false),
    percent: flag('showPercent', under?.percent ?? false),
    category: flag('showCatName', under?.category ?? false),
    series: flag('showSerName', under?.series ?? false),
    ...(pos ? { pos } : {}),
    ...(format ? { format } : {}),
    ...(sep ? { sep } : {}),
    ...(text ? { text } : {}),
  }
}

/** the labels point `k` of a series shows: its own, else the series'; undefined where it shows none */
export function labelsAt(s: { labels?: DataLabels }, k: number): DataLabels | undefined {
  const l = s.labels
  if (!l) return undefined
  const own = l.points?.[k]
  if (own !== undefined) return own ?? undefined
  return l.value || l.percent || l.category || l.series ? l : undefined
}

/** the most points read from a chart's saved values: `ptCount` is the file's word, and allocated as an array */
const MAX_CACHED = 100_000
/** the most points a chart reads from its cells and saved values together: one past it is shown as its placeholder */
export const MAX_CHART_POINTS = 250_000
/** the most series a chart has in Excel: one with more is shown as its placeholder */
export const MAX_SERIES = 255

/**
 * The most points the charts read together hold: a sheet's, a document's or a presentation's. Each chart has its own
 * budget (`MAX_CHART_POINTS`), which a file of a thousand small chart parts would take a thousand times: a series
 * that only says it has 100 000 points (`c:ptCount`) is a few bytes in the file and megabytes once read. A chart
 * read past it is shown as its placeholder.
 */
export const MAX_READ_POINTS = 1_000_000

/** the points charts read together may still take (`MAX_READ_POINTS` to begin with) */
export interface PointBudget {
  left: number
}

export const pointBudget = (): PointBudget => ({ left: MAX_READ_POINTS })

let keyed = 0

/** names for the charts of one document (`ChartModel.key`): its chart parts' names, told from every other document's */
export function chartKeys(): (part: string) => string {
  const doc = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}.${keyed++}`
  return (part) => `${doc}:${part}`
}

/** the points a chart's model holds: its series' values and their categories */
export function modelPoints(m: ChartModel): number {
  let n = 0
  for (const g of m.groups) for (const s of g.series) n += s.values.length + s.cats.length
  return n
}

/**
 * Takes a chart's points of `budget` for one more place that shows it, where it has them left. A chart part is read
 * once, but its model is posted with every slide and every batch of paragraphs that shows it: a part shown in a
 * thousand places would be held a thousand times.
 */
export function showable(budget: PointBudget, m: ChartModel): boolean {
  const n = modelPoints(m)
  if (n > budget.left) return false
  budget.left -= n
  return true
}

/** where a chart's values come from: the workbook's cells, and the points it may still read */
interface Sources {
  read: RangeReader
  left: number
  /** the budget shared with the charts read with this one, and what this chart has taken of it */
  shared?: PointBudget
  taken: number
}

/** takes `n` points of the chart's budget, and of the one it shares; past either the chart is not read (its placeholder is shown) */
function take(src: Sources, n: number) {
  src.left -= n
  if (src.left < 0) throw new Error(`more than ${MAX_CHART_POINTS} points in the chart`)
  if (!src.shared) return
  src.shared.left -= n
  src.taken += n
  if (src.shared.left < 0) throw new Error(`more than ${MAX_READ_POINTS} points in the charts read together`)
}

/** a chart that was not read after all gives back what it took of the shared budget */
function giveBack(src: Sources) {
  if (src.shared) src.shared.left += src.taken
  src.taken = 0
}

/** a cache's points by index (`c:pt idx`), `ptCount` long */
function cacheOf(cache: XEl | undefined, src: Sources): { values: (string | null)[]; format?: string } | null {
  if (!cache) return null
  const count = num(val(kid(cache, 'ptCount')), 0)!
  const n = Number.isFinite(count) ? Math.min(Math.max(0, Math.floor(count)), MAX_CACHED) : 0
  take(src, n)
  const values: (string | null)[] = new Array(n).fill(null)
  for (const pt of kids(cache, 'pt')) {
    const i = num(pt.a.idx, -1)!
    if (i >= 0 && i < n) values[i] = textOf(kid(pt, 'v'))
  }
  return { values, format: textOf(kid(cache, 'formatCode')) || undefined }
}

interface Read {
  values: (number | string | null)[]
  format?: string
  hidden?: boolean[]
}

/** a title whose text is a cell (`c:tx/c:strRef`): the cell's text, else the cached one */
async function referencedText(el: XEl, ctx: ColorCtx, src: Sources, size: number): Promise<ChartText | undefined> {
  const text = (await source(kid(el, 'tx'), src))?.values.filter((x) => x !== null && x !== '').join(' ')
  return text ? { text: String(text), size, bold: false, ...txLook(el, ctx) } : undefined
}

/** a data source (`c:cat`, `c:val`, `c:xVal`, `c:yVal`, `c:tx`): its reference read from the cells, else its cache */
async function source(el: XEl | undefined, src: Sources): Promise<Read | null> {
  if (!el) return null
  const ref = kid(el, 'numRef') ?? kid(el, 'strRef') ?? kid(el, 'multiLvlStrRef')
  const lit = kid(el, 'numLit') ?? kid(el, 'strLit')
  const f = textOf(kid(ref, 'f'))
  if (f) {
    const got = await src.read(f).catch(() => null)
    if (got) take(src, got.values.length)
    if (got) return { values: got.values, format: got.formats.find((x) => x && x !== 'General'), hidden: got.hidden }
  }
  const cache = cacheOf(kid(ref, 'numCache') ?? kid(ref, 'strCache') ?? lit, src) ?? multiLevel(kid(ref, 'multiLvlStrCache'), src)
  return cache ? { values: cache.values, format: cache.format } : null
}

/** multi-level categories: the innermost level (the labels next to the axis) */
function multiLevel(cache: XEl | undefined, src: Sources) {
  const lvl = kids(cache, 'lvl')[0]
  if (!cache || !lvl) return null
  return cacheOf({ ...lvl, c: [kid(cache, 'ptCount')!, ...lvl.c].filter(Boolean) }, src)
}

const toNum = (v: number | string | null | undefined): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

interface SeriesCtx {
  ctx: ColorCtx
  read: Sources
  plotVisOnly: boolean
  date1904: boolean
  style: ChartStyle
  /** the series in the chart, for a style's spread of shades */
  count: number
  /** radar: 'standard', 'marker' or 'filled' */
  radarStyle?: string
  /** the group's own word on markers, for series that say nothing of theirs (a line chart's `c:marker`, a scatter style) */
  markers: boolean
  /** a 3D group: its lines are ribbons, filled */
  three: boolean
}

async function seriesOf(ser: XEl, i: number, type: ChartType, varyColors: boolean, sc: SeriesCtx): Promise<ChartSeries> {
  const { ctx, read, plotVisOnly, date1904, style } = sc
  const tx = await source(kid(ser, 'tx'), read)
  const given = tx?.values.filter((x) => x !== null && x !== '').join(' ') || textOf(kid(kid(ser, 'tx'), 'v'))
  const name = given || `Series${num(val(kid(ser, 'idx')), i)! + 1}`
  const scatter = type === 'scatter' || type === 'bubble'
  const catSrc = await source(kid(ser, scatter ? 'xVal' : 'cat'), read)
  const valSrc = await source(kid(ser, scatter ? 'yVal' : 'val'), read)
  const sizeSrc = type === 'bubble' ? await source(kid(ser, 'bubbleSize'), read) : null
  let values = (valSrc?.values ?? []).map(toNum)
  let sizes = sizeSrc ? sizeSrc.values.map(toNum) : undefined
  // categories that are numbers or dates are shown in their format, text as it is
  const catText = (v: number | string | null) => {
    if (v === null) return ''
    const n = typeof v === 'number' ? v : catSrc?.format ? toNum(v) : null
    // (a number that is none, 1e999 read from a cell, has no format to be shown in)
    return n === null || !Number.isFinite(n) ? String(v) : formatValue(n, catSrc?.format || 'General', date1904).text
  }
  let cats = (catSrc?.values ?? []).map(catText)
  let catValues = !scatter && catSrc ? catSrc.values.map(toNum) : undefined
  // a scatter series without X values, or with X values that are text, is numbered 1, 2, 3, ... (left undefined), as
  // Excel does; with numbers, a missing one leaves a gap
  const textX = !!catSrc?.values.some((v) => v !== null && v !== '' && toNum(v) === null)
  let xs = scatter && catSrc && !textX ? catSrc.values.map(toNum) : undefined
  // hidden rows / columns are left out where the chart shows visible cells only
  const hidden = valSrc?.hidden
  // the file's point index → the index among the points shown, when hidden ones are left out
  let shownAt: ((k: number) => number | undefined) | undefined
  if (plotVisOnly && hidden?.some(Boolean)) {
    const keep = (_: unknown, k: number) => !hidden[k]
    const map = new Map<number, number>()
    for (let k = 0, j = 0; k < hidden.length; k++) if (!hidden[k]) map.set(k, j++)
    shownAt = (k) => (k < hidden.length ? map.get(k) : k - hidden.length + map.size)
    values = values.filter(keep)
    catValues = catValues?.filter(keep)
    cats = cats.filter(keep)
    xs = xs?.filter(keep)
    sizes = sizes?.filter(keep)
  }
  if (!cats.length) cats = values.map((_, k) => String(k + 1))
  const spPr = kid(ser, 'spPr')
  const color = style.color(num(val(kid(ser, 'idx')), i)!, sc.count)
  const ownFill = fillOf(spPr, ctx)
  const look = lookOf(spPr, ctx)
  const lineOwn = lineOf(spPr, ctx)
  // lines, scatter, stock and radar draw lines; a filled radar draws areas as bars and areas do; a 3D line is a ribbon,
  // filled with its fill (or its line's color)
  const lined = (type === 'line' && !sc.three) || type === 'scatter' || type === 'stock' || (type === 'radar' && sc.radarStyle !== 'filled')
  const fill = lined ? null : ownFill === undefined ? (sc.three && type === 'line' ? (lineOwn?.color ?? color) : color) : ownFill
  const line =
    lineOwn === null
      ? null
      : lined
        ? { color: lineOwn?.color ?? color, width: lineOwn?.width ?? 2.25, dash: lineOwn?.dash }
        : lineOwn?.color
          ? { color: lineOwn.color, width: lineOwn.width ?? 0.75, dash: lineOwn.dash }
          : null
  const mk = kid(ser, 'marker')
  // a radar of style 'standard' has no markers; one of style 'marker' has them unless a series says none
  const markable = lined && !(type === 'radar' && sc.radarStyle === 'standard')
  // a series without a symbol of its own follows its group (and a radar its style)
  const symbol = val(kid(mk, 'symbol'), markable && sc.markers ? 'auto' : 'none')!
  const markerSpPr = kid(mk, 'spPr')
  const marker =
    symbol === 'none' || !markable
      ? null
      : {
          symbol: symbol === 'auto' ? ['diamond', 'square', 'triangle', 'x', 'star', 'circle'][i % 6] : symbol,
          size: num(val(kid(mk, 'size')), 5)!,
          fill: fillOf(markerSpPr, ctx) ?? line?.color ?? color,
          line: lineOf(markerSpPr, ctx)?.color ?? line?.color ?? color,
        }
  const points: Record<number, ChartPoint> = {}
  // pie slices (and the points of a single series told to vary its colors) get the style's colors in turn
  if (varyColors) values.forEach((_, k) => (points[k] = { color: style.color(k, values.length) }))
  for (const dPt of kids(ser, 'dPt')) {
    const idx = num(val(kid(dPt, 'idx')), -1)!
    // a point's own look follows it when hidden points are left out; a hidden point's goes with it
    const k = idx < 0 ? undefined : shownAt ? shownAt(idx) : idx
    if (k === undefined) continue
    const c = fillOf(kid(dPt, 'spPr'), ctx)
    const pl = lookOf(kid(dPt, 'spPr'), ctx)
    points[k] = {
      ...points[k],
      ...(c !== undefined && c !== null ? { color: c } : {}),
      ...(pl ? { look: pl } : {}),
      ...(kid(dPt, 'explosion') ? { explosion: num(val(kid(dPt, 'explosion')), 0) } : {}),
    }
  }
  const explosion = num(val(kid(ser, 'explosion')))
  if (explosion) values.forEach((_, k) => (points[k] = { explosion, ...points[k] }))
  return {
    name,
    ...(given ? {} : { unnamed: true }),
    cats,
    xs,
    ...(scatter && catSrc?.format ? { xFormat: catSrc.format } : {}),
    ...(catValues?.some((v) => v !== null) ? { catValues } : {}),
    values,
    ...(sizes ? { sizes } : {}),
    format: valSrc?.format,
    fill,
    ...(look && fill !== null ? { look } : {}),
    line,
    marker,
    smooth: on(kid(ser, 'smooth')),
    ...(kid(ser, 'shape') ? { shape: val(kid(ser, 'shape'), 'box') } : {}),
    invertIfNegative: on(kid(ser, 'invertIfNegative')),
    points,
    labels: shownLabels(labelsOf(kid(ser, 'dLbls'), ctx), shownAt),
  }
}

/** a series' labels with its points' own ones moved to their places among the points shown (hidden ones left out) */
function shownLabels(l: DataLabels | undefined, shownAt: ((k: number) => number | undefined) | undefined): DataLabels | undefined {
  if (!l?.points || !shownAt) return l
  const points: Record<number, DataLabels | null> = {}
  for (const [k, v] of Object.entries(l.points)) {
    const at = shownAt(Number(k))
    if (at !== undefined) points[at] = v
  }
  return { ...l, points }
}

function axisOf(el: XEl, ctx: ColorCtx, defSize: number): ChartAxis {
  const scaling = kid(el, 'scaling')
  const fmt = kid(el, 'numFmt')
  const crosses = val(kid(el, 'crosses'))
  const grid = kid(el, 'majorGridlines')
  const gridLine = grid ? ownLine(kid(grid, 'spPr'), ctx, 0.75) : undefined
  const axLine = ownLine(kid(el, 'spPr'), ctx, 0.75)
  const text = textLookOf(el, ctx)
  // -60000000 is the file's word for "as Excel sees fit"
  const rotRaw = num(kid(kid(el, 'txPr'), 'bodyPr')?.a.rot)
  const rot = rotRaw !== undefined && rotRaw !== -60000000 && Number.isFinite(rotRaw) ? Math.max(-90, Math.min(90, rotRaw / 60000)) : undefined
  const base = val(kid(el, 'baseTimeUnit'))
  return {
    ...(rot !== undefined ? { rot } : {}),
    ...(base === 'days' || base === 'months' || base === 'years' ? { baseUnit: base } : {}),
    ...(gridLine !== undefined ? { grid: gridLine } : {}),
    ...(axLine !== undefined ? { line: axLine } : {}),
    ...(text ? { text } : {}),
    id: val(kid(el, 'axId'), '')!,
    kind: el.n === 'catAx' ? 'cat' : el.n === 'dateAx' ? 'date' : el.n === 'serAx' ? 'ser' : 'val',
    pos: val(kid(el, 'axPos'), 'b')!,
    deleted: on(kid(el, 'delete')),
    reverse: val(kid(scaling, 'orientation')) === 'maxMin',
    logBase: num(val(kid(scaling, 'logBase'))),
    min: num(val(kid(scaling, 'min'))),
    max: num(val(kid(scaling, 'max'))),
    major: num(val(kid(el, 'majorUnit'))),
    format: fmt && fmt.a.sourceLinked !== '1' ? fmt.a.formatCode : undefined,
    gridlines: !!kid(el, 'majorGridlines'),
    labels: val(kid(el, 'tickLblPos'), 'nextTo') !== 'none',
    title: richText(kid(el, 'title'), ctx, defSize, true),
    crossAx: val(kid(el, 'crossAx'), '')!,
    crosses: crosses === 'min' || crosses === 'max' ? crosses : 'autoZero',
    crossesAt: num(val(kid(el, 'crossesAt'))),
  }
}

function layoutOf(el: XEl | undefined): ChartLayout | undefined {
  const m = kid(kid(el, 'layout'), 'manualLayout')
  if (!m) return undefined
  const x = num(val(kid(m, 'x')))
  const y = num(val(kid(m, 'y')))
  const w = num(val(kid(m, 'w')))
  const h = num(val(kid(m, 'h')))
  // only 'edge' positions (fractions from the top left) are read; 'factor' ones move Excel's own layout
  if (x === undefined || y === undefined || w === undefined || h === undefined || val(kid(m, 'xMode')) === 'factor' || val(kid(m, 'yMode')) === 'factor') return undefined
  return { x, y, w, h, target: val(kid(m, 'layoutTarget')) === 'inner' ? 'inner' : 'outer' }
}

/**
 * The chart in `root` (a chart part's `c:chartSpace`), or null where it has no kind this reads (it stays a placeholder).
 * `read` gives a series reference's cells; `theme` resolves its colors; `budget` is shared by the charts read together.
 */
export async function readChart(root: XEl | undefined, opts: { theme: Theme; date1904: boolean; read: RangeReader; budget?: PointBudget }): Promise<ChartModel | null> {
  const src: Sources = { read: opts.read, left: MAX_CHART_POINTS, shared: opts.budget, taken: 0 }
  try {
    const model = await readModel(root, opts, src)
    if (!model) giveBack(src)
    return model
  } catch (e) {
    giveBack(src)
    throw e
  }
}

async function readModel(root: XEl | undefined, opts: { theme: Theme; date1904: boolean }, src: Sources): Promise<ChartModel | null> {
  const chart = kid(root, 'chart')
  const plot = kid(chart, 'plotArea')
  if (!chart || !plot) return null
  const ctx: ColorCtx = { theme: opts.theme }
  const style = chartStyle(styleOf(root), ctx)
  const base = txLook(root, ctx)
  const fontSize = base?.size || 10
  const textColor = base?.color ?? style.text
  const plotVisOnly = on(kid(chart, 'plotVisOnly'), true)
  const groups: ChartGroup[] = []
  let seriesIndex = 0
  const count = plot.c.reduce((a, g) => a + (GROUPS[g.n] ? kids(g, 'ser').length : 0), 0)
  if (count > MAX_SERIES) return null
  for (const g of plot.c) {
    const type = GROUPS[g.n]
    if (!type) continue
    const grouping = val(kid(g, 'grouping'), type === 'bar' ? 'clustered' : 'standard') as Grouping
    const varyColors = on(kid(g, 'varyColors'), type === 'pie' || type === 'doughnut')
    const radarStyle = type === 'radar' ? val(kid(g, 'radarStyle'), 'marker') : undefined
    const series: ChartSeries[] = []
    // a pie shows its first series, a slice per point in its own color; other kinds vary colors for a lone series only
    const vary = varyColors && type !== 'surface' && type !== 'stock' && (type === 'pie' || type === 'doughnut' || kids(g, 'ser').length === 1)
    // a line chart marks its points unless it says not to; a scatter chart of style line or smooth has no markers
    const scatterStyle = val(kid(g, 'scatterStyle'))
    const markers = type === 'scatter' ? scatterStyle !== 'line' && scatterStyle !== 'smooth' : on(kid(g, 'marker'), true)
    const three = g.n.includes('3D')
    const sc: SeriesCtx = { ctx, read: src, plotVisOnly, date1904: opts.date1904, style, count, radarStyle, markers, three }
    for (const ser of kids(g, 'ser')) series.push(await seriesOf(ser, seriesIndex++, type, vary, sc))
    // a group with no series draws nothing (and has no values to scale)
    if (!series.length) continue
    const groupLabels = labelsOf(kid(g, 'dLbls'), ctx)
    if (groupLabels) for (const s of series) s.labels ??= groupLabels
    groups.push({
      type,
      dir: val(kid(g, 'barDir')) === 'bar' ? 'bar' : 'col',
      grouping,
      gapWidth: within(num(val(kid(g, 'gapWidth')), 150)!, 0, 500, 150),
      overlap: within(num(val(kid(g, 'overlap')), grouping === 'stacked' || grouping === 'percentStacked' ? 100 : 0)!, -100, 100, 0),
      varyColors,
      holeSize: within(num(val(kid(g, 'holeSize')), 50)!, 10, 90, 50),
      firstSliceAng: within(num(val(kid(g, 'firstSliceAng')), 0)!, 0, 360, 0),
      scatterStyle: val(kid(g, 'scatterStyle')),
      ...(radarStyle ? { radarStyle } : {}),
      ...(type === 'bubble'
        ? {
            bubbleScale: within(num(val(kid(g, 'bubbleScale')), 100)!, 0, 300, 100),
            sizeRepresents: val(kid(g, 'sizeRepresents')) === 'w' ? ('w' as const) : ('area' as const),
            showNegBubbles: on(kid(g, 'showNegBubbles')),
          }
        : {}),
      ...(type === 'stock' ? stockParts(g, ctx, textColor) : {}),
      ...(three ? { three, gapDepth: within(num(val(kid(g, 'gapDepth')), 150)!, 0, 500, 150), ...(type === 'bar' ? { shape: val(kid(g, 'shape'), 'box') } : {}) } : {}),
      ...(type === 'surface' ? surfaceParts(g, ctx, style) : {}),
      axIds: kids(g, 'axId').map((a) => a.a.val ?? ''),
      series,
    })
  }
  if (!groups.length || !groups.some((g) => g.series.length)) return null
  const axes = plot.c.filter((a) => a.n === 'catAx' || a.n === 'valAx' || a.n === 'dateAx' || a.n === 'serAx').map((a) => axisOf(a, ctx, fontSize))
  // a title without text of its own is Excel's automatic one: the name of a lone series that has one, else "Chart Title";
  // a chart of one series without a title element has that automatic title too unless it was deleted
  const single = groups.length === 1 && groups[0].series.length === 1
  const titleEl = kid(chart, 'title')
  const auto = (): ChartText => ({ text: single && !groups[0].series[0].unnamed ? groups[0].series[0].name : 'Chart Title', size: fontSize * 1.4, bold: false, ...txLook(titleEl, ctx) })
  let title = titleEl ? (richText(titleEl, ctx, fontSize * 1.4, false) ?? (await referencedText(titleEl, ctx, src, fontSize * 1.4)) ?? auto()) : undefined
  if (!titleEl && single && !groups[0].series[0].unnamed && !on(kid(chart, 'autoTitleDeleted')) && groups[0].type !== 'scatter') title = auto()
  if (title) {
    if (!title.size) title.size = fontSize * 1.4
    title.color ??= textColor
  }
  const legend = kid(chart, 'legend')
  const legendText = textLookOf(legend, ctx)
  const spPr = kid(root, 'spPr')
  const border = lineOf(spPr, ctx)
  const bg = fillOf(spPr, ctx)
  const bgLook = lookOf(spPr, ctx)
  const plotSp = kid(plot, 'spPr')
  const plotFill = fillOf(plotSp, ctx)
  const plotLook = lookOf(plotSp, ctx)
  const plotBorder = ownLine(plotSp, ctx, 0.75)
  const view3d = groups.some((g) => g.three) ? viewOf(chart, groups, ctx) : undefined
  return {
    title,
    ...(view3d ? { view3d } : {}),
    legend: legend
      ? {
          pos: val(kid(legend, 'legendPos'), 'r')!,
          overlay: on(kid(legend, 'overlay')),
          deleted: kids(legend, 'legendEntry').filter((e) => on(kid(e, 'delete'))).map((e) => num(val(kid(e, 'idx')), -1)!),
          ...(legendText ? { text: legendText } : {}),
        }
      : undefined,
    groups,
    axes,
    plot: layoutOf(plot),
    fontSize,
    textColor,
    bg: bg === undefined ? style.bg : bg,
    ...(bgLook ? { bgLook } : {}),
    border: border === null ? null : border?.color,
    plotFill: plotFill === undefined ? style.plot : plotFill,
    ...(plotLook ? { plotLook } : {}),
    ...(plotBorder !== undefined ? { plotBorder } : {}),
    gridColor: style.grid,
    axisColor: style.axis,
    // Excel leaves a gap where the element is missing
    blanks: ((b) => (b === 'zero' || b === 'span' ? b : 'gap'))(val(kid(chart, 'dispBlanksAs'))),
    date1904: opts.date1904,
  }
}

/**
 * A chart of a Word document or PowerPoint slide: its values are those saved with it (the workbook they come from is
 * embedded in the file and not read), its colors resolved against the document's theme.
 */
export function readSavedChart(root: XEl | undefined, theme: Theme, budget?: PointBudget): Promise<ChartModel | null> {
  return readChart(root, { theme, date1904: on(kid(root, 'date1904')), read: async () => null, budget })
}

/** a 3D chart's view, its walls and floor; Excel's defaults where the file gives none */
function viewOf(chart: XEl, groups: ChartGroup[], ctx: ColorCtx): View3D {
  const v = kid(chart, 'view3D')
  const pie = groups[0].type === 'pie'
  // a chart with a depth axis (series one behind another) or a surface is drawn in perspective unless it says not
  const deep = groups.some((g) => g.type === 'surface' || (g.grouping === 'standard' && g.type !== 'pie'))
  const wall = (n: string) => {
    const el = kid(chart, n)
    const sp = kid(el, 'spPr')
    if (!sp) return undefined
    const line = ownLine(sp, ctx, 0.75)
    return { ...fullFill(sp, ctx, null), ...(line !== undefined ? { line } : {}) }
  }
  const hp = num(val(kid(v, 'hPercent')))
  const floor = wall('floor')
  const side = wall('sideWall')
  const back = wall('backWall')
  return {
    rotX: within(num(val(kid(v, 'rotX')), pie ? 30 : 15)!, -90, 90, 15),
    rotY: within(num(val(kid(v, 'rotY')), pie ? 0 : 20)!, 0, 360, 20),
    rightAngle: pie ? false : on(kid(v, 'rAngAx'), !deep),
    perspective: within(num(val(kid(v, 'perspective')), 30)!, 0, 240, 30),
    depthPercent: within(num(val(kid(v, 'depthPercent')), 100)!, 20, 2000, 100),
    ...(hp !== undefined && Number.isFinite(hp) ? { hPercent: within(hp, 5, 500, 100) } : {}),
    ...(floor ? { floor } : {}),
    ...(side ? { side } : {}),
    ...(back ? { back } : {}),
  }
}

/** the built-in style number: Excel 2010's own (`c14:style`, 101…148) where it is given, else `c:style` */
function styleOf(root: XEl | undefined): number | undefined {
  for (const el of root?.c ?? []) {
    // the XML reader may already have taken the c14 choice out of its AlternateContent: then 101…148 arrives here
    if (el.n === 'style') {
      const s = num(el.a.val)
      return s !== undefined && s > 100 ? s - 100 : s
    }
    if (el.n === 'AlternateContent') {
      const choice = kid(el, 'Choice')
      const s14 = num(kid(choice, 'style')?.a.val)
      if (s14 !== undefined) return s14 > 100 ? s14 - 100 : s14
      const fb = num(kid(kid(el, 'Fallback'), 'style')?.a.val)
      if (fb !== undefined) return fb
    }
  }
  return undefined
}

/** a stock group's high-low lines and up-down bars */
function stockParts(g: XEl, ctx: ColorCtx, textColor: string): Pick<ChartGroup, 'hiLow' | 'upDown'> {
  const hl = kid(g, 'hiLowLines')
  const ud = kid(g, 'upDownBars')
  const bar = (el: XEl | undefined, def: string) => ({ ...fullFill(kid(el, 'spPr'), ctx, def), line: ownLine(kid(el, 'spPr'), ctx, 0.75) ?? { color: textColor, width: 0.75 } })
  return {
    hiLow: hl ? (ownLine(kid(hl, 'spPr'), ctx, 0.75) ?? { color: textColor, width: 0.75 }) : null,
    ...(ud ? { upDown: { gapWidth: num(val(kid(ud, 'gapWidth')), 150)!, up: bar(kid(ud, 'upBars'), '#ffffff'), down: bar(kid(ud, 'downBars'), '#000000') } } : {}),
  }
}

/** a surface group's wireframe flag and its bands' own fills (`c:bandFmts`) */
function surfaceParts(g: XEl, ctx: ColorCtx, style: ChartStyle): Pick<ChartGroup, 'wireframe' | 'bands' | 'bandColors'> {
  const bands: Record<number, Fill> = {}
  for (const b of kids(kid(g, 'bandFmts'), 'bandFmt')) {
    const k = num(val(kid(b, 'idx')), -1)!
    const f = fillOf(kid(b, 'spPr'), ctx)
    if (k >= 0 && f !== undefined) bands[k] = fullFill(kid(b, 'spPr'), ctx, null)
  }
  // how many bands there are depends on the axis drawn, so the style's colors are given for as many as can be
  return { wireframe: on(kid(g, 'wireframe')), bands, bandColors: Array.from({ length: SURFACE_BANDS }, (_, k) => style.color(k, SURFACE_BANDS)) }
}

/** the most value bands a surface chart is drawn with */
export const SURFACE_BANDS = 12
