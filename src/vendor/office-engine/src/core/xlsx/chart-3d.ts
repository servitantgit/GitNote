/**
 * 3D charts (chart.ts `View3D`) as SVG: columns and bars as boxes, cylinders, cones and pyramids, lines as ribbons,
 * areas as slabs and surfaces as shaded meshes, inside the chart's walls and floor with the value axis' gridlines along
 * them; pies as thick tilted disks. The view is the file's: tipped toward the viewer by `rotX`, turned by `rotY`, with
 * right-angle axes (the front square to the viewer, depth drawn obliquely) or in perspective.
 *
 * Every mark is a convex solid: its faces turned away from the viewer are left out, the others are shaded by how
 * squarely they face the light, and the solids are drawn from the farthest to the nearest. The world is measured in
 * pixels before it is projected, so faces keep their true slopes for the light.
 */
import { hexToRgb, rgbToHex } from '../color'
import { lineHeight, textWidth, type Pt, type Svg } from '../diagram/svg'
import { labelsAt, type ChartAxis, type ChartGroup, type ChartModel, type Fill, type LineLook, type View3D } from './chart'
import { catLabels, cumulative, extent, fillPaint, fmt, gridPaint, highest, intervals, isStacked, labelShown, linePaint, niceScale, PX, surfaceBands, textOf, type Box } from './chart-svg'

type V3 = [number, number, number]

/** a projection of the chart's world (x across, y up, z away from the viewer) onto the picture */
interface View {
  at(p: V3): Pt
  /** the direction from `p` toward the viewer: faces turned the other way are not seen */
  toViewer(p: V3): V3
  /** how far `p` lies from the viewer: the farthest solids are drawn first */
  depth(p: V3): number
}

const rad = (d: number) => (d * Math.PI) / 180
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
const mean = (ps: V3[]): V3 => {
  const c: V3 = [0, 0, 0]
  for (const p of ps) (c[0] += p[0]), (c[1] += p[1]), (c[2] += p[2])
  return [c[0] / ps.length, c[1] / ps.length, c[2] / ps.length]
}
/** a polygon's normal by Newell's method: sound for faces with a corner repeated (a cone's tip) */
function normal(f: V3[]): V3 {
  const n: V3 = [0, 0, 0]
  for (let i = 0; i < f.length; i++) {
    const a = f[i]
    const b = f[(i + 1) % f.length]
    n[0] += (a[1] - b[1]) * (a[2] + b[2])
    n[1] += (a[2] - b[2]) * (a[0] + b[0])
    n[2] += (a[0] - b[0]) * (a[1] + b[1])
  }
  return norm(n)
}

/** the light: from the upper left, in front */
const LIGHT = norm([-0.25, 0.55, -1])
const bright = (n: V3) => 0.6 + 0.4 * Math.max(0, dot(n, LIGHT))
/** the light on a face turned squarely to the viewer: such a face shows its color as it is */
const FRONT = bright([0, 0, -1])

/** `color` as a face turned to `n` shows it, against the face that shows it as it is (`ref`) */
function shade(color: string, n: V3, ref = FRONT): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color
  const f = bright(n) / ref
  const [r, g, b] = hexToRgb(color).map((c) => (f <= 1 ? c * f : c + (255 - c) * Math.min(1, f - 1)))
  return rgbToHex([r, g, b])
}

/** a convex solid: its faces, a point inside it, its color and the paint of a face turned squarely to the viewer */
interface Solid {
  faces: V3[][]
  center: V3
  fill: string
  /** a gradient or pattern for the face turned to the viewer (or upward, for a pie's top) */
  face?: string
  /** the face shown in the color as it is: the front (columns) or the top (pies) */
  ref?: number
  line?: LineLook | null
  /** a curved side (a cylinder's or cone's mantle, a pie slice's rim): the faces between two rows of points, drawn as
   *  one shape shaded along it, so no seams show between its faces */
  ring?: { lo: V3[]; hi: V3[]; closed: boolean }
  /** drawn from both sides (a surface's mesh) */
  open?: boolean
  /** a mesh drawn as lines only */
  wire?: boolean
  /** how solids are ordered, the first drawn first */
  key: number[]
}

function drawSolid(svg: Svg, v: View, s: Solid) {
  if (s.ring) drawRing(svg, v, s, s.ring)
  for (const f of s.faces) {
    if (f.length < 3) continue
    const c = mean(f)
    let n = normal(f)
    if (dot(n, n) < 0.5) continue
    if (s.open) {
      if (dot(n, v.toViewer(c)) < 0) n = [-n[0], -n[1], -n[2]]
    } else {
      if (dot(n, sub(c, s.center)) < 0) n = [-n[0], -n[1], -n[2]]
      if (dot(n, v.toViewer(c)) <= 1e-6) continue
    }
    const pts = f.map((p) => {
      const q = v.at(p)
      return [q.x, q.y] as [number, number]
    })
    // a pie's sides are darker than its top, as Office lights them
    const color = shade(s.fill, n, s.ref === TOP && n[1] < 0.3 ? FRONT / 0.72 : s.ref)
    if (s.wire) {
      svg.poly(pts, { fill: 'none', stroke: color, sw: 1.25 })
      continue
    }
    // the face turned squarely to the viewer (or up, for a pie's top) takes the gradient or pattern
    const square = s.ref === TOP ? n[1] > 0.999 : n[2] < -0.999
    // the outline the file gives goes round the face shown as it is (a pie's top) or every face; else each face is
    // edged in its own color, so faces side by side show no seam
    const outline = s.line && (s.ref !== TOP || square)
    svg.poly(pts, { fill: square && s.face ? s.face : color, stroke: outline ? s.line!.color : color, sw: outline ? Math.max(0.5, s.line!.width * PX) : 0.6 })
  }
}

