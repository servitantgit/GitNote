/**
 * The Geometry sections of a Visio shape as paths: rows of moves, lines, circular and elliptical arcs, Béziers,
 * polylines and NURBS in the shape's own coordinates (inches, y up, origin at the bottom left of its box), turned
 * into moves, lines and cubic Béziers. Any affine transform of those is the path transformed.
 */
import { toNum, type Geometry, type GeomRow } from './sheet'

export type Seg = { t: 'M'; x: number; y: number } | { t: 'L'; x: number; y: number } | { t: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number } | { t: 'Z' }

/** [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f */
export type Matrix = [number, number, number, number, number, number]

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** `m` applied after `n` */
export function mul(m: Matrix, n: Matrix): Matrix {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]
}

export const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

/** a box's place in its parent: its pin moved to (px, py), turned by `angle`, flipped about its local pin */
export function placement(px: number, py: number, lx: number, ly: number, angle: number, flipX: boolean, flipY: boolean): Matrix {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const fx = flipX ? -1 : 1
  const fy = flipY ? -1 : 1
  // T(pin) · R(angle) · F · T(-locpin)
  const a = c * fx
  const b = s * fx
  const cc = -s * fy
  const d = c * fy
  return [a, b, cc, d, px - a * lx - cc * ly, py - b * lx - d * ly]
}

const EPS = 1e-9

/** a circular arc from (x0, y0) through (xm, ym) to (x1, y1) as cubic Béziers; a line when the points are in line */
function arcThrough(out: Seg[], x0: number, y0: number, xm: number, ym: number, x1: number, y1: number): void {
  const d = 2 * (x0 * (ym - y1) + xm * (y1 - y0) + x1 * (y0 - ym))
  const scale = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(xm - x0), Math.abs(ym - y0))
  if (Math.abs(d) < 1e-12 * Math.max(1, scale * scale) || !isFinite(d)) {
    out.push({ t: 'L', x: x1, y: y1 })
    return
  }
  const s0 = x0 * x0 + y0 * y0
  const sm = xm * xm + ym * ym
  const s1 = x1 * x1 + y1 * y1
  const cx = (s0 * (ym - y1) + sm * (y1 - y0) + s1 * (y0 - ym)) / d
  const cy = (s0 * (x1 - xm) + sm * (x0 - x1) + s1 * (xm - x0)) / d
  const r = Math.hypot(x0 - cx, y0 - cy)
  if (!isFinite(r) || r > 1e6 * Math.max(1, scale)) {
    out.push({ t: 'L', x: x1, y: y1 })
    return
  }
  const a0 = Math.atan2(y0 - cy, x0 - cx)
  let am = Math.atan2(ym - cy, xm - cx) - a0
  let a1 = Math.atan2(y1 - cy, x1 - cx) - a0
  const TAU = Math.PI * 2
  // counterclockwise: 0 < am < a1; else clockwise
  am = ((am % TAU) + TAU) % TAU
  a1 = ((a1 % TAU) + TAU) % TAU
  const sweep = am < a1 ? a1 : a1 - TAU
  arcSegs(out, cx, cy, r, a0, sweep, x1, y1)
}

/** an arc of a circle as Béziers of at most a quarter turn each, ending exactly at (ex, ey) */
function arcSegs(out: Seg[], cx: number, cy: number, r: number, a0: number, sweep: number, ex: number, ey: number): void {
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9))
  const step = sweep / n
  const k = (4 / 3) * Math.tan(step / 4)
  let a = a0
  for (let i = 0; i < n; i++) {
    const b = a + step
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    const cb = Math.cos(b)
    const sb = Math.sin(b)
    const last = i === n - 1
    out.push({
      t: 'C',
      x1: cx + r * (ca - k * sa),
      y1: cy + r * (sa + k * ca),
      x2: cx + r * (cb + k * sb),
      y2: cy + r * (sb - k * cb),
      x: last ? ex : cx + r * cb,
      y: last ? ey : cy + r * sb,
    })
    a = b
  }
}

