/**
 * An Excel chart (chart.ts `ChartModel`) drawn as a self-contained SVG picture of `w` × `h` CSS pixels, DOM-free (it
 * runs anywhere): bars and columns (clustered, stacked, 100%), lines (markers, smoothing), areas, scatter, bubbles,
 * stock (high-low lines, up-down bars), pie and doughnut, radar, and surface (seen from above, as Excel's contour
 * chart), combined on primary and secondary axes; 3D charts in their view (chart-3d.ts); axis bounds chosen the way Excel does when the file fixes none
 * (zero included, steps of 1, 2 or 5), major gridlines, tick and data labels in the series' number formats, title and
 * legend, in the colors, lines, fills (gradients and patterns too) and text looks the file gives. Text is measured
 * with the diagram renderers' widths (diagram/svg.ts), so labels are placed without a browser.
 *
 * Every chart is its own picture, so the ids of its gradients, patterns and clip path need only be unique within it.
 */
import { dict } from '../dict'
import { lineHeight, pathData, Svg, textWidth, wrap, type Paint, type Pt } from '../diagram/svg'
import type { ChartAxis, ChartGroup, ChartModel, ChartSeries, ChartText, FillLook, LineLook, TextLook } from './chart'
import { labelsAt, SURFACE_BANDS } from './chart'
import { drawCartesian3D, drawPie3D } from './chart-3d'
import { formatValue, serialToDate } from './numfmt'

export const PX = 96 / 72
const PAD = 8

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** a value axis' scale: its bounds, step and ticks, and how a value maps to pixels along `len` */
interface Scale {
  min: number
  max: number
  ticks: number[]
  log?: number
  format?: string
}

const DASH: Record<string, number[]> = dict({
  dash: [4, 3], sysDash: [3, 1], dot: [1, 1], sysDot: [1, 1], dashDot: [4, 3, 1, 3], sysDashDot: [3, 1, 1, 1],
  lgDash: [8, 3], lgDashDot: [8, 3, 1, 3], lgDashDotDot: [8, 3, 1, 3, 1, 3], sysDashDotDot: [3, 1, 1, 1, 1, 1],
})
const dashOf = (d: string | undefined, w: number) => (d && DASH[d] ? DASH[d].map((x) => x * Math.max(1, w)).join(' ') : undefined)

/** a line's paint: its color, width and dash */
export const linePaint = (l: LineLook): Paint => ({ stroke: l.color, sw: Math.max(0.75, l.width * PX), dash: dashOf(l.dash, l.width) })

/** `v` in the number format `f`; nothing for a number that is none (a bound of 1e308 doubled): the formats take finite ones */
export const fmt = (v: number, f: string | undefined, date1904: boolean) => (Number.isFinite(v) ? formatValue(v, f || 'General', date1904).text : '')

/**
 * The most characters a chart's picture may hold. A browser lays a picture out on the main thread, for about a quarter
 * of a second a megabyte: a line chart of 100 000 points, each with its marker and label (28 MB, from a file of 4 KB
 * whose series only claim their points), held the page for seven seconds; the rings of a radar of them were 296 MB.
 * A picture past it is not finished: `renderChart` throws `PictureTooLarge` and the view shows the chart's placeholder.
 */
export const MAX_CHART_SVG = 8 * 1024 * 1024

/**
 * The most data labels and markers a chart is drawn with. Of more, every k-th point shows its own: that many overlap
 * into a band whatever their number, and are what a picture takes longest to lay out. A point's own label (`c:dLbl`)
 * is always shown.
 */
export const MAX_LABELS = 2_000
export const MAX_MARKERS = 20_000
/** the most entries a legend lists (a pie's legend has one per point) */
export const MAX_LEGEND = 500

// while a chart is drawn (`renderChart` runs to its end before another starts): every which point shows its series'
// label and its marker
let labelStep = 1
let markerStep = 1

const shownByFlags = (l: { value: boolean; percent: boolean; category: boolean; series: boolean }) => l.value || l.percent || l.category || l.series

/** whether point `k` of `s` shows its data label: its own always, its series' on every `labelStep`-th point */
export const labelShown = (s: ChartSeries, k: number) => labelStep === 1 || k % labelStep === 0 || s.labels?.points?.[k] !== undefined
const markerShown = (k: number) => markerStep === 1 || k % markerStep === 0

/** a radar with more points than this has rings too close to a circle to tell, and no room for a spoke per point */
const RADAR_CORNERS = 360

// a chart's values run to tens of thousands: spread into Math.min / Math.max they exceed the engine's argument limit
/** the smallest of `xs` (Infinity for none), as Math.min */
export function lowest(xs: readonly number[]): number {
  let m = Infinity
  for (const x of xs) if (x < m) m = x
  return m
}
/** the largest of `xs` (-Infinity for none), as Math.max */
export function highest(xs: readonly number[]): number {
  let m = -Infinity
  for (const x of xs) if (x > m) m = x
  return m
}

/**
 * Excel's automatic bounds: zero kept in view unless the values sit close together far from it, 5 % of the span left
 * past the values, and the smallest step of 1, 2 or 5 × 10ⁿ that keeps the axis to `ticks` intervals (at most 10)
 */
export function niceScale(lo: number, hi: number, opts: { min?: number; max?: number; major?: number; zero?: boolean; ticks?: number } = {}): Scale {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) (lo = 0), (hi = 1)
  if (lo > hi) [lo, hi] = [hi, lo]
  // bounds and a step that are not numbers, or fixed bounds the wrong way round (Excel keeps the minimum then)
  opts = { ...opts }
  if (opts.min !== undefined && !Number.isFinite(opts.min)) opts.min = undefined
  if (opts.max !== undefined && !Number.isFinite(opts.max)) opts.max = undefined
  if (opts.major !== undefined && !(Number.isFinite(opts.major) && opts.major > 0)) opts.major = undefined
  if (opts.min !== undefined && opts.max !== undefined && opts.max <= opts.min) opts.max = undefined
  if (opts.zero !== false) {
    // values close together far from zero: the axis starts half their spread below them; values all alike keep zero
    // in view, so bars of them have a height
    if (lo > 0 && lo > (hi * 5) / 6 && lo !== hi) lo -= (hi - lo) / 2
    else if (lo > 0) lo = 0
    if (hi < 0 && hi < (lo * 5) / 6 && lo !== hi) hi += (hi - lo) / 2
    else if (hi < 0) hi = 0
  }
  // room past the values, on the sides that are not zero: the largest value is not left on the top line
  const span = hi - lo || Math.abs(hi) * 0.1 || 1
  if (opts.max === undefined && hi !== 0) hi += span * 0.05
  if (opts.min === undefined && lo !== 0) lo -= span * 0.05
  if (opts.min !== undefined) lo = opts.min
  if (opts.max !== undefined) hi = opts.max
  // one bound fixed past all the values: the other one moves to give the axis a span
  if (hi < lo) {
    if (opts.max === undefined) hi = lo
    else if (opts.min === undefined) lo = hi
  }
  if (lo === hi) hi = lo === 0 ? 1 : lo + Math.abs(lo) * 0.1
  const most = Math.min(10, Math.max(1, Math.floor(opts.ticks ?? 6)))
  let step = opts.major
  if (!step || step <= 0) {
    const rough = (hi - lo) / most
    const mag = 10 ** Math.floor(Math.log10(rough))
    step = ([1, 2, 5, 10].find((m) => m * mag >= rough * 0.995) ?? 10) * mag
  }
  const min = opts.min ?? Math.floor(lo / step + 1e-9) * step
  let max = opts.max ?? Math.ceil(hi / step - 1e-9) * step
  if (max <= min) max = min + step
  const ticks: number[] = []
  for (let k = 0, v = min; v <= max + step * 1e-6 && k < 200; k++, v = min + k * step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v)
  return { min, max, ticks }
}

/**
 * How many intervals an automatic value axis of `len` px may have, as Excel allows them: labels of `size` px about
 * 1.6 times their size apart up the side, a label's width or so apart along the bottom
 */
export function intervals(len: number, size: number, across: boolean): number {
  return Math.max(1, Math.floor(len / (across ? Math.max(40, size * 4.5) : size * 1.6)))
}

function logScale(lo: number, hi: number, base: number, opts: { min?: number; max?: number }): Scale {
  const b = base > 1 ? base : 10
  const p0 = opts.min ?? b ** Math.floor(Math.log(Math.max(lo, 1e-12)) / Math.log(b))
  const p1 = opts.max ?? b ** Math.ceil(Math.log(Math.max(hi, p0 * b)) / Math.log(b))
  const ticks: number[] = []
  for (let v = p0; v <= p1 * 1.0001 && ticks.length < 60; v *= b) ticks.push(v)
  return { min: p0, max: p1, ticks, log: b }
}

/** a log axis over `values`: its bounds from the positive ones alone (a log axis has no place for zero or less) */
function logFor(values: readonly (number | null)[], base: number, opts: { min?: number; max?: number }): Scale {
  const pos = values.filter((v): v is number => v !== null && v > 0)
  return logScale(pos.length ? lowest(pos) : 1, pos.length ? highest(pos) : base, base, opts)
}

/** a value a scale can place: anything on a linear one, only positive values on a log one */
const placeable = (s: Scale, v: number) => !s.log || v > 0

/** a value's position along an axis: 0 at its minimum, 1 at its maximum */
function frac(s: Scale, v: number): number {
  if (s.log) {
    const l = (x: number) => Math.log(Math.max(x, 1e-12))
    return (l(v) - l(s.min)) / (l(s.max) - l(s.min))
  }
  return (v - s.min) / (s.max - s.min)
}