const TOP = bright([0, 1, 0])

const ringIds = new WeakMap<Svg, number>()

/** a curved side: each run of its faces turned to the viewer as one shape, with a gradient through their shades */
function drawRing(svg: Svg, v: View, s: Solid, ring: NonNullable<Solid['ring']>) {
  const { lo, hi, closed } = ring
  const m = closed ? lo.length : lo.length - 1
  if (m < 1) return
  const next = (j: number) => (j + 1) % lo.length
  const seen: boolean[] = []
  const colors: string[] = []
  const mids: Pt[] = []
  for (let j = 0; j < m; j++) {
    const f = [lo[j], lo[next(j)], hi[next(j)], hi[j]]
    const c = mean(f)
    let n = normal(f)
    if (dot(n, sub(c, s.center)) < 0) n = [-n[0], -n[1], -n[2]]
    seen.push(dot(n, n) > 0.5 && dot(n, v.toViewer(c)) > 1e-6)
    colors.push(shade(s.fill, n, s.ref === TOP && n[1] < 0.3 ? FRONT / 0.72 : s.ref))
    mids.push(v.at(c))
  }
  // the runs of faces seen; a closed ring is walked from a face not seen, so a run is not cut in two
  const start = closed ? Math.max(0, seen.indexOf(false)) : 0
  const runs: number[][] = []
  let run: number[] = []
  for (let i = 0; i < m; i++) {
    const j = (start + i) % m
    if (seen[j]) run.push(j)
    else if (run.length) (runs.push(run), (run = []))
  }
  if (run.length) runs.push(run)
  // shades run across the side: along the line through its two ends' middles, turned a quarter
  const a = v.at(mean(lo))
  const b = v.at(mean(hi))
  let px = -(b.y - a.y)
  let py = b.x - a.x
  const len = Math.hypot(px, py)
  if (len < 1e-6) (px = 1), (py = 0)
  else (px /= len), (py /= len)
  for (const r of runs) {
    const edge = [...r.map((j) => lo[j]), lo[next(r[r.length - 1])]]
    const top = [...r.map((j) => hi[j]), hi[next(r[r.length - 1])]]
    const pts = [...edge, ...top.reverse()].map((p) => {
      const q = v.at(p)
      return [q.x, q.y] as [number, number]
    })
    const along = r.map((j) => mids[j].x * px + mids[j].y * py)
    const t0 = Math.min(...along)
    const t1 = Math.max(...along)
    let fill = colors[r[0]]
    if (r.length > 1 && t1 - t0 > 0.5) {
      const k = (ringIds.get(svg) ?? 0) + 1
      ringIds.set(svg, k)
      const o = (x: number) => Math.round(x * 100) / 100
      const stops = r.map((j, i) => ({ at: (along[i] - t0) / (t1 - t0), color: colors[j] })).sort((x, y) => x.at - y.at)
      svg.raw(
        `<defs><linearGradient id="de-3d${k}" gradientUnits="userSpaceOnUse" x1="${o(px * t0)}" y1="${o(py * t0)}" x2="${o(px * t1)}" y2="${o(py * t1)}">${stops.map((x) => `<stop offset="${o(x.at * 100)}%" stop-color="${x.color}"/>`).join('')}</linearGradient></defs>`,
      )
      fill = `url(#de-3d${k})`
    }
    svg.poly(pts, s.line && s.ref !== TOP ? { fill, stroke: s.line.color, sw: Math.max(0.5, s.line.width * PX) } : { fill })
  }
}

/** solids drawn by their keys, the first first */
function drawAll(svg: Svg, v: View, solids: Solid[]) {
  solids.sort((a, b) => {
    for (let i = 0; i < Math.max(a.key.length, b.key.length); i++) {
      const d = (a.key[i] ?? 0) - (b.key[i] ?? 0)
      if (Math.abs(d) > 1e-9) return d
    }
    return 0
  })
  for (const s of solids) drawSolid(svg, v, s)
}

/**
 * Right-angle axes: x and y drawn as they are, a step into the depth as (cx, cy) on the picture. `ox`, `oy` place the
 * world's front bottom left corner.
 */
function obliqueView(ox: number, oy: number, cx: number, cy: number): View {
  const viewer = norm([cx, cy, -1])
  return {
    at: (p) => ({ x: ox + p[0] + p[2] * cx, y: oy - p[1] - p[2] * cy }),
    toViewer: () => viewer,
    depth: (p) => -dot(p, viewer),
  }
}

/**
 * The world (`w` × `h` × `d`) turned by `rotY` about its upright axis and tipped by `rotX`, in perspective where the
 * view has one, fitted into `box`.
 */