/** Cox-de Boor basis function */
function basis(i: number, p: number, t: number, knots: number[]): number {
  if (p === 0) return knots[i] <= t && t < knots[i + 1] ? 1 : 0
  const d1 = knots[i + p] - knots[i]
  const d2 = knots[i + p + 1] - knots[i + 1]
  let v = 0
  if (d1 > 0) v += ((t - knots[i]) / d1) * basis(i, p - 1, t, knots)
  if (d2 > 0) v += ((knots[i + p + 1] - t) / d2) * basis(i + 1, p - 1, t, knots)
  return v
}

/** a NURBS curve through its control points (the first is where the path is) as lines */
function nurbs(out: Seg[], pts: [number, number][], knots: number[], weights: number[], degree: number): void {
  const end = pts[pts.length - 1]
  degree = Math.max(1, Math.min(Math.round(degree) || 3, 8, pts.length - 1))
  const ks = knots.filter(isFinite)
  if (pts.length < 2 || !ks.length) {
    out.push({ t: 'L', x: end[0], y: end[1] })
    return
  }
  while (ks.length < pts.length + degree + 1) ks.push(ks[ks.length - 1])
  const first = ks[0]
  const span = ks[ks.length - 1] - first
  if (!(span > 0)) {
    for (const p of pts.slice(1)) out.push({ t: 'L', x: p[0], y: p[1] })
    return
  }
  for (let i = 0; i < ks.length; i++) ks[i] = (ks[i] - first) / span
  const steps = Math.min(400, Math.max(8, pts.length * 8))
  let at = 0
  for (let s = 1; s < steps; s++) {
    const t = s / steps
    let x = 0
    let y = 0
    let den = 0
    // only the control points whose basis is not zero at t: those of the knot span t is in
    while (at + 1 < ks.length - 1 && ks[at + 1] <= t) at++
    for (let p = Math.max(0, at - degree); p <= at && p < pts.length; p++) {
      const b = basis(p, degree, t, ks) * (weights[p] ?? 1)
      if (!b) continue
      x += b * pts[p][0]
      y += b * pts[p][1]
      den += b
    }
    if (Math.abs(den) > EPS && isFinite(x / den) && isFinite(y / den)) out.push({ t: 'L', x: x / den, y: y / den })
  }
  out.push({ t: 'L', x: end[0], y: end[1] })
}

/** the arguments of `NURBS(…)` / `POLYLINE(…)` */
function args(formula: string | undefined): number[] {
  const m = /\(([^)]*)\)/.exec(formula ?? '')
  if (!m) return []
  const list = m[1].split(',')
  // far more points than a shape has: a crafted formula does not get to allocate without bound
  return list.slice(0, 40000).map((v) => Number(v))
}