function textBlock(svg: Svg, t: ChartText, x: number, y: number, maxW: number, anchor: 'start' | 'middle' | 'end' = 'middle'): number {
  const size = t.size * PX
  const lines = wrap(t.text.split('\n'), Math.max(40, maxW), size, t.bold)
  const h = lines.length * lineHeight(size)
  svg.text(x, y + h / 2, lines, { size, bold: t.bold, color: t.color, anchor })
  return h
}

/** a text's size in px and color: its own look over the chart's */
export const textOf = (m: ChartModel, look: TextLook | undefined) => ({ size: (look?.size ?? m.fontSize) * PX, color: look?.color ?? m.textColor, bold: look?.bold })

// ---------------------------------------------------------------- fills: gradients and patterns

const defIds = new WeakMap<Svg, number>()

/** a pattern's tile: 8 pt, in CSS pixels */
const PATTERN_TILE = Math.round((8 * 96 * 1000) / 72) / 1000

/** the paint for a fill: its color, or a gradient or pattern defined in the picture */
export function fillPaint(svg: Svg, fill: string | null | undefined, look?: FillLook): string {
  if (!look || fill === null) return fill ?? 'none'
  const k = (defIds.get(svg) ?? 0) + 1
  defIds.set(svg, k)
  const id = `de-fill${k}`
  if (look.kind === 'gradient') {
    const stops = look.stops.map((s) => `<stop offset="${Math.round(s.pos * 1000) / 10}%" stop-color="${s.color}"/>`).join('')
    if (look.radial) svg.raw(`<defs><radialGradient id="${id}" cx="50%" cy="50%" r="70%">${stops}</radialGradient></defs>`)
    else {
      const a = (look.angle * Math.PI) / 180
      const r = (v: number) => Math.round(v * 1000) / 10
      const [x1, y1, x2, y2] = [0.5 - Math.cos(a) / 2, 0.5 - Math.sin(a) / 2, 0.5 + Math.cos(a) / 2, 0.5 + Math.sin(a) / 2]
      svg.raw(`<defs><linearGradient id="${id}" x1="${r(x1)}%" y1="${r(y1)}%" x2="${r(x2)}%" y2="${r(y2)}%">${stops}</linearGradient></defs>`)
    }
  } else {
    svg.raw(`<defs><pattern id="${id}" width="${PATTERN_TILE}" height="${PATTERN_TILE}" viewBox="0 0 8 8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="${look.bg}"/>${patternTile(look.preset, look.fg)}</pattern></defs>`)
  }
  return `url(#${id})`
}

/**
 * DrawingML's preset patterns as Office draws them: 8 × 8 bitmaps (the Windows hatch bitmaps), a row per byte, its high
 * bit at the left. A cell is a point, so the tile is 8 pt wide.
 */
const PATTERNS: Record<string, string> = dict({
  pct5: '8000000008000000', pct10: '8000080080000800', pct20: '8800220088002200', pct25: '8822882288228822',
  pct30: 'aa44aa11aa44aa11', pct40: 'aa55aa51aa55aa15', pct50: 'aa55aa55aa55aa55', pct60: 'ee55bb55ee55bb55',
  pct70: '77dd77dd77dd77dd', pct75: '77ffddff77ffddff', pct80: 'effffeffeffffeff', pct90: 'fffffff7ffffff7f',
  horz: 'ff00000000000000', vert: '8080808080808080', ltHorz: 'ff000000ff000000', ltVert: '8888888888888888',
  dkHorz: 'ffff0000ffff0000', dkVert: 'cccccccccccccccc', narHorz: 'ff00ff00ff00ff00', narVert: '5555555555555555',
  dashHorz: 'f00000000f000000', dashVert: '8080808008080808', cross: 'ff80808080808080',
  dnDiag: '8040201008040201', upDiag: '0102040810204080', ltDnDiag: '8844221188442211', ltUpDiag: '1122448811224488',
  dkDnDiag: 'cc663399cc663399', dkUpDiag: '3366cc993366cc99', wdDnDiag: 'c1e070381c0e0783', wdUpDiag: '83070e1c3870e0c1',
  dashDnDiag: '0000884422110000', dashUpDiag: '0000112244880000', diagCross: '8142241818244281',
  smCheck: '9966669999666699', lgCheck: 'f0f0f0f00f0f0f0f', smGrid: 'ff888888ff888888', lgGrid: 'ff80808080808080',
  dotGrid: 'aa00800080008000', smConfetti: '8008400210012004', lgConfetti: 'b130031bd8c00c8d', horzBrick: 'ff808080ff080808',
  diagBrick: '0102040818244281', solidDmnd: '10387cfe7c381000', openDmnd: '8244281028448201', dotDmnd: '8000220008002200',
  plaid: 'aa55aa55f0f0f0f0', sphere: '77898f8f7798f8f8', weave: '8854224588142251', divot: '0010081000800180',
  shingle: '038448300c020101', wave: '001825c0001825c0', trellis: 'ff66ff99ff66ff99', zigZag: '8142241881422418',
})

/** a preset pattern's foreground in its 8 × 8 tile, a run of set bits as one rectangle; one not known is drawn at 50 % */
function patternTile(preset: string, fg: string): string {
  const bits = PATTERNS[preset] ?? PATTERNS.pct50
  let d = ''
  for (let y = 0; y < 8; y++) {
    const row = parseInt(bits.slice(y * 2, y * 2 + 2), 16)
    for (let x = 0; x < 8; ) {
      if (!(row & (0x80 >> x))) {
        x++
        continue
      }
      const from = x
      while (x < 8 && row & (0x80 >> x)) x++
      d += `M${from} ${y}h${x - from}v1h${from - x}z`
    }
  }
  return d ? `<path d="${d}" fill="${fg}"/>` : ''
}

// ---------------------------------------------------------------- markers and lines

function marker(svg: Svg, x: number, y: number, m: NonNullable<ChartSeries['marker']>) {
  const r = Math.max(1.5, (m.size * PX) / 2)
  const p: Paint = { fill: m.fill ?? 'none', stroke: m.line, sw: 1 }
  switch (m.symbol) {
    case 'circle':
    case 'dot':
      svg.circle(x, y, m.symbol === 'dot' ? r / 2 : r, p)
      break
    case 'square':
      svg.rect(x - r, y - r, r * 2, r * 2, p)
      break
    case 'diamond':
      svg.poly([[x, y - r], [x + r, y], [x, y + r], [x - r, y]], p)
      break
    case 'triangle':
      svg.poly([[x, y - r], [x + r, y + r], [x - r, y + r]], p)
      break
    case 'x':
      svg.line(x - r, y - r, x + r, y + r, { stroke: m.line ?? m.fill, sw: 1.5 }).line(x - r, y + r, x + r, y - r, { stroke: m.line ?? m.fill, sw: 1.5 })
      break
    case 'plus':
      svg.line(x - r, y, x + r, y, { stroke: m.line ?? m.fill, sw: 1.5 }).line(x, y - r, x, y + r, { stroke: m.line ?? m.fill, sw: 1.5 })
      break
    case 'star': {
      const pts: [number, number][] = []
      for (let k = 0; k < 10; k++) {
        const a = -Math.PI / 2 + (k * Math.PI) / 5
        const rr = k % 2 ? r * 0.45 : r
        pts.push([x + rr * Math.cos(a), y + rr * Math.sin(a)])
      }
      svg.poly(pts, p)
      break
    }
    case 'dash':
      svg.line(x - r, y, x + r, y, { stroke: m.line ?? m.fill, sw: 2 })
      break
    default:
      svg.circle(x, y, r, p)
  }
}

/** a line through `pts`, smoothed as Excel does (a Catmull-Rom curve) when asked */
function linePath(pts: Pt[], smooth: boolean): string {
  if (!smooth || pts.length < 3) return pathData(pts.map((p, k) => ({ c: k ? 'L' : 'M', p: [p] })))
  const cmds: { c: 'M' | 'C'; p: Pt[] }[] = [{ c: 'M', p: [pts[0]] }]
  for (let k = 0; k < pts.length - 1; k++) {
    const p0 = pts[Math.max(0, k - 1)]
    const p1 = pts[k]
    const p2 = pts[k + 1]
    const p3 = pts[Math.min(pts.length - 1, k + 2)]
    cmds.push({ c: 'C', p: [{ x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 }, { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }, p2] })
  }
  return pathData(cmds)
}

/** a group drawn as lines (its legend entries show a line and a marker) */
const lined = (g: ChartGroup) => (g.type === 'line' && !g.three) || g.type === 'scatter' || g.type === 'stock' || (g.type === 'radar' && g.radarStyle !== 'filled')

// ---------------------------------------------------------------- legend

interface LegendEntry {
  label: string
  fill?: string | null
  look?: FillLook
  line?: ChartSeries['line']
  marker?: ChartSeries['marker']
}

function legendEntries(m: ChartModel): LegendEntry[] {
  const g0 = m.groups[0]
  if (!g0) return []
  if (g0.type === 'surface') return surfaceBands(g0, m).map((b) => ({ label: b.label, fill: b.fill, look: b.look }))
  const deleted = new Set(m.legend?.deleted)
  const out: LegendEntry[] = []
  // a pie (or one series of varied colors): the points of its first series are the entries
  const pie = g0.type === 'pie' || g0.type === 'doughnut'
  if (m.groups.length === 1 && g0.varyColors && (pie || g0.series.length === 1)) {
    const s = g0.series[0]
    for (let k = 0; k < s.cats.length && out.length < MAX_LEGEND; k++)
      if (!deleted.has(k)) out.push({ label: s.cats[k], fill: s.points[k]?.color ?? s.fill, look: s.points[k]?.look ?? (s.points[k]?.color ? undefined : s.look) })
    return out
  }
  let k = 0
  for (const g of m.groups)
    for (const s of g.series) {
      if (deleted.has(k++) || out.length >= MAX_LEGEND) continue
      out.push(lined(g) ? { label: s.name, line: s.line, marker: s.marker } : { label: s.name, fill: s.fill, look: s.look })
    }
  return out
}