function turnedView(v3: View3D, w: number, h: number, d: number, box: Box): View {
  const t = rad(v3.rotY)
  const f = rad(v3.rotX)
  const c: V3 = [w / 2, h / 2, d / 2]
  const R = Math.hypot(w, h, d) / 2 || 1
  const persp = !v3.rightAngle && v3.perspective > 0
  const dist = persp ? R / Math.tan(rad(Math.max(2, v3.perspective) / 2)) + R : Infinity
  const viewer: V3 = [Math.sin(t) * Math.cos(f), Math.sin(f), -Math.cos(t) * Math.cos(f)]
  const camera: V3 = [c[0] + viewer[0] * dist, c[1] + viewer[1] * dist, c[2] + viewer[2] * dist]
  const raw = (p: V3) => {
    const X = p[0] - c[0]
    const Y = p[1] - c[1]
    const Z = p[2] - c[2]
    const x1 = X * Math.cos(t) + Z * Math.sin(t)
    const z1 = -X * Math.sin(t) + Z * Math.cos(t)
    const up = Y * Math.cos(f) + z1 * Math.sin(f)
    const dd = z1 * Math.cos(f) - Y * Math.sin(f)
    const s = persp ? dist / Math.max(dist * 0.1, dist + dd) : 1
    return { x: x1 * s, y: -up * s, d: dd }
  }
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const p of [0, 1].flatMap((i) => [0, 1].flatMap((j) => [0, 1].map((k) => raw([i * w, j * h, k * d]))))) {
    x0 = Math.min(x0, p.x)
    x1 = Math.max(x1, p.x)
    y0 = Math.min(y0, p.y)
    y1 = Math.max(y1, p.y)
  }
  const k = Math.min(box.w / Math.max(1e-9, x1 - x0), box.h / Math.max(1e-9, y1 - y0))
  const ox = box.x + (box.w - (x1 - x0) * k) / 2 - x0 * k
  const oy = box.y + (box.h - (y1 - y0) * k) / 2 - y0 * k
  return {
    at: (p) => {
      const r = raw(p)
      return { x: ox + r.x * k, y: oy + r.y * k }
    },
    toViewer: (p) => (persp ? norm(sub(camera, p)) : viewer),
    depth: (p) => raw(p).d,
  }
}

// ---------------------------------------------------------------- solids

/**
 * A column along the value direction from `from` to `to`, its footprint centered on (`cc`, `zc`), `a` across and `b`
 * deep (half sizes), of `sides` faces around: 4 for boxes and pyramids, more for cylinders and cones. Its section is
 * `r0` of the footprint at `from` and `r1` at `to` (0: a tip). `P` turns category, value and depth into the world.
 */
function column(P: (c: number, v: number, z: number) => V3, cc: number, zc: number, a: number, b: number, from: number, to: number, sides: number, r0: number, r1: number): Pick<Solid, 'faces' | 'center' | 'ring'> {
  const ring = (u: number, r: number) =>
    Array.from({ length: sides }, (_, j) => {
      const t = sides === 4 ? Math.PI / 4 + (j * Math.PI) / 2 : (2 * Math.PI * j) / sides
      const k = sides === 4 ? Math.SQRT2 : 1
      return P(cc + Math.cos(t) * a * r * k, u, zc + Math.sin(t) * b * r * k)
    })
  const lo = ring(from, r0)
  const hi = ring(to, r1)
  const faces: V3[][] = []
  // a round shape's side is one curved side; a box's or pyramid's its flat faces
  const round = sides > 4
  if (!round)
    for (let j = 0; j < sides; j++) {
      const n = (j + 1) % sides
      faces.push(r1 > 1e-6 ? [lo[j], lo[n], hi[n], hi[j]] : [lo[j], lo[n], hi[j]])
    }
  if (r0 > 1e-6) faces.push(lo)
  if (r1 > 1e-6) faces.push(hi)
  return { faces, center: P(cc, (from + to) / 2, zc), ...(round ? { ring: { lo, hi, closed: true } } : {}) }
}

/** a six-sided solid from its corners: the front four (z near) then the back four, each in the same order */
function hexa(front: V3[], back: V3[], skip: { left?: boolean; right?: boolean } = {}): V3[][] {
  const [a, b, c, d] = front
  const [e, f, g, h] = back
  const faces = [front, back, [a, b, f, e], [d, c, g, h]]
  if (!skip.left) faces.push([a, d, h, e])
  if (!skip.right) faces.push([b, c, g, f])
  return faces
}

// ---------------------------------------------------------------- columns, bars, lines, areas, surfaces

/** the sides a shape has around: a box or pyramid four, a cylinder or cone enough to look round */
const sidesOf = (shape: string) => (shape === 'box' || shape.startsWith('pyramid') ? 4 : 28)

/** a value axis' scale, ticks and their labels */
function valueScale(m: ChartModel, g: ChartGroup, a: ChartAxis | undefined, len: number, across: boolean) {
  const [lo, hi] = extent(g, m.blanks)
  const whole = g.grouping === 'percentStacked'
  const scale = niceScale(lo, hi, { min: a?.min ?? (whole ? lo : undefined), max: a?.max ?? (whole ? hi : undefined), major: a?.major, ticks: intervals(len, textOf(m, a?.text).size, across) })
  const f = a?.format ?? (whole ? '0%' : g.series.find((s) => s.format)?.format)
  return { scale, labels: scale.ticks.map((t) => fmt(t, f, m.date1904)) }
}