/** The path of one Geometry section in the shape's coordinates; `w`, `h`: the shape's box. */
export function sectionPath(g: Geometry, w: number, h: number): Seg[] {
  const out: Seg[] = []
  let x = 0
  let y = 0
  let started = false
  // an old-style spline: control points and knots gathered until its last row
  let spline: { pts: [number, number][]; knots: number[]; last: number; degree: number } | null = null
  const n = (r: GeomRow, name: string) => toNum(r.cells.get(name))
  const start = () => {
    if (!started) out.push({ t: 'M', x, y })
    started = true
  }
  const endSpline = () => {
    if (!spline) return
    const s = spline
    spline = null
    if (s.pts.length < 2) return
    s.knots.push(s.last)
    start()
    nurbs(out, s.pts, s.knots, [], s.degree)
    ;[x, y] = s.pts[s.pts.length - 1]
  }
  for (const r of g.rows) {
    if (r.t !== 'SplineKnot') endSpline()
    switch (r.t) {
      case 'MoveTo':
      case 'RelMoveTo': {
        const rel = r.t === 'RelMoveTo'
        x = n(r, 'X') * (rel ? w : 1)
        y = n(r, 'Y') * (rel ? h : 1)
        out.push({ t: 'M', x, y })
        started = true
        break
      }
      case 'LineTo':
      case 'RelLineTo': {
        const rel = r.t === 'RelLineTo'
        start()
        x = n(r, 'X') * (rel ? w : 1)
        y = n(r, 'Y') * (rel ? h : 1)
        out.push({ t: 'L', x, y })
        break
      }
      case 'ArcTo': {
        start()
        const ex = n(r, 'X')
        const ey = n(r, 'Y')
        const bow = n(r, 'A')
        const len = Math.hypot(ex - x, ey - y)
        if (Math.abs(bow) < EPS || len < EPS) out.push({ t: 'L', x: ex, y: ey })
        else {
          // the arc bows to the right of the way it goes
          const mx = (x + ex) / 2 + ((ey - y) / len) * bow
          const my = (y + ey) / 2 - ((ex - x) / len) * bow
          arcThrough(out, x, y, mx, my, ex, ey)
        }
        x = ex
        y = ey
        break
      }
      case 'EllipticalArcTo':
      case 'RelEllipticalArcTo': {
        start()
        const rel = r.t === 'RelEllipticalArcTo'
        const ex = n(r, 'X') * (rel ? w : 1)
        const ey = n(r, 'Y') * (rel ? h : 1)
        const px = n(r, 'A') * (rel ? w : 1)
        const py = n(r, 'B') * (rel ? h : 1)
        const ang = n(r, 'C')
        const ratio = Math.abs(n(r, 'D')) || 1
        // the ellipse is a circle once its major axis lies on x and x is divided by the ratio of the axes
        const c = Math.cos(ang)
        const s = Math.sin(ang)
        const to = (qx: number, qy: number): [number, number] => [(qx * c + qy * s) / ratio, -qx * s + qy * c]
        const back = (qx: number, qy: number): [number, number] => [qx * ratio * c - qy * s, qx * ratio * s + qy * c]
        const [x0, y0] = to(x, y)
        const [xm, ym] = to(px, py)
        const [x1, y1] = to(ex, ey)
        const arc: Seg[] = []
        arcThrough(arc, x0, y0, xm, ym, x1, y1)
        for (const a of arc) {
          if (a.t === 'C') {
            const [bx1, by1] = back(a.x1, a.y1)
            const [bx2, by2] = back(a.x2, a.y2)
            const [bx, by] = back(a.x, a.y)
            out.push({ t: 'C', x1: bx1, y1: by1, x2: bx2, y2: by2, x: bx, y: by })
          }
        }
        // ends where the row says, whatever the rounding
        const lastSeg = out[out.length - 1]
        if (arc.length && arc[arc.length - 1].t === 'C' && lastSeg.t === 'C') {
          lastSeg.x = ex
          lastSeg.y = ey
        } else out.push({ t: 'L', x: ex, y: ey })
        x = ex
        y = ey
        break
      }
      case 'Ellipse':
      case 'RelEllipse': {
        const rel = r.t === 'RelEllipse'
        const sx = rel ? w : 1
        const sy = rel ? h : 1
        const cx = n(r, 'X') * sx
        const cy = n(r, 'Y') * sy
        const ux = n(r, 'A') * sx - cx
        const uy = n(r, 'B') * sy - cy
        const vx = n(r, 'C') * sx - cx
        const vy = n(r, 'D') * sy - cy
        // the unit circle, sent to the ellipse's two axes
        const k = 0.5522847498307936
        const p = (a: number, b: number): [number, number] => [cx + ux * a + vx * b, cy + uy * a + vy * b]
        const quad: [number, number][][] = [
          [[1, k], [k, 1], [0, 1]],
          [[-k, 1], [-1, k], [-1, 0]],
          [[-1, -k], [-k, -1], [0, -1]],
          [[k, -1], [1, -k], [1, 0]],
        ]
        const [mx, my] = p(1, 0)
        out.push({ t: 'M', x: mx, y: my })
        for (const q of quad) {
          const [a1, b1] = p(q[0][0], q[0][1])
          const [a2, b2] = p(q[1][0], q[1][1])
          const [a3, b3] = p(q[2][0], q[2][1])
          out.push({ t: 'C', x1: a1, y1: b1, x2: a2, y2: b2, x: a3, y: b3 })
        }
        out.push({ t: 'Z' })
        x = mx
        y = my
        started = false
        break
      }
      case 'RelCubBezTo': {
        start()
        const ex = n(r, 'X') * w
        const ey = n(r, 'Y') * h
        out.push({ t: 'C', x1: n(r, 'A') * w, y1: n(r, 'B') * h, x2: n(r, 'C') * w, y2: n(r, 'D') * h, x: ex, y: ey })
        x = ex
        y = ey
        break
      }
      case 'RelQuadBezTo': {
        start()
        const ex = n(r, 'X') * w
        const ey = n(r, 'Y') * h
        const qx = n(r, 'A') * w
        const qy = n(r, 'B') * h
        out.push({ t: 'C', x1: x + ((qx - x) * 2) / 3, y1: y + ((qy - y) * 2) / 3, x2: ex + ((qx - ex) * 2) / 3, y2: ey + ((qy - ey) * 2) / 3, x: ex, y: ey })
        x = ex
        y = ey
        break
      }
      case 'PolylineTo': {
        start()
        const a = args(r.cells.get('A'))
        const sx = a[0] === 0 ? w : 1
        const sy = a[1] === 0 ? h : 1
        for (let i = 2; i + 1 < a.length; i += 2) if (isFinite(a[i]) && isFinite(a[i + 1])) out.push({ t: 'L', x: a[i] * sx, y: a[i + 1] * sy })
        x = n(r, 'X')
        y = n(r, 'Y')
        out.push({ t: 'L', x, y })
        break
      }
      case 'NURBSTo': {
        start()
        const ex = n(r, 'X')
        const ey = n(r, 'Y')
        // NURBS(last knot, degree, x type, y type, then x, y, knot, weight of each control point)
        const a = args(r.cells.get('E'))
        const sx = a[2] === 0 ? w : 1
        const sy = a[3] === 0 ? h : 1
        const pts: [number, number][] = [[x, y]]
        const knots = [n(r, 'C')]
        const weights = [toNum(r.cells.get('D'), 1)]
        for (let i = 4; i + 3 < a.length; i += 4) {
          if (!isFinite(a[i]) || !isFinite(a[i + 1])) continue
          pts.push([a[i] * sx, a[i + 1] * sy])
          knots.push(a[i + 2])
          weights.push(isFinite(a[i + 3]) ? a[i + 3] : 1)
        }
        pts.push([ex, ey])
        knots.push(n(r, 'A'))
        if (isFinite(a[0])) knots.push(a[0])
        weights.push(toNum(r.cells.get('B'), 1))
        nurbs(out, pts, knots, weights, a[1])
        x = ex
        y = ey
        break
      }
      case 'SplineStart': {
        start()
        spline = { pts: [[x, y], [n(r, 'X'), n(r, 'Y')]], knots: [n(r, 'B'), n(r, 'A')], last: n(r, 'C'), degree: n(r, 'D') || 3 }
        break
      }
      case 'SplineKnot': {
        if (spline && spline.pts.length < 5000) {
          spline.pts.push([n(r, 'X'), n(r, 'Y')])
          spline.knots.push(n(r, 'A'))
        }
        break
      }
      // InfiniteLine (guides) and row types of other sections: not drawn
    }
  }
  endSpline()
  return out.filter((s) => s.t === 'Z' || (isFinite(s.x) && isFinite(s.y) && (s.t !== 'C' || (isFinite(s.x1) && isFinite(s.y1) && isFinite(s.x2) && isFinite(s.y2)))))
}