function drawLegend(svg: Svg, entries: LegendEntry[], box: Box, vertical: boolean, size: number, color: string, bold?: boolean) {
  const sw = size * 0.8
  const lh = lineHeight(size) + 2
  let x = box.x
  let y = box.y
  const rowW = box.w
  for (const e of entries) {
    const w = sw + 4 + textWidth(e.label, size, bold) + 12
    if (!vertical && x + w > box.x + rowW + 1 && x > box.x) {
      x = box.x
      y += lh
    }
    const cy = y + lh / 2
    if (e.line || e.marker) {
      if (e.line) svg.line(x, cy, x + sw * 1.6, cy, { stroke: e.line.color, sw: Math.min(3, e.line.width * PX), dash: dashOf(e.line.dash, e.line.width) })
      if (e.marker) marker(svg, x + sw * 0.8, cy, { ...e.marker, size: Math.min(e.marker.size, 7) })
      svg.text(x + sw * 1.6 + 4, cy, e.label, { size, color, bold })
      x += sw * 1.6 + 4 + textWidth(e.label, size, bold) + 12
    } else {
      svg.rect(x, cy - sw / 2, sw, sw, { fill: fillPaint(svg, e.fill, e.look) })
      svg.text(x + sw + 4, cy, e.label, { size, color, bold })
      x += w
    }
    if (vertical) {
      x = box.x
      y += lh
    }
  }
}

function legendSize(entries: LegendEntry[], vertical: boolean, size: number, maxW: number, bold?: boolean): { w: number; h: number } {
  const lh = lineHeight(size) + 2
  const widths = entries.map((e) => size * 0.8 * (e.line || e.marker ? 1.6 : 1) + 4 + textWidth(e.label, size, bold) + 12)
  if (vertical) return { w: Math.min(maxW, Math.max(0, highest(widths))), h: entries.length * lh }
  let rows = 1
  let x = 0
  for (const w of widths) {
    if (x + w > maxW && x > 0) (rows++, (x = 0))
    x += w
  }
  return { w: Math.min(maxW, widths.reduce((a, b) => a + b, 0)), h: rows * lh }
}

// ---------------------------------------------------------------- pie and doughnut

/** a pie (its first series) or a doughnut (a ring per series, the first innermost, as Excel draws them) */
function drawPie(svg: Svg, m: ChartModel, g: ChartGroup, box: Box) {
  const rings = g.type === 'doughnut' ? g.series : g.series.slice(0, 1)
  const s0 = rings[0]
  // slices are exploded only where there is one ring
  const exploded = rings.length === 1 ? Math.max(0, highest(Object.values(s0.points).map((p) => p.explosion ?? 0))) : 0
  const outside = !!s0.labels && (s0.labels.pos === 'outEnd' || s0.labels.pos === 'bestFit')
  const r = Math.max(4, (Math.min(box.w, box.h) / 2) * (outside ? 0.75 : 0.92) / (1 + exploded / 100))
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const hole = g.type === 'doughnut' ? Math.min(0.9, Math.max(0.1, g.holeSize / 100)) * r : 0
  const width = (r - hole) / rings.length
  rings.forEach((s, i) => drawRing(svg, m, g, s, { cx, cy, rin: hole + i * width, rout: hole + (i + 1) * width, outside: outside && i === rings.length - 1, explode: rings.length === 1 }))
}

function drawRing(svg: Svg, m: ChartModel, g: ChartGroup, s: ChartSeries, o: { cx: number; cy: number; rin: number; rout: number; outside: boolean; explode: boolean }) {
  const { cx, cy, rin, rout: r, outside } = o
  // a negative value is a slice of its magnitude, as in Excel; its label keeps the sign
  const vals = s.values.map((v) => (v ? Math.abs(v) : 0))
  const total = vals.reduce((a, b) => a + b, 0)
  if (!total) return
  let a = ((g.firstSliceAng - 90) * Math.PI) / 180
  const n = (x: number) => Math.round(x * 100) / 100
  vals.forEach((v, k) => {
    if (!v) return
    const sweep = (v / total) * Math.PI * 2
    const mid = a + sweep / 2
    const off = o.explode ? ((s.points[k]?.explosion ?? 0) / 100) * r : 0
    const ox = cx + off * Math.cos(mid)
    const oy = cy + off * Math.sin(mid)
    const pt = s.points[k]
    const fill = fillPaint(svg, pt?.color ?? s.fill ?? '#4472c4', pt?.look ?? (pt?.color ? undefined : s.look))
    const stroke = s.line?.color ?? '#ffffff'
    const sw = s.line ? Math.max(0.75, s.line.width * PX) : 1
    const at = (rr: number, ang: number): Pt => ({ x: ox + rr * Math.cos(ang), y: oy + rr * Math.sin(ang) })
    const large = sweep > Math.PI ? 1 : 0
    if (sweep >= Math.PI * 2 - 1e-6) {
      if (!rin) svg.circle(ox, oy, r, { fill, stroke, sw })
      // a whole ring: the outer circle one way round and the inner one the other way, so the inside stays open
      else
        svg.path(
          `M${n(ox + r)} ${n(oy)} A${n(r)} ${n(r)} 0 1 1 ${n(ox - r)} ${n(oy)} A${n(r)} ${n(r)} 0 1 1 ${n(ox + r)} ${n(oy)} Z M${n(ox + rin)} ${n(oy)} A${n(rin)} ${n(rin)} 0 1 0 ${n(ox - rin)} ${n(oy)} A${n(rin)} ${n(rin)} 0 1 0 ${n(ox + rin)} ${n(oy)} Z`,
          { fill, stroke, sw },
        )
    } else {
      const p1 = at(r, a)
      const p2 = at(r, a + sweep)
      const d = rin
        ? `M${n(p1.x)} ${n(p1.y)} A${n(r)} ${n(r)} 0 ${large} 1 ${n(p2.x)} ${n(p2.y)} L${n(at(rin, a + sweep).x)} ${n(at(rin, a + sweep).y)} A${n(rin)} ${n(rin)} 0 ${large} 0 ${n(at(rin, a).x)} ${n(at(rin, a).y)} Z`
        : `M${n(ox)} ${n(oy)} L${n(p1.x)} ${n(p1.y)} A${n(r)} ${n(r)} 0 ${large} 1 ${n(p2.x)} ${n(p2.y)} Z`
      svg.path(d, { fill, stroke, sw })
    }
    const l = labelShown(s, k) ? labelsAt(s, k) : undefined
    if (l) {
      const parts: string[] = []
      if (l.series) parts.push(s.name)
      if (l.category) parts.push(s.cats[k] ?? '')
      if (l.value) parts.push(fmt(s.values[k]!, l.format ?? s.format, m.date1904))
      if (l.percent) parts.push(fmt(v / total, l.format && l.format.includes('%') ? l.format : '0%', m.date1904))
      const out = outside || l.pos === 'outEnd'
      const lr = out ? r * 1.15 : l.pos === 'inEnd' ? r * 0.8 : rin ? (r + rin) / 2 : r * 0.65
      const p = at(lr, mid)
      const anchor = out ? (Math.cos(mid) >= 0 ? 'start' : 'end') : 'middle'
      const lk = textOf(m, l.text)
      const color = l.text?.color ?? (out ? m.textColor : '#ffffff')
      svg.text(p.x, p.y, parts.join(l.sep ?? (out ? '; ' : '\n')).split('\n'), { size: lk.size, color, bold: lk.bold, anchor })
    }
    a += sweep
  })
}

// ---------------------------------------------------------------- axes and plot

interface AxisPlan {
  axis: ChartAxis
  scale: Scale
  /** labels' formatted text */
  labels: string[]
}

export const isStacked = (g: ChartGroup) => g.grouping === 'stacked' || g.grouping === 'percentStacked'
const xValued = (g: ChartGroup) => g.type === 'scatter' || g.type === 'bubble'

/** the extent of a group's values on its value axis (sums when stacked, 0…1 when 100%) */
export function extent(g: ChartGroup, blanks: ChartModel['blanks'] = 'gap'): [number, number] {
  if (g.grouping === 'percentStacked') {
    const neg = g.series.some((s) => s.values.some((v) => v !== null && v < 0))
    return [neg ? -1 : 0, 1]
  }
  if (isStacked(g) && g.type !== 'line') {
    let lo = 0
    let hi = 0
    const n = Math.max(0, highest(g.series.map((s) => s.values.length)))
    for (let k = 0; k < n; k++) {
      let p = 0
      let q = 0
      for (const s of g.series) {
        const v = s.values[k] ?? 0
        if (v >= 0) p += v
        else q += v
      }
      hi = Math.max(hi, p)
      lo = Math.min(lo, q)
    }
    return [lo, hi]
  }
  // lines and scatter plot an empty cell as zero where the chart says so: the axis takes it in too
  const zero = blanks === 'zero' && (g.type === 'line' || g.type === 'scatter')
  const all = g.series.flatMap((s) => (isStacked(g) ? cumulative(g, s) : s.values)).map((v) => (v === null && zero ? 0 : v)).filter((v): v is number => v !== null)
  if (!all.length) return [0, 1]
  const lo = lowest(all)
  const hi = highest(all)
  return g.type === 'bubble' ? bubbleRoom(lo, hi) : [lo, hi]
}