/**
 * The most marks a 3D chart is drawn with: bars, the stretches of ribbons and slabs between two points, the cells of a
 * surface's mesh (141 × 141 points). Each is a solid of its own, built, cut along its bands and sorted before any is
 * drawn: a chart of 100 000 takes seconds for a picture too large to show. One of more is not drawn (`drawCartesian3D`
 * throws, the view shows the chart's placeholder).
 */
export const MAX_3D_MARKS = 20_000

/** a wall or the floor: its fill and outline where the file gives them, the outline in the axis color where it gives none */
function wall(svg: Svg, v: View, pts: V3[], w: (Fill & { line?: LineLook | null }) | undefined, edge: string | null) {
  const p = pts.map((q) => {
    const s = v.at(q)
    return [s.x, s.y] as [number, number]
  })
  const fill = w ? fillPaint(svg, w.fill, w.look) : 'none'
  const line = w?.line === null ? null : w?.line ? linePaint(w.line) : edge ? { stroke: edge, sw: 0.75 } : null
  if (fill !== 'none' || line) svg.poly(p, { fill, ...(line ?? {}) })
}

/**
 * Columns and bars (clustered, stacked, 100 % or one behind another), ribbons, areas and surfaces, with their walls,
 * floor, gridlines and axis labels.
 */