export interface SubPath {
  segs: Seg[]
  closed: boolean
}

/** A path split at its moves; a part that ends where it starts is closed. */
export function subPaths(segs: Seg[]): SubPath[] {
  const out: SubPath[] = []
  let cur: Seg[] = []
  const flush = () => {
    if (cur.length > 1) {
      const first = cur[0] as { x: number; y: number }
      const explicit = cur[cur.length - 1].t === 'Z'
      const body = explicit ? cur.slice(0, -1) : cur
      const last = body[body.length - 1] as { x: number; y: number }
      let size = 0
      for (const s of body) if (s.t !== 'Z') size = Math.max(size, Math.abs(s.x - first.x), Math.abs(s.y - first.y))
      const closed = explicit || (body.length > 2 && Math.hypot(last.x - first.x, last.y - first.y) <= 1e-6 * Math.max(1, size))
      out.push({ segs: body, closed })
    }
    cur = []
  }
  for (const s of segs) {
    if (s.t === 'M') flush()
    cur.push(s)
    if (s.t === 'Z') flush()
  }
  flush()
  return out
}

/** Corners between two straight lines rounded with radius `r` (the Rounding cell). */
export function roundCorners(sp: SubPath, r: number): SubPath {
  if (!(r > 0) || sp.segs.length < 3) return sp
  const segs = sp.segs
  const n = segs.length
  type P = { x: number; y: number }
  const pt = (i: number) => segs[i] as P
  const out: Seg[] = []
  // a closed path: its last point is its first, so the corner there is between the last and the first line
  const closedCorner = sp.closed && segs[n - 1].t === 'L' && segs[1].t === 'L'
  const corner = (prev: P, v: P, next: P): { a: P; b: P } | null => {
    const l1 = Math.hypot(v.x - prev.x, v.y - prev.y)
    const l2 = Math.hypot(next.x - v.x, next.y - v.y)
    if (l1 < EPS || l2 < EPS) return null
    const d = Math.min(r, l1 / 2, l2 / 2)
    return { a: { x: v.x + ((prev.x - v.x) / l1) * d, y: v.y + ((prev.y - v.y) / l1) * d }, b: { x: v.x + ((next.x - v.x) / l2) * d, y: v.y + ((next.y - v.y) / l2) * d } }
  }
  const K = 0.5522847498307936
  const curve = (c: { a: P; b: P }, v: P) =>
    out.push({ t: 'C', x1: c.a.x + (v.x - c.a.x) * K, y1: c.a.y + (v.y - c.a.y) * K, x2: c.b.x + (v.x - c.b.x) * K, y2: c.b.y + (v.y - c.b.y) * K, x: c.b.x, y: c.b.y })
  const startCorner = closedCorner ? corner(pt(n - 2), pt(0), pt(1)) : null
  out.push(startCorner ? { t: 'M', x: startCorner.b.x, y: startCorner.b.y } : segs[0])
  for (let i = 1; i < n; i++) {
    const s = segs[i]
    const next = segs[i + 1]
    if (s.t === 'L' && next?.t === 'L') {
      const c = corner(pt(i - 1), s, next)
      if (c) {
        out.push({ t: 'L', x: c.a.x, y: c.a.y })
        curve(c, s)
        continue
      }
    }
    if (i === n - 1 && startCorner && s.t === 'L') {
      out.push({ t: 'L', x: startCorner.a.x, y: startCorner.a.y })
      curve(startCorner, pt(0))
      continue
    }
    out.push(s)
  }
  return { segs: out, closed: sp.closed }
}

/** the path with every point sent through `m` */
export function transform(segs: Seg[], m: Matrix): Seg[] {
  return segs.map((s) => {
    if (s.t === 'Z') return s
    const [x, y] = apply(m, s.x, s.y)
    if (s.t !== 'C') return { t: s.t, x, y }
    const [x1, y1] = apply(m, s.x1, s.y1)
    const [x2, y2] = apply(m, s.x2, s.y2)
    return { t: 'C', x1, y1, x2, y2, x, y }
  })
}