/** bubbles reach past their centers: the axes leave them room, as Excel's do, without crossing zero for it */
function bubbleRoom(lo: number, hi: number): [number, number] {
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.15
  return [lo >= 0 ? Math.max(0, lo - pad) : lo - pad, hi <= 0 ? Math.min(0, hi + pad) : hi + pad]
}

/** a stacked line's points: each series on top of those before it */
export function cumulative(g: ChartGroup, s: ChartSeries): (number | null)[] {
  const i = g.series.indexOf(s)
  return s.values.map((v, k) => {
    if (v === null) return null
    let sum = 0
    for (let j = 0; j <= i; j++) sum += g.series[j].values[k] ?? 0
    if (g.grouping === 'percentStacked') {
      const tot = g.series.reduce((a, x) => a + Math.abs(x.values[k] ?? 0), 0)
      return tot ? sum / tot : 0
    }
    return sum
  })
}

/** The chart as an SVG picture of `W` × `H` px, of `max` characters at most (`PictureTooLarge` is thrown past them). */
export function renderChart(m: ChartModel, W: number, H: number, max = MAX_CHART_SVG): string {
  // a group without series draws nothing: a pie or radar of it would have no first series to draw
  m = { ...m, groups: m.groups.filter((g) => g.series.length) }
  let labelled = 0
  let marked = 0
  for (const g of m.groups)
    for (const s of g.series) {
      if (s.labels && shownByFlags(s.labels)) labelled += s.values.length
      if (s.marker) marked += s.values.length
    }
  labelStep = Math.max(1, Math.ceil(labelled / MAX_LABELS))
  markerStep = Math.max(1, Math.ceil(marked / MAX_MARKERS))
  const svg = new Svg(max)
  // the chart area: a plain color is the picture's canvas; a gradient or pattern a rect of its own
  if (m.bgLook && m.bg !== null) svg.rect(0, 0, W, H, { fill: fillPaint(svg, m.bg, m.bgLook) })
  if (m.border !== null) svg.rect(0.5, 0.5, W - 1, H - 1, { stroke: m.border ?? m.gridColor, sw: 1 })
  const size = m.fontSize * PX
  let top = PAD
  if (m.title) top += textBlock(svg, m.title, W / 2, PAD, W - PAD * 2) + 6
  let area: Box = { x: PAD, y: top, w: W - PAD * 2, h: H - top - PAD }

  // legend: its own strip beside the plot, unless it lies over it
  const entries = m.legend ? legendEntries(m) : []
  if (m.legend && entries.length) {
    const lt = textOf(m, m.legend.text)
    const pos = m.legend.pos
    const vertical = pos === 'r' || pos === 'l' || pos === 'tr'
    const ls = legendSize(entries, vertical, lt.size, vertical ? area.w * 0.4 : area.w, lt.bold)
    let lb: Box
    if (pos === 't') lb = { x: area.x + (area.w - ls.w) / 2, y: area.y, w: ls.w, h: ls.h }
    else if (pos === 'b') lb = { x: area.x + (area.w - ls.w) / 2, y: area.y + area.h - ls.h, w: ls.w, h: ls.h }
    else if (pos === 'l') lb = { x: area.x, y: area.y + (area.h - ls.h) / 2, w: ls.w, h: ls.h }
    else if (pos === 'tr') lb = { x: area.x + area.w - ls.w, y: area.y, w: ls.w, h: ls.h }
    else lb = { x: area.x + area.w - ls.w, y: area.y + (area.h - ls.h) / 2, w: ls.w, h: ls.h }
    drawLegend(svg, entries, lb, vertical, lt.size, lt.color, lt.bold)
    if (!m.legend.overlay) {
      if (pos === 't') area = { ...area, y: area.y + ls.h + 6, h: area.h - ls.h - 6 }
      else if (pos === 'b') area = { ...area, h: area.h - ls.h - 6 }
      else if (pos === 'l') area = { ...area, x: area.x + ls.w + 8, w: area.w - ls.w - 8 }
      else area = { ...area, w: area.w - ls.w - 8 }
    }
  }
  // the plot's place where the file fixes it
  let inner: Box | null = null
  if (m.plot) {
    const b = { x: m.plot.x * W, y: m.plot.y * H, w: m.plot.w * W, h: m.plot.h * H }
    if (m.plot.target === 'inner') inner = b
    else area = b
  }
  const bg = m.bgLook || m.bg === null ? '' : (m.bg ?? '#ffffff')

  const pie = m.groups.find((g) => g.type === 'pie' || g.type === 'doughnut')
  const radar = m.groups.find((g) => g.type === 'radar')
  const surface = m.groups.find((g) => g.type === 'surface')
  const g0 = m.groups[0]
  if (m.view3d && g0?.three) {
    if (g0.type === 'pie') drawPie3D(svg, m, g0, inner ?? area)
    else drawCartesian3D(svg, m, g0, area, inner)
  } else if (pie) drawPie(svg, m, pie, inner ?? area)
  else if (radar) drawRadar(svg, m, radar, inner ?? area, size)
  else if (surface) drawSurface(svg, m, surface, area, inner, size)
  else drawCartesian(svg, m, area, inner, size)
  return svg.toString(W, H, bg)
}

/** the plot area's own fill and border, under everything drawn in it */
function plotArea(svg: Svg, m: ChartModel, b: Box) {
  if (m.plotFill === null || m.plotFill === undefined) {
    if (m.plotBorder) svg.rect(b.x, b.y, b.w, b.h, { fill: 'none', ...linePaint(m.plotBorder) })
    return
  }
  svg.rect(b.x, b.y, b.w, b.h, { fill: fillPaint(svg, m.plotFill, m.plotLook), ...(m.plotBorder ? linePaint(m.plotBorder) : {}) })
}

/** a value axis' gridline paint, or null where it has none */
export function gridPaint(m: ChartModel, a: ChartAxis): Paint | null {
  if (!a.gridlines || a.grid === null) return null
  return a.grid ? linePaint(a.grid) : { stroke: m.gridColor }
}