export function drawCartesian3D(svg: Svg, m: ChartModel, g: ChartGroup, area: Box, fixed: Box | null) {
  const v3 = m.view3d!
  const axis = (id: string | undefined) => m.axes.find((a) => a.id === id)
  const catAxis = axis(g.axIds[0])
  const valAxis = axis(g.axIds[1])
  const serAxis = m.axes.find((a) => a.kind === 'ser' && g.axIds.includes(a.id))
  const horizontal = g.type === 'bar' && g.dir === 'bar'
  const surface = g.type === 'surface'
  // rows along the depth: one per series where they stand one behind another (a line's ribbons always do)
  const deep = g.type === 'line' || surface || g.grouping === 'standard'
  const rows = deep ? g.series.length : 1
  const n = Math.max(1, highest(g.series.map((s) => s.values.length)))
  const cats = catLabels(g.series[0], catAxis, m.date1904)
  const valT = textOf(m, valAxis?.text)
  const catT = textOf(m, catAxis?.text)
  const serT = textOf(m, serAxis?.text)
  const showVal = !(valAxis?.deleted ?? false) && (valAxis?.labels ?? true)
  const showCat = !(catAxis?.deleted ?? false) && (catAxis?.labels ?? true)
  const showSer = rows > 1 && !!serAxis && !serAxis.deleted && serAxis.labels
  const names = g.series.map((s) => s.name)
  let marks = 0
  for (const s of g.series) marks += s.values.length
  if ((surface ? (rows > 1 ? rows - 1 : 1) * (n - 1) : marks) > MAX_3D_MARKS) throw new Error(`a 3D chart of more than ${MAX_3D_MARKS} marks`)

  // the room the labels take around the 3D box; the value axis' labels from a first guess at its length
  const guess = valueScale(m, g, valAxis, horizontal ? area.w * 0.8 : area.h * 0.8, horizontal)
  const widest = (xs: string[], t: { size: number; bold?: boolean }) => (xs.length ? highest(xs.map((x) => textWidth(x, t.size, t.bold))) : 0)
  const titleRoom = (a: ChartAxis | undefined) => (a?.title && !a.deleted ? lineHeight(a.title.size * PX) + 4 : 0)
  const left = horizontal ? (showCat ? Math.min(area.w * 0.35, widest(cats, catT)) + 8 : 4) + titleRoom(catAxis) : (showVal ? widest(guess.labels, valT) + 8 : 4) + titleRoom(valAxis)
  const bottom = horizontal ? (showVal ? lineHeight(valT.size) + 6 : 4) + titleRoom(valAxis) : (showCat ? lineHeight(catT.size) + 6 : 4) + titleRoom(catAxis)
  const right = showSer ? Math.min(area.w * 0.3, widest(names, serT)) + 10 : 6
  const top = lineHeight(valT.size) / 2
  const box: Box = fixed ?? { x: area.x + left, y: area.y + top, w: Math.max(20, area.w - left - right), h: Math.max(20, area.h - top - bottom) }

  // the world: categories across (up, for horizontal bars), values up (across), rows into the depth, in pixels
  const depthUnits = (rows * v3.depthPercent) / 100
  // right-angle axes: a step into the depth moves across and up as far as the view's turn and tip would move it
  const cx = v3.rightAngle ? Math.sin(rad(v3.rotY)) : 0
  const cy = v3.rightAngle ? Math.sin(rad(v3.rotX)) * Math.cos(rad(v3.rotY)) : 0
  let W: number
  let H: number
  let band: number
  if (v3.rightAngle) {
    if (horizontal) {
      H = box.h / (1 + (depthUnits * Math.abs(cy)) / n)
      band = H / n
      W = Math.max(10, box.w - depthUnits * band * Math.abs(cx))
    } else {
      W = box.w / (1 + (depthUnits * Math.abs(cx)) / n)
      band = W / n
      H = Math.max(10, box.h - depthUnits * band * Math.abs(cy))
    }
  } else if (horizontal) {
    H = box.h
    band = H / n
    W = v3.hPercent ? (H * 100) / v3.hPercent : box.w
  } else {
    // in perspective, without a height of its own: bars as tall as the plot allows, ribbons under half the width,
    // areas and surfaces a third, as Office draws them
    W = box.w
    band = W / n
    H = v3.hPercent ? (W * v3.hPercent) / 100 : g.type === 'bar' ? box.h : g.type === 'line' ? W * 0.45 : W / 3
  }
  const D = depthUnits * band
  const view = v3.rightAngle
    ? obliqueView(box.x + (cx < 0 ? D * -cx : 0), box.y + box.h - (cy < 0 ? D * -cy : 0), cx, cy)
    : turnedView(v3, W, H, D, box)
  const catLen = horizontal ? H : W
  const valLen = horizontal ? W : H
  const { scale, labels } = valueScale(m, g, valAxis, valLen, horizontal)
  const along = (v: number) => {
    let f = (v - scale.min) / (scale.max - scale.min || 1)
    if (valAxis?.reverse) f = 1 - f
    return Math.max(0, Math.min(1, f)) * valLen
  }
  const catReverse = catAxis?.reverse ?? false
  const catAt = (k: number) => (catReverse ? n - 1 - k : k) * band
  const P = (c: number, v: number, z: number): V3 => (horizontal ? [v, c, z] : [c, v, z])
  const rowDepth = D / rows
  // where columns stand: zero, or the bound nearest it
  const base = along(Math.min(Math.max(0, scale.min), scale.max))

  // the walls and floor, and the value axis' gridlines along the back wall and the side wall
  const towardX = view.toViewer([W / 2, H / 2, D / 2])
  // the side wall is the one seen from inside: on the left when the chart is turned to show its right side
  const sideC = (horizontal ? towardX[1] : towardX[0]) >= 0 ? 0 : catLen
  wall(svg, view, [P(0, 0, D), P(catLen, 0, D), P(catLen, valLen, D), P(0, valLen, D)], v3.back, null)
  wall(svg, view, [P(sideC, 0, 0), P(sideC, 0, D), P(sideC, valLen, D), P(sideC, valLen, 0)], v3.side, null)
  wall(svg, view, [P(0, base, 0), P(catLen, base, 0), P(catLen, base, D), P(0, base, D)], v3.floor, m.axisColor)
  const grid = valAxis ? gridPaint(m, valAxis) : { stroke: m.gridColor }
  const line = (a: V3, b: V3, p: { stroke?: string; sw?: number; dash?: string }) => {
    const s = view.at(a)
    const e = view.at(b)
    svg.line(s.x, s.y, e.x, e.y, p)
  }
  if (grid)
    for (const t of scale.ticks) {
      const u = along(t)
      line(P(0, u, D), P(catLen, u, D), grid)
      line(P(sideC, u, 0), P(sideC, u, D), grid)
    }
  // the value axis' line: the side wall's front edge
  line(P(sideC, 0, 0), P(sideC, valLen, 0), valAxis?.line ? linePaint(valAxis.line) : { stroke: m.axisColor, sw: 0.75 })

  // labels
  const o = (t: { size: number; color: string; bold?: boolean }) => ({ size: t.size, color: t.color, bold: t.bold })
  if (showVal)
    scale.ticks.forEach((t, k) => {
      const p = view.at(P(sideC, along(t), 0))
      if (horizontal) svg.text(p.x, p.y + 4 + lineHeight(valT.size) / 2, labels[k], { ...o(valT), anchor: 'middle' })
      else svg.text(p.x - 6, p.y, labels[k], { ...o(valT), anchor: 'end' })
    })
  if (showCat) {
    const room = horizontal ? lineHeight(catT.size) : widest(cats, catT) + 4
    // (a band is a fraction of a pixel where a series has more points than the plot is wide)
    const every = Math.max(1, Math.ceil(room / Math.max(1e-6, band))) || 1
    cats.forEach((c, k) => {
      if (k % every || k >= n) return
      const p = view.at(P(catAt(k) + band / 2, 0, 0))
      if (horizontal) svg.text(p.x - 6, p.y, c, { ...o(catT), anchor: 'end' })
      else svg.text(p.x, p.y + 4 + lineHeight(catT.size) / 2, c, { ...o(catT), anchor: 'middle' })
    })
  }
  if (showSer)
    names.forEach((name, r) => {
      const p = view.at(P(sideC === 0 ? catLen : 0, 0, (r + 0.5) * rowDepth))
      svg.text(p.x + (sideC === 0 ? 6 : -6), p.y, name, { ...o(serT), anchor: sideC === 0 ? 'start' : 'end' })
    })
  axisTitles(svg, m, horizontal ? catAxis : valAxis, horizontal ? valAxis : catAxis, area, box)

  // the marks: each a solid, drawn far to near
  const solids: Solid[] = []
  const gap = 1 + (g.gapDepth ?? 150) / 100
  const depthOf = (r: number) => {
    const d = rowDepth / gap
    const z0 = r * rowDepth + (rowDepth - d) / 2
    return { z0, z1: z0 + d, zc: z0 + d / 2, half: d / 2 }
  }
  const order = (c: V3, r: number) => [-(r * rowDepth), view.depth(c) * -1]
  if (g.type === 'bar') barSolids(svg, g, { P, along, catAt, band, base, depthOf, scale, solids, order, rows })
  else if (g.type === 'line') {
    const th = Math.max(2, valLen * 0.012)
    g.series.forEach((s, r) => {
      const { z0, z1 } = depthOf(r)
      const fill = s.fill ?? s.line?.color ?? '#4472c4'
      for (let k = 0; k + 1 < s.values.length; k++) {
        const a = s.values[k]
        const b = s.values[k + 1]
        if (a === null || b === null) continue
        const c0 = catAt(k) + band / 2
        const c1 = catAt(k + 1) + band / 2
        const ya = along(a)
        const yb = along(b)
        const front = [P(c0, ya - th, z0), P(c1, yb - th, z0), P(c1, yb, z0), P(c0, ya, z0)]
        const back = front.map((p) => [p[0], p[1], z1] as V3)
        const center = mean([...front, ...back])
        solids.push({ faces: hexa(front, back), center, fill, line: null, key: order(center, r), ...(s.look ? { face: fillPaint(svg, fill, s.look) } : {}) })
      }
    })
  } else if (g.type === 'area') {
    g.series.forEach((s, i) => {
      const r = rows > 1 ? i : 0
      const { z0, z1 } = depthOf(r)
      const tops = (isStacked(g) ? cumulative(g, s) : s.values).map((v) => along(v ?? 0))
      const below = isStacked(g) && i > 0 ? cumulative(g, g.series[i - 1]).map((v) => along(v ?? 0)) : tops.map(() => base)
      const face = s.look ? fillPaint(svg, s.fill, s.look) : undefined
      for (let k = 0; k + 1 < tops.length; k++) {
        const c0 = catAt(k) + band / 2
        const c1 = catAt(k + 1) + band / 2
        const front = [P(c0, below[k], z0), P(c1, below[k + 1], z0), P(c1, tops[k + 1], z0), P(c0, tops[k], z0)]
        const back = front.map((p) => [p[0], p[1], z1] as V3)
        const center = mean([...front, ...back])
        // the faces between one stretch and the next lie inside the slab
        solids.push({ faces: hexa(front, back, { left: k > 0, right: k + 2 < tops.length }), center, fill: s.fill ?? '#4472c4', ...(face ? { face } : {}), line: s.line, key: [-(r * rowDepth), i, -view.depth(center)] })
      }
    })
  } else if (surface) {
    const bands = surfaceBands(g, m)
    const bandOf = (v: number) => {
      for (let k = 0; k < bands.length; k++) if (v < bands[k].hi || k === bands.length - 1) return bands[k]
      return bands[bands.length - 1]
    }
    const z = (r: number) => (r + 0.5) * rowDepth
    const clampV = (v: number) => Math.min(Math.max(v, scale.min), scale.max)
    // (an axis without a step between its bounds has no band to color a cell with: nothing to draw)
    for (let r = 0; bands.length > 0 && (r + 1 < rows || (rows === 1 && r === 0)); r++) {
      const ra = g.series[r]
      const rb = g.series[Math.min(rows - 1, r + 1)]
      for (let k = 0; k + 1 < n; k++) {
        const vs = [ra.values[k], ra.values[k + 1], rb.values[k + 1], rb.values[k]].map((v) => clampV(v ?? 0))
        const zs = [z(r), z(r), z(Math.min(rows - 1, r + 1)), z(Math.min(rows - 1, r + 1))]
        const cs = [catAt(k), catAt(k + 1), catAt(k + 1), catAt(k)].map((c) => c + band / 2)
        const corners = vs.map((v, j) => ({ p: P(cs[j], along(v), zs[j]), v }))
        const center = mean(corners.map((c) => c.p))
        if (g.wireframe) {
          const b = bandOf((vs[0] + vs[1] + vs[2] + vs[3]) / 4)
          solids.push({ faces: [corners.map((c) => c.p)], center, fill: b.fill ?? '#4472c4', open: true, wire: true, key: [-view.depth(center)] })
          continue
        }
        // each cell in two triangles, each cut along the bands' bounds: a piece of the surface per band it crosses
        const faces: { face: V3[]; band: (typeof bands)[number] }[] = []
        for (const tri of [[corners[0], corners[1], corners[2]], [corners[0], corners[2], corners[3]]])
          bands.forEach((b, i) => {
            const piece = clipValues(tri, i === 0 ? -Infinity : b.lo, i === bands.length - 1 ? Infinity : b.hi)
            if (piece.length >= 3) faces.push({ face: piece, band: b })
          })
        for (const f of faces) solids.push({ faces: [f.face], center, fill: f.band.fill ?? '#4472c4', open: true, key: [-view.depth(center)] })
      }
      if (rows === 1) break
    }
  }
  drawAll(svg, view, solids)
}

/** the part of a polygon (its corners with their values) whose values lie between `lo` and `hi`, the cut corners in between */
function clipValues(poly: { p: V3; v: number }[], lo: number, hi: number): V3[] {
  const cut = (pts: { p: V3; v: number }[], keep: (v: number) => boolean, at: number) => {
    const out: { p: V3; v: number }[] = []
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % pts.length]
      if (keep(a.v)) out.push(a)
      if (keep(a.v) !== keep(b.v)) {
        const t = (at - a.v) / (b.v - a.v)
        out.push({ p: [a.p[0] + (b.p[0] - a.p[0]) * t, a.p[1] + (b.p[1] - a.p[1]) * t, a.p[2] + (b.p[2] - a.p[2]) * t], v: at })
      }
    }
    return out
  }
  let pts = poly
  if (Number.isFinite(lo)) pts = cut(pts, (v) => v >= lo, lo)
  if (Number.isFinite(hi)) pts = cut(pts, (v) => v <= hi, hi)
  return pts.map((x) => x.p)
}

interface BarGeo {
  P: (c: number, v: number, z: number) => V3
  along: (v: number) => number
  catAt: (k: number) => number
  band: number
  base: number
  depthOf: (r: number) => { z0: number; z1: number; zc: number; half: number }
  scale: { min: number; max: number }
  solids: Solid[]
  order: (c: V3, r: number) => number[]
  rows: number
}