function drawCartesian(svg: Svg, m: ChartModel, area: Box, fixed: Box | null, size: number) {
  const axis = (id: string) => m.axes.find((a) => a.id === id)
  const groups = m.groups.filter((g) => g.series.length)
  const horizontal = groups.some((g) => g.type === 'bar' && g.dir === 'bar')
  // value axes and the groups on them
  const valIds = [...new Set(groups.map((g) => g.axIds[1]).filter(Boolean))]
  const plans = new Map<string, AxisPlan>()
  // the category axis drawn: the first one shown (a combination's groups each have their own), else the first
  const catGroups = groups.filter((g) => !xValued(g))
  const catAxis = catGroups.map((g) => axis(g.axIds[0])).find((a) => a && !a.deleted) ?? axis(catGroups[0]?.axIds[0] ?? '')
  const cats = catLabels(catGroups[0]?.series[0], catAxis, m.date1904)
  const n = Math.max(1, highest(groups.filter((g) => !xValued(g)).flatMap((g) => g.series.map((s) => s.values.length))))
  const valLen = horizontal ? area.w : area.h
  for (const id of valIds) {
    const a = axis(id)
    const on = groups.filter((g) => g.axIds[1] === id)
    const ext = on.map((g) => extent(g, m.blanks))
    const lo = lowest(ext.map((e) => e[0]))
    const hi = highest(ext.map((e) => e[1]))
    const pct = on.some((g) => g.grouping === 'percentStacked')
    // an axis of 100% stacks alone ends at 100% (and -100%), with no headroom above
    const whole = on.every((g) => g.grouping === 'percentStacked')
    const scale = a?.logBase
      ? logFor(on.flatMap((g) => g.series.flatMap((s) => s.values)), a.logBase, a)
      : niceScale(lo, hi, { min: a?.min ?? (whole ? lo : undefined), max: a?.max ?? (whole ? hi : undefined), major: a?.major, ticks: intervals(valLen, textOf(m, a?.text).size, horizontal) })
    const f = a?.format ?? (pct ? '0%' : on[0]?.series.find((s) => s.format)?.format)
    plans.set(id, { axis: a ?? fallbackAxis(id, horizontal ? 'b' : 'l'), scale: { ...scale, format: f }, labels: scale.ticks.map((t) => fmt(t, f, m.date1904)) })
  }
  // scatter and bubbles: their x axis is a value axis too, a scale per axis (a secondary group can have its own)
  const scatter = groups.find(xValued)
  const xPlans = new Map<string, AxisPlan>()
  for (const g of groups.filter(xValued)) {
    const id = g.axIds[0]
    if (xPlans.has(id)) continue
    const on = groups.filter((x) => xValued(x) && x.axIds[0] === id)
    const a = axis(id)
    // a series without X values is numbered 1, 2, 3, ...
    const xs = on.flatMap((x) => x.series.flatMap((s) => s.xs ?? s.values.map((_, k) => k + 1))).filter((v): v is number => v !== null)
    let sc: Scale
    if (a?.logBase) sc = logFor(xs, a.logBase, a)
    else {
      const [lo, hi] = on.some((x) => x.type === 'bubble') ? bubbleRoom(lowest(xs), highest(xs)) : [lowest(xs), highest(xs)]
      sc = niceScale(lo, hi, { min: a?.min, max: a?.max, major: a?.major, ticks: intervals(area.w, textOf(m, a?.text).size, true) })
    }
    // linked to its source: the format of the X values, never the Y values'
    const f = a?.format ?? on.flatMap((x) => x.series).find((s) => s.xFormat)?.xFormat
    xPlans.set(id, { axis: a ?? fallbackAxis(id, 'b'), scale: { ...sc, format: f }, labels: sc.ticks.map((t) => fmt(t, f, m.date1904)) })
  }
  // the first group's X axis is the one drawn
  const xPlan = scatter ? (xPlans.get(scatter.axIds[0]) ?? null) : null
  const showCats = !!cats.length && !scatter && !(catAxis?.deleted ?? false) && (catAxis?.labels ?? true)
  const primary = valIds.find((id) => !['r', 't'].includes(plans.get(id)!.axis.pos)) ?? valIds[0]
  const secondary = valIds.find((id) => id !== primary)

  // each axis' labels in their own size and color
  const look = (a: ChartAxis | undefined) => textOf(m, a?.text)
  const catT = look(catAxis)
  const catLh = lineHeight(catT.size)

  // room for labels and axis titles
  const shows = (p: AxisPlan | undefined) => !!p && !p.axis.deleted && p.axis.labels
  const valW = (p: AxisPlan | undefined) => (shows(p) ? highest(p!.labels.map((l) => textWidth(l, look(p!.axis).size, look(p!.axis).bold))) + 6 : 0)
  const catW = showCats ? Math.min(area.w * 0.35, highest(cats.map((c) => textWidth(c, catT.size, catT.bold)))) + 6 : 0
  const titleH = (a: ChartAxis | undefined) => (a?.title && !a.deleted ? lineHeight(a.title.size * PX) + 4 : 0)
  // category labels at the angle the file gives; else flat where they fit, wrapped at their spaces where that makes
  // them fit, and tilted by 45° where neither does, as Excel does
  const catTextW = showCats ? highest(cats.map((c) => textWidth(c, catT.size, catT.bold))) : 0
  const room = (area.w * 0.85) / n
  let angle = 0
  let wrapped: string[][] | null = null
  if (showCats && !horizontal) {
    if (catAxis?.rot !== undefined) angle = catAxis.rot
    else if (catTextW + 2 > room) {
      const ws = cats.map((c) => wrap([c], Math.max(8, room - 2), catT.size, catT.bold))
      const widest = highest(ws.flatMap((l) => l.map((x) => textWidth(x, catT.size, catT.bold))))
      if (widest + 2 <= room && highest(ws.map((l) => l.length)) * catLh <= area.h * 0.4) wrapped = ws
      else angle = -45
    }
  }
  const rad = (Math.abs(angle) * Math.PI) / 180
  const catBottom = angle
    ? Math.min(area.h * 0.4, catTextW * Math.sin(rad) + catLh * Math.cos(rad)) + 4
    : wrapped
      ? highest(wrapped.map((l) => l.length)) * catLh + 4
      : catLh + 4
  let inner: Box
  if (fixed) inner = fixed
  else {
    const pp = plans.get(primary)
    const sp = secondary ? plans.get(secondary) : undefined
    let left = 0
    let right = 0
    let bottom = 0
    const topPad = lineHeight(size) / 2
    if (horizontal) {
      left = catW + titleH(catAxis)
      bottom = (shows(pp) ? lineHeight(look(pp!.axis).size) + 4 : 0) + titleH(pp?.axis)
      if (sp && shows(sp)) right = 0
    } else {
      left = valW(pp) + titleH(pp?.axis)
      right = sp ? valW(sp) + titleH(sp.axis) : textWidth(cats.at(-1) ?? '', catT.size) / 3
      bottom = (showCats ? catBottom : xPlan ? lineHeight(look(xPlan.axis).size) + 4 : 0) + titleH(xPlan?.axis ?? catAxis)
    }
    inner = { x: area.x + left, y: area.y + topPad, w: Math.max(10, area.w - left - right - 4), h: Math.max(10, area.h - topPad - bottom) }
  }
  plotArea(svg, m, inner)

  // positions: value v of plan p, category k (its band's middle)
  const valPos = (p: AxisPlan, v: number) => {
    let f = frac(p.scale, v)
    if (p.axis.reverse) f = 1 - f
    return horizontal ? inner.x + f * inner.w : inner.y + inner.h - f * inner.h
  }
  const catReverse = catAxis?.reverse ?? false
  const catLen = horizontal ? inner.h : inner.w
  // a date axis places each point at its date, a band to its base unit (a day, a month or a year): days a week
  // apart are seven bands apart, the firsts of months a band
  const dates = catAxis?.kind === 'date' ? groups.find((g) => !xValued(g))?.series[0]?.catValues : undefined
  const known = dates?.filter((v): v is number => v !== null) ?? []
  const unit = catAxis?.baseUnit ?? (known.length ? baseUnitOf(known, m.date1904) : 'days')
  const unitOf = (d: number) => {
    if (unit === 'days') return Math.floor(d)
    const t = serialToDate(d, m.date1904)
    return unit === 'years' ? t.getUTCFullYear() : t.getUTCFullYear() * 12 + t.getUTCMonth()
  }
  const d0 = catAxis?.min ?? (known.length ? lowest(known) : 0)
  const d1 = catAxis?.max ?? (known.length ? highest(known) : 0)
  const byDate = known.length > 0 && d1 >= d0 && Number.isFinite(d0) && Number.isFinite(d1)
  const u0 = byDate ? unitOf(d0) : 0
  const units = byDate ? Math.max(1, Math.min(100_000, unitOf(d1) - u0 + 1)) : n
  const band = catLen / units
  const catMid = (k: number) => {
    const d = byDate ? dates![k] : null
    let i = d !== null && d !== undefined ? unitOf(d) - u0 : k
    // horizontal bars run from the bottom up, as Excel draws them
    if (horizontal !== catReverse) i = units - 1 - i
    return (horizontal ? inner.y : inner.x) + (i + 0.5) * band
  }
  const xPosOf = (pl: AxisPlan) => (v: number) => inner.x + (pl.axis.reverse ? 1 - frac(pl.scale, v) : frac(pl.scale, v)) * inner.w
  const xPos = xPlan ? xPosOf(xPlan) : () => inner.x

  // gridlines and value labels
  for (const id of valIds) {
    const p = plans.get(id)!
    const right = id !== primary
    const t = look(p.axis)
    const grid = gridPaint(m, p.axis)
    for (let k = 0; k < p.scale.ticks.length; k++) {
      const pos = valPos(p, p.scale.ticks[k])
      if (grid) horizontal ? svg.line(pos, inner.y, pos, inner.y + inner.h, grid) : svg.line(inner.x, pos, inner.x + inner.w, pos, grid)
      if (!shows(p)) continue
      if (horizontal) svg.text(pos, inner.y + inner.h + 4 + lineHeight(t.size) / 2, p.labels[k], { size: t.size, color: t.color, bold: t.bold, anchor: 'middle' })
      else svg.text(right ? inner.x + inner.w + 4 : inner.x - 4, pos, p.labels[k], { size: t.size, color: t.color, bold: t.bold, anchor: right ? 'start' : 'end' })
    }
    // a value axis' line only where the file draws one
    if (p.axis.line && !p.axis.deleted) {
      const lp = linePaint(p.axis.line)
      if (horizontal) svg.line(inner.x, inner.y + inner.h, inner.x + inner.w, inner.y + inner.h, lp)
      else if (right) svg.line(inner.x + inner.w, inner.y, inner.x + inner.w, inner.y + inner.h, lp)
      else svg.line(inner.x, inner.y, inner.x, inner.y + inner.h, lp)
    }
  }
  if (xPlan) {
    const t = look(xPlan.axis)
    const grid = gridPaint(m, xPlan.axis)
    for (let k = 0; k < xPlan.scale.ticks.length; k++) {
      const x = xPos(xPlan.scale.ticks[k])
      if (grid) svg.line(x, inner.y, x, inner.y + inner.h, grid)
      if (shows(xPlan)) svg.text(x, inner.y + inner.h + 4 + lineHeight(t.size) / 2, xPlan.labels[k], { size: t.size, color: t.color, bold: t.bold, anchor: 'middle' })
    }
  }
  // category labels: flat, wrapped or turned, and every k-th where they overlap even so
  if (showCats) {
    // wrapped labels were made to fit their categories: all of them are shown
    const space = horizontal ? catLh : angle ? catLh / Math.max(0.2, Math.sin(rad)) : wrapped ? 0 : catTextW + 2
    // (a band is a fraction of a pixel where a series has more points than the plot is wide)
    const every = Math.max(1, Math.ceil(space / Math.max(1e-6, band))) || 1
    const y0 = inner.y + inner.h + 4
    const o = { size: catT.size, color: catT.color, bold: catT.bold }
    cats.forEach((c, k) => {
      if (k % every) return
      if (horizontal) svg.text(inner.x - 4, catMid(k), c, { ...o, anchor: 'end' })
      else if (angle) {
        // turned about its end next to the axis: a label turned back (counterclockwise) ends there, one turned
        // forward starts there
        const x = catMid(k)
        const y = y0 + (catLh / 2) * Math.cos(rad)
        svg.raw(`<g transform="rotate(${Math.round(angle * 100) / 100} ${Math.round(x)} ${Math.round(y)})">`).text(x, y, c, { ...o, anchor: angle < 0 ? 'end' : 'start' }).raw('</g>')
      } else if (wrapped) svg.text(catMid(k), y0 + (wrapped[k].length * catLh) / 2, wrapped[k], { ...o, anchor: 'middle' })
      else svg.text(catMid(k), y0 + catLh / 2, c, { ...o, anchor: 'middle' })
    })
  }
  // the category axis line, where it crosses the value axis: zero (or the bound nearest it), or where the file says
  const pp = plans.get(primary)
  const crossOf = (p: AxisPlan) => (p === pp ? crossing(p.scale, catAxis) : baseline(p.scale))
  const catLine = catAxis?.line === null ? null : catAxis?.line ? linePaint(catAxis.line) : { stroke: m.axisColor }
  if (pp && catLine && !(catAxis?.deleted ?? false)) {
    const pos = valPos(pp, crossOf(pp))
    horizontal ? svg.line(pos, inner.y, pos, inner.y + inner.h, catLine) : svg.line(inner.x, pos, inner.x + inner.w, pos, catLine)
  }
  // axis titles
  const axisTitle = (a: ChartAxis | undefined, where: 'left' | 'right' | 'bottom') => {
    if (!a?.title || a.deleted) return
    const s = a.title.size * PX
    const o = { size: s, bold: a.title.bold, color: a.title.color ?? m.textColor, anchor: 'middle' as const }
    if (where === 'bottom') svg.text(inner.x + inner.w / 2, area.y + area.h - lineHeight(s) / 2, a.title.text, o)
    else {
      const x = where === 'left' ? area.x + lineHeight(s) / 2 : area.x + area.w - lineHeight(s) / 2
      const y = inner.y + inner.h / 2
      svg.raw(`<g transform="rotate(-90 ${Math.round(x)} ${Math.round(y)})">`).text(x, y, a.title.text, o).raw('</g>')
    }
  }
  if (horizontal) {
    axisTitle(catAxis, 'left')
    axisTitle(pp?.axis, 'bottom')
  } else {
    axisTitle(pp?.axis, 'left')
    if (secondary) axisTitle(plans.get(secondary)?.axis, 'right')
    axisTitle(xPlan?.axis ?? catAxis, 'bottom')
  }

  // the series: areas first, then bars, then lines and points on top
  const order = (g: ChartGroup) => (g.type === 'area' ? 0 : g.type === 'bar' ? 1 : g.type === 'bubble' ? 2 : 3)
  // values outside a fixed axis range stop at the plot area; the margin keeps markers on its edge whole
  const c = CLIP_MARGIN
  svg.raw(`<defs><clipPath id="de-plot"><rect x="${Math.round(inner.x - c)}" y="${Math.round(inner.y - c)}" width="${Math.round(inner.w + 2 * c)}" height="${Math.round(inner.h + 2 * c)}"/></clipPath></defs><g clip-path="url(#de-plot)">`)
  // data labels go on a layer after the clipped series: a label beside a point on the plot's edge stays whole
  const labels = new Svg(svg.max)
  labelLayers.set(svg, labels)
  for (const g of [...groups].sort((a, b) => order(a) - order(b))) {
    const p = plans.get(g.axIds[1]) ?? plans.get(primary)
    if (!p) continue
    if (g.type === 'bar') drawBars(svg, m, g, p, { valPos, catMid, band, horizontal, flip: horizontal !== catReverse, size, base: crossOf(p) })
    else if (g.type === 'area') drawArea(svg, g, p, { valPos, catMid, base: crossOf(p) })
    else if (g.type === 'line') drawLines(svg, m, g, p, { valPos, catMid, size })
    else if (g.type === 'stock') drawStock(svg, m, g, p, { valPos, catMid, band, size })
    else if (xValued(g) && xPlans.has(g.axIds[0])) {
      const xp = xPlans.get(g.axIds[0])!
      if (g.type === 'scatter') drawScatter(svg, m, g, p, { valPos, xPos: xPosOf(xp), xLog: !!xp.scale.log, size })
      else drawBubbles(svg, m, g, p, { valPos, xPos: xPosOf(xp), xLog: !!xp.scale.log, size, plot: inner })
    }
  }
  svg.raw('</g>')
  labelLayers.delete(svg)
  svg.raw(labels.body())
}