/** columns and bars: boxes, cylinders, cones and pyramids, side by side, stacked or one behind another */
function barSolids(svg: Svg, g: ChartGroup, geo: BarGeo) {
  const { P, along, catAt, band, base, depthOf, solids, order, rows } = geo
  const stacked = isStacked(g)
  const side = rows === 1 && !stacked ? g.series.length : 1
  const ov = Math.max(-1, Math.min(1, g.overlap / 100))
  const w = band / (side - (side - 1) * ov + g.gapWidth / 100)
  const total = side * w - (side - 1) * w * ov
  const n = highest(g.series.map((s) => s.values.length))
  for (let k = 0; k < n; k++) {
    let pos = 0
    let neg = 0
    const tot = g.grouping === 'percentStacked' ? g.series.reduce((a, s) => a + Math.abs(s.values[k] ?? 0), 0) || 1 : 1
    // a stack's ends: a cone or pyramid of a stack narrows to its tip at the stack's end
    let up = 0
    let down = 0
    for (const s of g.series) {
      const v = (s.values[k] ?? 0) / tot
      if (v >= 0) up += v
      else down += v
    }
    g.series.forEach((s, i) => {
      const raw = s.values[k]
      if (raw === null || raw === undefined) return
      const v = raw / tot
      let from = 0
      let to = v
      if (stacked) {
        from = v >= 0 ? pos : neg
        to = from + v
        if (v >= 0) pos = to
        else neg = to
      }
      const r = rows > 1 ? i : 0
      const { zc, half } = depthOf(r)
      const c0 = catAt(k) + (band - total) / 2 + (side > 1 ? i * w * (1 - ov) : 0)
      const a = stacked || rows > 1 ? band / (2 * (1 + g.gapWidth / 100)) : w / 2
      const cc = stacked || rows > 1 ? catAt(k) + band / 2 : c0 + w / 2
      const shape = s.shape ?? g.shape ?? 'box'
      const p0 = stacked ? along(from) : base
      const p1 = along(to)
      if (Math.abs(p1 - p0) < 0.5) return
      // how wide the section is at a value: 1 all along for boxes and cylinders; for cones and pyramids narrowing to
      // the tip at the bar's (or stack's) end, or at the axis' end for the ToMax shapes
      let r0 = 1
      let r1 = 1
      if (shape !== 'box' && shape !== 'cylinder') {
        const tip = shape.endsWith('ToMax') ? (to >= 0 ? along(geo.scale.max) : along(geo.scale.min)) : stacked ? along(to >= 0 ? up : down) : p1
        const span = tip - base || 1
        r0 = Math.max(0, 1 - (p0 - base) / span)
        r1 = Math.max(0, 1 - (p1 - base) / span)
      }
      const solid = column(P, cc, zc, a, half, p0, p1, sidesOf(shape), r0, r1)
      const pt = s.points[k]
      const fill = pt?.color ?? s.fill ?? '#4472c4'
      const look = pt?.look ?? (pt?.color ? undefined : s.look)
      solids.push({ ...solid, fill, ...(look ? { face: fillPaint(svg, fill, look) } : {}), line: s.line, key: [...order(solid.center, r), stacked ? Math.abs(p0 - base) : 0] })
    })
  }
}

/** the value and category axes' titles: along the left side and under the plot */
function axisTitles(svg: Svg, m: ChartModel, leftAxis: ChartAxis | undefined, bottomAxis: ChartAxis | undefined, area: Box, box: Box) {
  const put = (a: ChartAxis | undefined, where: 'left' | 'bottom') => {
    if (!a?.title || a.deleted) return
    const s = a.title.size * PX
    const o = { size: s, bold: a.title.bold, color: a.title.color ?? m.textColor, anchor: 'middle' as const }
    if (where === 'bottom') svg.text(box.x + box.w / 2, area.y + area.h - lineHeight(s) / 2, a.title.text, o)
    else {
      const x = area.x + lineHeight(s) / 2
      const y = box.y + box.h / 2
      svg.raw(`<g transform="rotate(-90 ${Math.round(x)} ${Math.round(y)})">`).text(x, y, a.title.text, o).raw('</g>')
    }
  }
  put(leftAxis, 'left')
  put(bottomAxis, 'bottom')
}