const CLIP_MARGIN = 6

/** the base unit Excel picks for dates left to it: years where they all fall on one day of the year, months where they
 *  all fall on one day of the month, else days */
function baseUnitOf(dates: number[], date1904: boolean): 'days' | 'months' | 'years' {
  const ds = dates.slice(0, 1000).map((d) => serialToDate(d, date1904))
  if (ds.some((d) => !Number.isFinite(d.getTime()))) return 'days'
  const day = ds[0].getUTCDate()
  if (ds.length < 2 || ds.some((d) => d.getUTCDate() !== day)) return 'days'
  return ds.every((d) => d.getUTCMonth() === ds[0].getUTCMonth()) ? 'years' : 'months'
}

/** while a chart's series are drawn, the layer their data labels go on (unclipped, above them) */
const labelLayers = new WeakMap<Svg, Svg>()

/** a series' categories as an axis labels them: in the axis' own number format where it has one, else as their cells show them */
export function catLabels(s: ChartSeries | undefined, a: ChartAxis | undefined, date1904: boolean): string[] {
  if (!s) return []
  const f = a?.format
  if (!f || !s.catValues) return s.cats
  return s.cats.map((c, k) => (s.catValues![k] !== null && s.catValues![k] !== undefined ? fmt(s.catValues![k]!, f, date1904) : c))
}

/** where the category axis crosses the value axis: as the file says (`crosses`, `crossesAt`), else zero or the bound nearest it */
function crossing(s: Scale, cat: ChartAxis | undefined): number {
  if (cat?.crossesAt !== undefined && (!s.log || cat.crossesAt > 0)) return Math.min(Math.max(cat.crossesAt, s.min), s.max)
  if (cat?.crosses === 'max') return s.max
  if (cat?.crosses === 'min') return s.min
  return baseline(s)
}

function fallbackAxis(id: string, pos: string): ChartAxis {
  return { id, kind: 'val', pos, deleted: false, reverse: false, gridlines: true, labels: true, crossAx: '', crosses: 'autoZero' }
}

interface Geo {
  valPos: (p: AxisPlan, v: number) => number
  catMid: (k: number) => number
}

function label(svg: Svg, m: ChartModel, s: ChartSeries, k: number, v: number, x: number, y: number, anchor: 'start' | 'middle' | 'end' = 'middle', color?: string) {
  const l = labelShown(s, k) ? labelsAt(s, k) : undefined
  if (!l) return
  const parts: string[] = []
  if (l.series) parts.push(s.name)
  if (l.category) parts.push(s.cats[k] ?? '')
  if (l.value) parts.push(fmt(v, l.format ?? s.format, m.date1904))
  const t = textOf(m, l.text)
  if (parts.length) (labelLayers.get(svg) ?? svg).text(x, y, parts.join(l.sep ?? ', '), { size: t.size, color: l.text?.color ?? color ?? m.textColor, bold: t.bold, anchor })
}

/** where bars and areas start: zero, or the axis bound nearest to it when the axis does not reach zero (a log axis: its minimum) */
function baseline(s: Scale): number {
  if (s.log) return s.min
  return Math.min(Math.max(0, s.min), s.max)
}

function drawBars(svg: Svg, m: ChartModel, g: ChartGroup, p: AxisPlan, geo: Geo & { band: number; horizontal: boolean; flip: boolean; size: number; base: number }) {
  const { valPos, catMid, band, horizontal } = geo
  const stacked = isStacked(g)
  const n = stacked ? 1 : g.series.length
  const ov = Math.max(-1, Math.min(1, g.overlap / 100))
  const w = band / (n - (n - 1) * ov + g.gapWidth / 100)
  const total = n * w - (n - 1) * w * ov
  // bars grow from where the category axis crosses
  const base = geo.base
  const len = highest(g.series.map((s) => s.values.length))
  // one gradient or pattern per series (and per point with its own), shared by its bars
  const paints = g.series.map((s) => fillPaint(svg, s.fill, s.look))
  for (let k = 0; k < len; k++) {
    let posSum = 0
    let negSum = 0
    const tot = g.grouping === 'percentStacked' ? g.series.reduce((a, s) => a + Math.abs(s.values[k] ?? 0), 0) || 1 : 1
    g.series.forEach((s, i) => {
      const raw = s.values[k]
      if (raw === null || raw === undefined || !placeable(p.scale, raw)) return
      const v = raw / tot
      let from = base
      let to = v
      if (stacked) {
        from = v >= 0 ? posSum : negSum
        to = from + v
        if (v >= 0) posSum = to
        else negSum = to
      }
      const off = stacked ? 0 : i * w * (1 - ov)
      // the series of a cluster follow the category axis' direction: the first one nearest its start (a horizontal
      // bar chart's bottom)
      const c0 = geo.flip ? catMid(k) + total / 2 - off - w : catMid(k) - total / 2 + off
      const a = valPos(p, from)
      const b = valPos(p, to)
      const pt = s.points[k]
      const fill = raw < 0 && s.invertIfNegative ? '#ffffff' : pt?.look || pt?.color ? fillPaint(svg, pt.color ?? s.fill, pt.look) : paints[i]
      const paint: Paint = { fill, stroke: s.line?.color ?? (raw < 0 && s.invertIfNegative ? (s.fill ?? undefined) : undefined), sw: s.line ? Math.max(0.75, s.line.width * PX) : 1, dash: s.line ? dashOf(s.line.dash, s.line.width) : undefined }
      if (horizontal) svg.rect(Math.min(a, b), c0, Math.abs(b - a), w, paint)
      else svg.rect(c0, Math.min(a, b), w, Math.abs(b - a), paint)
      const l = labelShown(s, k) ? labelsAt(s, k) : undefined
      if (l) {
        // a clustered bar's label sits past its end unless the file places it; a stacked one's in its middle
        const pos = l.pos ?? (stacked ? 'ctr' : 'outEnd')
        const t = textOf(m, l.text)
        const inside = pos !== 'outEnd'
        // along the bar: a and b are its base and end; dir points from the base to the end
        const dir = Math.sign(b - a) || (horizontal ? 1 : -1)
        const pad = 4
        const half = horizontal ? textWidth(fmt(raw, l.format ?? s.format, m.date1904), t.size, t.bold) / 2 : lineHeight(t.size) / 2
        const at = pos === 'outEnd' ? b + dir * (pad + half) : pos === 'inEnd' ? b - dir * (pad + half) : pos === 'inBase' ? a + dir * (pad + half) : (a + b) / 2
        const color = inside ? '#ffffff' : undefined
        if (horizontal) label(svg, m, s, k, raw, at, c0 + w / 2, 'middle', color)
        else label(svg, m, s, k, raw, c0 + w / 2, at, 'middle', color)
      }
    })
  }
}

function drawArea(svg: Svg, g: ChartGroup, p: AxisPlan, geo: Geo & { base: number }) {
  const { valPos, catMid, base } = geo
  let below: number[] | null = null
  for (const s of g.series) {
    const vals = isStacked(g) ? cumulative(g, s).map((v) => v ?? 0) : s.values.map((v) => v ?? 0)
    const top = vals.map((v, k) => [catMid(k), valPos(p, v)] as [number, number])
    const floor = (below && isStacked(g) ? below.map((v, k) => [catMid(k), valPos(p, v)] as [number, number]) : vals.map((_, k) => [catMid(k), valPos(p, base)] as [number, number])).reverse()
    svg.poly([...top, ...floor], { fill: fillPaint(svg, s.fill, s.look), ...(s.line ? linePaint(s.line) : {}) })
    below = vals
  }
}

function drawLines(svg: Svg, m: ChartModel, g: ChartGroup, p: AxisPlan, geo: Geo & { size: number }) {
  const { valPos, catMid } = geo
  for (const s of g.series) {
    // an empty cell is a gap in the line, zero, or spanned, as the chart says; a value a log axis cannot place is a gap
    const vals = (isStacked(g) ? cumulative(g, s) : s.values).map((v) => (v === null ? (m.blanks === 'zero' && placeable(p.scale, 0) ? 0 : null) : placeable(p.scale, v) ? v : null))
    const runs: Pt[][] = [[]]
    vals.forEach((v, k) => {
      if (v === null) {
        if (m.blanks !== 'span' || s.values[k] !== null) runs.push([])
      } else runs[runs.length - 1].push({ x: catMid(k), y: valPos(p, v) })
    })
    if (s.line) for (const run of runs) if (run.length > 1) svg.path(linePath(run, s.smooth), linePaint(s.line))
    const lh = lineHeight(textOf(m, s.labels?.text).size)
    vals.forEach((v, k) => {
      if (v === null) return
      const x = catMid(k)
      const y = valPos(p, v)
      if (s.marker && markerShown(k)) marker(svg, x, y, s.marker)
      if (s.labels) label(svg, m, s, k, s.values[k] ?? v, x, y - lh * 0.8)
    })
  }
}

/** a stock chart: each category's high-low line, its up-down bar from the first series to the last, then the series */
function drawStock(svg: Svg, m: ChartModel, g: ChartGroup, p: AxisPlan, geo: Geo & { band: number; size: number }) {
  const { valPos, catMid, band } = geo
  const n = Math.max(0, highest(g.series.map((s) => s.values.length)))
  for (let k = 0; k < n; k++) {
    const vs = g.series.map((s) => s.values[k]).filter((v): v is number => v !== null && v !== undefined)
    if (!vs.length) continue
    const x = catMid(k)
    if (g.hiLow) svg.line(x, valPos(p, highest(vs)), x, valPos(p, lowest(vs)), linePaint(g.hiLow))
    const open = g.series[0]?.values[k]
    const close = g.series.at(-1)?.values[k]
    if (g.upDown && g.series.length > 1 && open !== null && open !== undefined && close !== null && close !== undefined) {
      const bar = close >= open ? g.upDown.up : g.upDown.down
      const w = band / (1 + g.upDown.gapWidth / 100)
      const a = valPos(p, open)
      const b = valPos(p, close)
      svg.rect(x - w / 2, Math.min(a, b), w, Math.max(1, Math.abs(b - a)), { fill: fillPaint(svg, bar.fill, bar.look), ...(bar.line ? linePaint(bar.line) : {}) })
    }
  }
  drawLines(svg, m, g, p, geo)
}

function drawScatter(svg: Svg, m: ChartModel, g: ChartGroup, p: AxisPlan, geo: { valPos: Geo['valPos']; xPos: (v: number) => number; xLog: boolean; size: number }) {
  const { valPos, xPos, xLog } = geo
  const lines = g.scatterStyle !== 'marker' && g.scatterStyle !== 'none'
  for (const s of g.series) {
    const pts: (Pt & { k: number })[] = []
    // the line's runs: an empty Y cell breaks it unless the chart spans blanks (or shows them as zero)
    const runs: Pt[][] = [[]]
    s.values.forEach((y, k) => {
      // without X values the points are numbered; with them, a point missing its X is not drawn
      const xv = s.xs ? s.xs[k] : k + 1
      const v = y === null && m.blanks === 'zero' ? 0 : y
      if (v === null || xv === null || xv === undefined) {
        if (v === null && m.blanks === 'gap') runs.push([])
        return
      }
      // a log axis has no place for zero or less
      if (!placeable(p.scale, v) || (xLog && xv <= 0)) return
      const pt = { x: xPos(xv), y: valPos(p, v), k }
      pts.push(pt)
      runs[runs.length - 1].push(pt)
    })
    const smooth = s.smooth || g.scatterStyle === 'smooth' || g.scatterStyle === 'smoothMarker'
    if (lines && s.line) for (const run of runs) if (run.length > 1) svg.path(linePath(run, smooth), linePaint(s.line))
    const lh = lineHeight(textOf(m, s.labels?.text).size)
    pts.forEach((pt) => {
      if (s.marker && markerShown(pt.k)) marker(svg, pt.x, pt.y, s.marker)
      if (s.labels) label(svg, m, s, pt.k, s.values[pt.k] ?? 0, pt.x, pt.y - lh * 0.8)
    })
  }
}

/**
 * Bubbles: the largest of the chart a quarter of the plot's smaller side across at a scale of 100 %, the others by area
 * (or width) in proportion; larger ones drawn first so smaller ones stay in view. A negative size is drawn as an
 * outline where the chart shows negative bubbles, else not at all.
 */
function drawBubbles(svg: Svg, m: ChartModel, g: ChartGroup, p: AxisPlan, geo: { valPos: Geo['valPos']; xPos: (v: number) => number; xLog: boolean; size: number; plot: Box }) {
  const { valPos, xPos, xLog, plot } = geo
  const biggest = Math.max(0, highest(g.series.flatMap((s) => (s.sizes ?? []).map((z) => Math.abs(z ?? 0)))))
  if (!biggest) return
  const maxR = ((Math.min(plot.w, plot.h) / 4) * ((g.bubbleScale ?? 100) / 100)) / 2
  const radius = (z: number) => (g.sizeRepresents === 'w' ? (maxR * Math.abs(z)) / biggest : maxR * Math.sqrt(Math.abs(z) / biggest))
  for (const s of g.series) {
    const paint = fillPaint(svg, s.fill, s.look)
    const pts: { x: number; y: number; r: number; k: number; neg: boolean }[] = []
    s.values.forEach((v, k) => {
      const xv = s.xs ? s.xs[k] : k + 1
      const z = s.sizes?.[k]
      if (v === null || xv === null || xv === undefined || z === null || z === undefined || z === 0) return
      if (z < 0 && !g.showNegBubbles) return
      if (!placeable(p.scale, v) || (xLog && xv <= 0)) return
      pts.push({ x: xPos(xv), y: valPos(p, v), r: Math.max(1, radius(z)), k, neg: z < 0 })
    })
    pts.sort((a, b) => b.r - a.r)
    const lh = lineHeight(textOf(m, s.labels?.text).size)
    for (const pt of pts) {
      const own = s.points[pt.k]
      const fill = pt.neg ? 'none' : own?.color || own?.look ? fillPaint(svg, own.color ?? s.fill, own.look) : paint
      svg.circle(pt.x, pt.y, pt.r, { fill, stroke: pt.neg ? (s.fill ?? m.textColor) : s.line?.color, sw: s.line ? Math.max(0.75, s.line.width * PX) : 1 })
      if (s.labels) label(svg, m, s, pt.k, s.values[pt.k]!, pt.x, pt.y - (s.labels.pos === 'ctr' ? 0 : pt.r + lh / 2))
    }
  }
}

// ---------------------------------------------------------------- radar