// ---------------------------------------------------------------- pie

/**
 * A 3D pie: its first series as a thick disk tipped toward the viewer by `rotX`, the first slice starting at `rotY`
 * degrees clockwise from 12 o'clock, exploded slices pulled out along their middles.
 */
export function drawPie3D(svg: Svg, m: ChartModel, g: ChartGroup, box: Box) {
  const v3 = m.view3d!
  const s = g.series[0]
  if (!s) return
  if (s.values.length > MAX_3D_MARKS) throw new Error(`a 3D chart of more than ${MAX_3D_MARKS} marks`)
  const vals = s.values.map((v) => (v ? Math.abs(v) : 0))
  const total = vals.reduce((a, b) => a + b, 0)
  if (!total) return
  const f = rad(Math.max(10, Math.min(90, v3.rotX)))
  const exploded = Math.max(0, highest(Object.values(s.points).map((p) => p.explosion ?? 0))) / 100
  const outside = !!s.labels && (s.labels.pos === 'outEnd' || s.labels.pos === 'bestFit')
  const thick = 0.22 * ((v3.hPercent ?? 100) / 100)
  // the pie's radius: its width and its tipped height (top ellipse and side) within the box
  const reach = 1 + exploded
  const R = Math.max(4, Math.min(box.w / (2 * reach), box.h / (2 * reach * Math.sin(f) + thick * Math.cos(f))) * (outside ? 0.75 : 0.92))
  const t = thick * R
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2 + (t * Math.cos(f)) / 2
  const view: View = {
    at: (p) => ({ x: cx + p[0], y: cy - (p[1] * Math.cos(f) + p[2] * Math.sin(f)) }),
    toViewer: () => [0, Math.sin(f), -Math.cos(f)],
    depth: (p) => p[2] * Math.cos(f) - p[1] * Math.sin(f),
  }
  // 12 o'clock is the far side; slices run clockwise seen from above
  const point = (a: number, r: number, y: number, o: V3): V3 => [o[0] + Math.sin(a) * r, y, o[2] + Math.cos(a) * r]
  const solids: Solid[] = []
  const labels: (() => void)[] = []
  let a = rad(v3.rotY)
  vals.forEach((v, k) => {
    if (!v) return
    const sweep = (v / total) * Math.PI * 2
    const mid = a + sweep / 2
    const off = ((s.points[k]?.explosion ?? 0) / 100) * R
    const o: V3 = [Math.sin(mid) * off, 0, Math.cos(mid) * off]
    const pt = s.points[k]
    const fill = pt?.color ?? s.fill ?? '#4472c4'
    const look = pt?.look ?? (pt?.color ? undefined : s.look)
    const face = look ? fillPaint(svg, fill, look) : undefined
    // a slice of more than half the pie cut in two: each piece a convex wedge
    const parts = Math.max(1, Math.ceil(sweep / Math.PI - 1e-9))
    for (let q = 0; q < parts; q++) {
      const b0 = a + (sweep * q) / parts
      const b1 = a + (sweep * (q + 1)) / parts
      const steps = Math.max(2, Math.ceil((b1 - b0) / rad(4)))
      const arc = (y: number) => Array.from({ length: steps + 1 }, (_, j) => point(b0 + ((b1 - b0) * j) / steps, R, y, o))
      const rimLo = arc(0)
      const rimHi = arc(t)
      const lo = [point(0, 0, 0, o), ...rimLo]
      const hi = [point(0, 0, t, o), ...rimHi]
      // the top and bottom, the slice's cut faces (not those between its own pieces), and the rim as one curved side
      const faces: V3[][] = [lo, hi]
      if (q === 0) faces.push([lo[0], lo[1], hi[1], hi[0]])
      if (q === parts - 1) faces.push([lo[0], lo[lo.length - 1], hi[hi.length - 1], hi[0]])
      const center = mean([...lo, ...hi])
      solids.push({ faces, center, ring: { lo: rimLo, hi: rimHi, closed: false }, fill, ...(face ? { face } : {}), ref: TOP, line: s.line, key: [-view.depth(point((b0 + b1) / 2, R * 0.7, t / 2, o))] })
    }
    const l = labelShown(s, k) ? labelsAt(s, k) : undefined
    if (l) {
      const parts2: string[] = []
      if (l.series) parts2.push(s.name)
      if (l.category) parts2.push(s.cats[k] ?? '')
      if (l.value) parts2.push(fmt(s.values[k]!, l.format ?? s.format, m.date1904))
      if (l.percent) parts2.push(fmt(v / total, l.format && l.format.includes('%') ? l.format : '0%', m.date1904))
      const out = outside || l.pos === 'outEnd'
      const lt = textOf(m, l.text)
      const p = view.at(point(mid, out ? R * 1.18 : R * 0.65, t, o))
      const anchor = out ? (Math.sin(mid) >= 0 ? 'start' : 'end') : 'middle'
      const color = l.text?.color ?? (out ? m.textColor : '#ffffff')
      labels.push(() => svg.text(p.x, p.y, parts2.join(l.sep ?? (out ? '; ' : '\n')).split('\n'), { size: lt.size, color, bold: lt.bold, anchor }))
    }
    a += sweep
  })
  drawAll(svg, view, solids)
  for (const l of labels) l()
}