/** a radar: a spoke per category from 12 o'clock clockwise, the value axis along the spokes and rings at its ticks */
function drawRadar(svg: Svg, m: ChartModel, g: ChartGroup, box: Box, size: number) {
  const a = m.axes.find((x) => x.id === g.axIds[1])
  const catAxis = m.axes.find((x) => x.id === g.axIds[0])
  const cats = g.series[0]?.cats ?? []
  const n = Math.max(3, highest(g.series.map((s) => s.values.length)))
  const catT = textOf(m, catAxis?.text)
  const valT = textOf(m, a?.text)
  const showCats = !(catAxis?.deleted ?? false) && (catAxis?.labels ?? true)
  const labelW = showCats ? Math.max(0, highest(cats.map((c) => textWidth(c, catT.size, catT.bold)))) : 0
  const R = Math.max(10, Math.min(box.w / 2 - labelW - 8, box.h / 2 - lineHeight(catT.size) - 6))
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const all = g.series.flatMap((s) => s.values).filter((v): v is number => v !== null)
  const scale = niceScale(all.length ? lowest(all) : 0, all.length ? highest(all) : 1, { min: a?.min, max: a?.max, major: a?.major, ticks: Math.max(2, Math.round(R / 30)) })
  const f = a?.format ?? g.series.find((s) => s.format)?.format
  const ang = (k: number) => -Math.PI / 2 + (2 * Math.PI * k) / n
  const at = (k: number, v: number): [number, number] => {
    const r = Math.max(0, Math.min(1, frac(scale, v))) * R
    return [cx + r * Math.cos(ang(k)), cy + r * Math.sin(ang(k))]
  }
  // a ring has a corner per point: past `RADAR_CORNERS` it is drawn as the circle it looks like, and the spokes (one per
  // point, a solid disk of them) are left out, so the rings of a series of 100 000 points are not 100 000 corners each
  const round = n > RADAR_CORNERS
  const ring = (v: number, p: Paint) => (round ? svg.circle(cx, cy, Math.max(0, Math.min(1, frac(scale, v))) * R, p) : svg.poly(Array.from({ length: n }, (_, k) => at(k, v)), p))
  if (m.plotFill) ring(scale.max, { fill: fillPaint(svg, m.plotFill, m.plotLook) })
  const grid = a ? gridPaint(m, a) : { stroke: m.gridColor }
  if (grid) for (const t of scale.ticks) if (t !== scale.min) ring(t, { ...grid, fill: 'none' })
  const spoke = catAxis?.line === null ? null : catAxis?.line ? linePaint(catAxis.line) : { stroke: m.axisColor }
  if (spoke && !round) for (let k = 0; k < n; k++) svg.line(cx, cy, ...at(k, scale.max), spoke)
  // (as many labels as corners at most: every k-th of more)
  const every = Math.ceil(n / RADAR_CORNERS)
  if (showCats)
    cats.forEach((c, k) => {
      if (k % every) return
      const x = cx + (R + 6) * Math.cos(ang(k))
      const y = cy + (R + 6) * Math.sin(ang(k))
      const cos = Math.cos(ang(k))
      svg.text(x, y + Math.sin(ang(k)) * lineHeight(catT.size) * 0.4, c, { size: catT.size, color: catT.color, bold: catT.bold, anchor: Math.abs(cos) < 0.2 ? 'middle' : cos > 0 ? 'start' : 'end' })
    })
  if (!(a?.deleted ?? false) && (a?.labels ?? true))
    for (const t of scale.ticks) svg.text(cx - 4, at(0, t)[1], fmt(t, f, m.date1904), { size: valT.size, color: valT.color, bold: valT.bold, anchor: 'end' })
  const filled = g.radarStyle === 'filled'
  for (const s of g.series) {
    const pts = s.values.map((v, k) => (v === null ? null : { ...ptOf(at(k, v)), k })).filter((p): p is Pt & { k: number } => p !== null)
    if (pts.length < 2) continue
    const poly = pts.map((p) => [p.x, p.y] as [number, number])
    if (filled) svg.poly(poly, { fill: fillPaint(svg, s.fill, s.look), ...(s.line ? linePaint(s.line) : {}) })
    else if (s.line) svg.poly(poly, { fill: 'none', ...linePaint(s.line) })
    const lh = lineHeight(textOf(m, s.labels?.text).size)
    for (const p of pts) {
      if (s.marker && !filled && markerShown(p.k)) marker(svg, p.x, p.y, s.marker)
      if (s.labels) label(svg, m, s, p.k, s.values[p.k]!, p.x, p.y - lh * 0.8)
    }
  }
  void size
}

const ptOf = ([x, y]: [number, number]): Pt => ({ x, y })

// ---------------------------------------------------------------- surface

export interface Band {
  lo: number
  hi: number
  label: string
  fill: string | null
  look?: FillLook
}

/** a surface's value bands: one per step of its value axis, in the style's colors unless the file gives a band its own */
export function surfaceBands(g: ChartGroup, m: ChartModel): Band[] {
  const a = m.axes.find((x) => x.kind === 'val' && g.axIds.includes(x.id))
  const all = g.series.flatMap((s) => s.values).filter((v): v is number => v !== null)
  const s = niceScale(all.length ? lowest(all) : 0, all.length ? highest(all) : 1, { min: a?.min, max: a?.max, major: a?.major, ticks: 6 })
  const f = a?.format ?? g.series.find((x) => x.format)?.format
  const out: Band[] = []
  for (let k = 0; k + 1 < s.ticks.length && out.length < SURFACE_BANDS; k++) {
    const own = g.bands?.[k]
    out.push({ lo: s.ticks[k], hi: s.ticks[k + 1], label: `${fmt(s.ticks[k], f, m.date1904)}-${fmt(s.ticks[k + 1], f, m.date1904)}`, fill: own?.fill ?? g.bandColors?.[k] ?? '#4472c4', ...(own?.look ? { look: own.look } : {}) })
  }
  return out
}

/**
 * A surface seen from above, as Excel's contour chart: categories across, series up, each point of the grid between
 * the values colored by the band its value (interpolated between the four around it) falls in. A wireframe draws the
 * grid's lines in their bands' colors instead. A 3D surface is drawn in its view (chart-3d.ts).
 */
function drawSurface(svg: Svg, m: ChartModel, g: ChartGroup, area: Box, fixed: Box | null, size: number) {
  const bands = surfaceBands(g, m)
  if (!bands.length) return
  const rows = g.series.map((s) => s.values.map((v) => v ?? 0))
  const cols = Math.max(1, highest(rows.map((r) => r.length)))
  // a single row or column is stretched into a strip
  const grid = rows.length > 1 ? rows : [rows[0] ?? [], rows[0] ?? []]
  const z = grid.map((r) => (cols > 1 ? Array.from({ length: cols }, (_, c) => r[c] ?? 0) : [r[0] ?? 0, r[0] ?? 0]))
  const ny = z.length
  const nx = z[0].length
  const catAxis = m.axes.find((x) => x.id === g.axIds[0])
  const serAxis = m.axes.find((x) => x.kind === 'ser' && g.axIds.includes(x.id))
  const catT = textOf(m, catAxis?.text)
  const serT = textOf(m, serAxis?.text)
  const showCats = !(catAxis?.deleted ?? false) && (catAxis?.labels ?? true)
  const showSer = !(serAxis?.deleted ?? false) && (serAxis?.labels ?? true)
  const names = g.series.map((s) => s.name)
  const cats = g.series[0]?.cats ?? []
  const left = showSer ? Math.max(0, highest(names.map((x) => textWidth(x, serT.size, serT.bold)))) + 8 : 0
  const bottom = showCats ? lineHeight(catT.size) + 6 : 0
  const inner = fixed ?? { x: area.x + left, y: area.y + lineHeight(size) / 2, w: Math.max(10, area.w - left - 8), h: Math.max(10, area.h - bottom - lineHeight(size) / 2) }
  plotArea(svg, m, inner)
  const X = (i: number) => inner.x + (i / (nx - 1)) * inner.w
  const Y = (j: number) => inner.y + inner.h - (j / (ny - 1)) * inner.h
  const bandOf = (v: number) => {
    for (let k = 0; k < bands.length; k++) if (v < bands[k].hi || k === bands.length - 1) return k
    return bands.length - 1
  }
  const paints = bands.map((b) => fillPaint(svg, b.fill, b.look))
  if (g.wireframe) {
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (i + 1 < nx) svg.line(X(i), Y(j), X(i + 1), Y(j), { stroke: bands[bandOf((z[j][i] + z[j][i + 1]) / 2)].fill ?? m.textColor, sw: 1.5 })
        if (j + 1 < ny) svg.line(X(i), Y(j), X(i), Y(j + 1), { stroke: bands[bandOf((z[j][i] + z[j + 1][i]) / 2)].fill ?? m.textColor, sw: 1.5 })
      }
  } else {
    // each cell of the grid split into parts about 2 px across, so band edges look smooth; runs of one band in a row of
    // parts are one rect, and crisp edges keep neighboring rects from showing a seam between them
    const sub = Math.max(1, Math.min(60, Math.ceil(Math.min(inner.w / (nx - 1), inner.h / (ny - 1)) / 2)))
    const W = (nx - 1) * sub
    const H = (ny - 1) * sub
    const cw = inner.w / W
    const ch = inner.h / H
    svg.raw('<g shape-rendering="crispEdges">')
    for (let y = 0; y < H; y++) {
      const fy = (y + 0.5) / sub
      const j = Math.min(ny - 2, Math.floor(fy))
      const ty = fy - j
      let start = 0
      let cur = -1
      for (let x = 0; x <= W; x++) {
        let b = -1
        if (x < W) {
          const fx = (x + 0.5) / sub
          const i = Math.min(nx - 2, Math.floor(fx))
          const tx = fx - i
          const v = (z[j][i] * (1 - tx) + z[j][i + 1] * tx) * (1 - ty) + (z[j + 1][i] * (1 - tx) + z[j + 1][i + 1] * tx) * ty
          b = bandOf(v)
        }
        if (b !== cur) {
          if (cur >= 0 && paints[cur] !== 'none') svg.rect(inner.x + start * cw, inner.y + inner.h - (y + 1) * ch, (x - start) * cw + 0.5, ch + 0.5, { fill: paints[cur] })
          start = x
          cur = b
        }
      }
    }
    svg.raw('</g>')
  }
  const o = (t: { size: number; color: string; bold?: boolean }) => ({ size: t.size, color: t.color, bold: t.bold })
  if (showCats) {
    const every = Math.max(1, Math.ceil((Math.max(0, highest(cats.map((c) => textWidth(c, catT.size)))) + 6) / (inner.w / Math.max(1, nx - 1))))
    cats.forEach((c, i) => i % every || i >= nx || svg.text(X(i), inner.y + inner.h + 4 + lineHeight(catT.size) / 2, c, { ...o(catT), anchor: 'middle' }))
  }
  if (showSer && rows.length > 1) names.forEach((s, j) => svg.text(inner.x - 4, Y(j), s, { ...o(serT), anchor: 'end' }))
}
