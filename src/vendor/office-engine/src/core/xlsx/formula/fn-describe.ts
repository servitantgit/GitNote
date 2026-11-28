/** Descriptive statistics and regression. */
import { A, flat, lift, nums, visit, type Ev, type FnDef, INF } from './fn'
import { ERR, FormulaError, type Value } from './types'
import { ArrayV, bool, num, UnionV, type Val } from './values'

// ---------------------------------------------------------------- shared helpers

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)

/** mean; the callers have checked for emptiness */
const avg = (xs: number[]) => sum(xs) / xs.length

/** Sum of squared deviations, centred on the mean (two passes keep it exact for near-constant data). */
function devSq(xs: number[]): number {
  const m = avg(xs)
  let ss = 0
  for (const x of xs) ss += (x - m) * (x - m)
  return ss
}

const same = (xs: number[]) => xs.every((x) => x === xs[0])

function variance(xs: number[], sample: boolean): number {
  const n = xs.length
  if (n < (sample ? 2 : 1)) throw ERR.DIV0
  return devSq(xs) / (sample ? n - 1 : n)
}

/** 2-D data of an array argument. */
function grid(v: Val, ev: Ev): Value[][] {
  if (v instanceof UnionV) throw ERR.VALUE
  return ev.toArray(v)
}

/** Numbers for the `…A` functions: text in a range counts 0, logicals 1/0, empty cells are skipped. */
function numsA(args: Val[], ev: Ev): number[] {
  const out: number[] = []
  for (const a of args)
    visit(
      a,
      ev,
      (v) => {
        if (v === null) return
        if (v instanceof FormulaError) throw v
        out.push(typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : 0)
      },
      (v) => out.push(num(v)),
    )
  return out
}

/** Pairs of numbers from two data arrays: same number of points, a pair with a non-number is dropped. */
function pairs(a: Val, b: Val, ev: Ev): [number[], number[]] {
  const p = flat(grid(a, ev))
  const q = flat(grid(b, ev))
  if (p.length !== q.length) throw ERR.NA
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i < p.length; i++) {
    const u = p[i]
    const v = q[i]
    if (u instanceof FormulaError) throw u
    if (v instanceof FormulaError) throw v
    if (typeof u === 'number' && typeof v === 'number') {
      xs.push(u)
      ys.push(v)
    }
  }
  return [xs, ys]
}

interface Moments {
  n: number
  mx: number
  my: number
  sxx: number
  syy: number
  sxy: number
}

function moments(xs: number[], ys: number[]): Moments {
  const n = xs.length
  const mx = avg(xs)
  const my = avg(ys)
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    sxx += dx * dx
    syy += dy * dy
    sxy += dx * dy
  }
  return { n, mx, my, sxx, syy, sxy }
}

/** Moments of (known_x's, known_y's) from the (known_y's, known_x's) arguments; no data points at all is #N/A. */
function paired(a: Val[], ev: Ev): Moments {
  const [ys, xs] = pairs(a[0], a[1], ev)
  if (!ys.length) throw ERR.NA
  return moments(xs, ys)
}

/** Guard against float noise in positions like k*(n-1) that should be whole. */
const snap = (x: number) => (Math.abs(x - Math.round(x)) < 1e-9 ? Math.round(x) : x)

function sorted(a: Val, ev: Ev): number[] {
  return nums([a], ev).sort((x, y) => x - y)
}

function percentInc(xs: number[], k: number): number {
  if (!xs.length || k < 0 || k > 1) throw ERR.NUM
  const pos = snap(k * (xs.length - 1))
  const lo = Math.floor(pos)
  return lo + 1 < xs.length ? xs[lo] + (pos - lo) * (xs[lo + 1] - xs[lo]) : xs[lo]
}

function percentExc(xs: number[], k: number): number {
  const n = xs.length
  if (!n || k <= 0 || k >= 1) throw ERR.NUM
  const pos = snap(k * (n + 1))
  if (pos < 1 || pos > n) throw ERR.NUM
  const lo = Math.floor(pos)
  return lo < n ? xs[lo - 1] + (pos - lo) * (xs[lo] - xs[lo - 1]) : xs[lo - 1]
}

const kArg = (a: Val[], ev: Ev) => num(ev.scalar(a[1]))

function quartile(a: Val[], ev: Ev, exclusive: boolean): number {
  const xs = sorted(a[0], ev)
  const q = Math.trunc(num(ev.scalar(a[1])))
  if (q < 0 || q > 4) throw ERR.NUM
  return exclusive ? percentExc(xs, q / 4) : percentInc(xs, q / 4)
}

/** PERCENTRANK: x's position among the sorted data, interpolated between neighbours, truncated to `sig` digits. */
function percentRank(a: Val[], ev: Ev, exclusive: boolean): number {
  const xs = sorted(a[0], ev)
  const x = num(ev.scalar(a[1]))
  const sig = a.length > 2 && a[2] !== null ? Math.trunc(num(ev.scalar(a[2]))) : 3
  if (!xs.length || sig < 1) throw ERR.NUM
  const n = xs.length
  if (x < xs[0] || x > xs[n - 1]) throw ERR.NA
  let pos: number
  const first = xs.indexOf(x)
  if (first >= 0) pos = first
  else {
    let i = 0
    while (xs[i + 1] < x) i++
    pos = i + (x - xs[i]) / (xs[i + 1] - xs[i])
  }
  const r = exclusive ? (pos + 1) / (n + 1) : n === 1 ? 1 : pos / (n - 1)
  const p = 10 ** Math.min(sig, 15)
  return Math.floor(r * p + 1e-9) / p
}

function rankAvg(a: Val[], ev: Ev): number {
  const x = num(ev.scalar(a[0]))
  const xs = nums([a[1]], ev)
  const asc = a.length > 2 && a[2] !== null && num(ev.scalar(a[2])) !== 0
  let before = 0
  let ties = 0
  for (const y of xs) {
    if (y === x) ties++
    else if (asc ? y < x : y > x) before++
  }
  if (!ties) throw ERR.NA
  return before + 1 + (ties - 1) / 2
}

function trimmean(a: Val[], ev: Ev): number {
  const xs = sorted(a[0], ev)
  const p = num(ev.scalar(a[1]))
  if (p < 0 || p > 1 || !xs.length) throw ERR.NUM
  // the number cut is rounded down to an even count: the same from each end
  const cut = Math.floor(Math.floor(xs.length * p + 1e-9) / 2)
  if (cut * 2 >= xs.length) throw ERR.NUM
  return avg(xs.slice(cut, xs.length - cut))
}

function frequency(a: Val[], ev: Ev): Val {
  const data = nums([a[0]], ev)
  const bins = nums([a[1]], ev)
  const out = new Array<number>(bins.length + 1).fill(0)
  // each value goes to the smallest bin that holds it (the first one among equal bins), else past the last
  const order = bins.map((_, i) => i).sort((i, j) => bins[i] - bins[j] || i - j)
  for (const x of data) {
    let slot = bins.length
    for (const i of order)
      if (x <= bins[i]) {
        slot = i
        break
      }
    out[slot]++
  }
  return new ArrayV(out.map((n) => [n]))
}

function modeMult(a: Val[], ev: Ev): Val {
  const counts = new Map<number, number>()
  let best = 0
  for (const x of nums(a, ev)) {
    const n = (counts.get(x) ?? 0) + 1
    counts.set(x, n)
    if (n > best) best = n
  }
  if (best < 2) throw ERR.NA
  return new ArrayV([...counts].filter(([, n]) => n === best).map(([x]) => [x]))
}

function geometric(xs: number[]): number {
  if (!xs.length || xs.some((x) => x <= 0)) throw ERR.NUM
  return Math.exp(avg(xs.map((x) => Math.log(x))))
}

function harmonic(xs: number[]): number {
  if (!xs.length || xs.some((x) => x <= 0)) throw ERR.NUM
  return xs.length / sum(xs.map((x) => 1 / x))
}

function skew(xs: number[], population: boolean): number {
  const n = xs.length
  if (n < 3 || same(xs)) throw ERR.DIV0
  const m = avg(xs)
  const s = Math.sqrt(devSq(xs) / (population ? n : n - 1))
  let c = 0
  for (const x of xs) c += ((x - m) / s) ** 3
  return population ? c / n : (n / ((n - 1) * (n - 2))) * c
}

function kurt(xs: number[]): number {
  const n = xs.length
  if (n < 4 || same(xs)) throw ERR.DIV0
  const m = avg(xs)
  const s = Math.sqrt(devSq(xs) / (n - 1))
  let c = 0
  for (const x of xs) c += ((x - m) / s) ** 4
  return (n * (n + 1) * c) / ((n - 1) * (n - 2) * (n - 3)) - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3))
}

/** AVERAGE.WEIGHTED(values1, weights1, [values2, weights2], ...): Google Sheets' weighted mean. */
function weighted(a: Val[], ev: Ev): number {
  if (a.length % 2) throw ERR.VALUE
  let top = 0
  let bottom = 0
  let seen = 0
  for (let i = 0; i < a.length; i += 2) {
    const v = flat(grid(a[i], ev))
    const w = flat(grid(a[i + 1], ev))
    if (v.length !== w.length) throw ERR.NA
    for (let j = 0; j < v.length; j++) {
      const x = v[j]
      const k = w[j]
      if (x instanceof FormulaError) throw x
      if (k instanceof FormulaError) throw k
      if (typeof x !== 'number' || typeof k !== 'number') continue
      if (k < 0) throw ERR.VALUE
      top += x * k
      bottom += k
      seen++
    }
  }
  if (!seen || bottom === 0) throw ERR.DIV0
  return top / bottom
}

function covariance(a: Val[], ev: Ev, sample: boolean): number {
  const [p, q] = pairs(a[0], a[1], ev)
  if (p.length < (sample ? 2 : 1)) throw ERR.DIV0
  const m = moments(p, q)
  return m.sxy / (sample ? m.n - 1 : m.n)
}

function correl(a: Val[], ev: Ev): number {
  const m = paired(a, ev)
  if (m.sxx === 0 || m.syy === 0) throw ERR.DIV0
  return m.sxy / Math.sqrt(m.sxx * m.syy)
}

/** FORECAST(x, known_y's, known_x's) */
function forecast(a: Val[], ev: Ev): number {
  const x = num(ev.scalar(a[0]))
  const m = paired([a[1], a[2]], ev)
  if (m.sxx === 0) throw ERR.DIV0
  const slope = m.sxy / m.sxx
  return m.my - slope * m.mx + slope * x
}

// ---------------------------------------------------------------- regression (LINEST & co.)

interface Layout {
  y: number[]
  /** n observations x k variables */
  X: number[][]
  k: number
  /** known_y's is a column, a row, or a block (one variable laid out any way) */
  orient: 'col' | 'row' | 'flat'
  h: number
  w: number
}

function cellNum(v: Value): number {
  if (typeof v === 'number') return v
  if (v instanceof FormulaError) throw v
  throw ERR.VALUE
}

/** Read known_y's / known_x's the way LINEST does: the variables run along the other axis of a vector y. */
function layout(yv: Val, xv: Val | null, ev: Ev): Layout {
  const yd = grid(yv, ev)
  const h = yd.length
  const w = yd[0]?.length ?? 0
  if (!h || !w) throw ERR.VALUE
  const y = flat(yd).map(cellNum)
  const n = y.length
  const orient = w === 1 ? 'col' : h === 1 ? 'row' : 'flat'
  if (xv === null) return { y, X: y.map((_, i) => [i + 1]), k: 1, orient, h, w }
  const xd = grid(xv, ev)
  if (orient === 'col') {
    if (xd.length !== n) throw ERR.REF
    return { y, X: xd.map((r) => r.map(cellNum)), k: xd[0].length, orient, h, w }
  }
  if (orient === 'row') {
    if ((xd[0]?.length ?? 0) !== n) throw ERR.REF
    const X = Array.from({ length: n }, (_, i) => xd.map((r) => cellNum(r[i])))
    return { y, X, k: xd.length, orient, h, w }
  }
  if (xd.length !== h || xd[0].length !== w) throw ERR.REF
  return { y, X: flat(xd).map((v) => [cellNum(v)]), k: 1, orient, h, w }
}

interface Fit {
  /** per variable (input order); 0 for a dropped, collinear one */
  coef: number[]
  b: number
  se: number[]
  seb: number | null
  r2: number
  sey: number
  F: number
  df: number
  ssreg: number
  ssresid: number
}

/**
 * Least squares by modified Gram-Schmidt on centred columns (run twice, for stability). A column that is a
 * combination of the earlier ones is dropped with coefficient 0, as Excel does.
 */
function fit(y: number[], X: number[][], k: number, constant: boolean): Fit {
  const n = y.length
  const mx = new Array<number>(k).fill(0)
  let my = 0
  if (constant) {
    for (let j = 0; j < k; j++) mx[j] = avg(X.map((r) => r[j]))
    my = avg(y)
  }
  const yc = y.map((v) => v - my)
  const Q: number[][] = []
  const Rcols: number[][] = []
  const kept: number[] = []
  for (let j = 0; j < k; j++) {
    const v = X.map((r) => r[j] - mx[j])
    const orig = Math.hypot(...v)
    const r = new Array<number>(Q.length + 1).fill(0)
    for (let pass = 0; pass < 2; pass++)
      for (let q = 0; q < Q.length; q++) {
        let d = 0
        for (let i = 0; i < n; i++) d += Q[q][i] * v[i]
        r[q] += d
        for (let i = 0; i < n; i++) v[i] -= d * Q[q][i]
      }
    const nrm = Math.hypot(...v)
    if (!(nrm > 1e-10 * orig)) continue
    r[Q.length] = nrm
    Q.push(v.map((e) => e / nrm))
    Rcols.push(r)
    kept.push(j)
  }
  const m = kept.length
  // R beta = Q'y by back substitution (R[row][col] = Rcols[col][row])
  const qty = Q.map((q) => q.reduce((s, e, i) => s + e * yc[i], 0))
  const beta = new Array<number>(m).fill(0)
  for (let i = m - 1; i >= 0; i--) {
    let s = qty[i]
    for (let c = i + 1; c < m; c++) s -= Rcols[c][i] * beta[c]
    beta[i] = s / Rcols[i][i]
  }
  // R^-1, for (X'X)^-1 = R^-1 R^-T
  const Rinv: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0))
  for (let c = 0; c < m; c++) {
    Rinv[c][c] = 1 / Rcols[c][c]
    for (let i = c - 1; i >= 0; i--) {
      let s = 0
      for (let t = i + 1; t <= c; t++) s += Rcols[t][i] * Rinv[t][c]
      Rinv[i][c] = -s / Rcols[i][i]
    }
  }
  const coef = new Array<number>(k).fill(0)
  kept.forEach((j, i) => (coef[j] = beta[i]))
  const b = constant ? my - kept.reduce((s, j, i) => s + beta[i] * mx[j], 0) : 0
  let ssresid = 0
  let sstot = 0
  for (let i = 0; i < n; i++) {
    let e = yc[i]
    for (let c = 0; c < m; c++) e -= beta[c] * (X[i][kept[c]] - mx[kept[c]])
    ssresid += e * e
    sstot += yc[i] * yc[i]
  }
  // an exact fit leaves rounding dust, not a residual
  if (ssresid < sstot * 1e-28) ssresid = 0
  const df = n - m - (constant ? 1 : 0)
  const ssreg = sstot - ssresid
  const r2 = sstot > 0 ? ssreg / sstot : 1
  const sey = df > 0 ? Math.sqrt(ssresid / df) : NaN
  const se = new Array<number>(k).fill(0)
  kept.forEach((j, c) => {
    let d = 0
    for (let t = c; t < m; t++) d += Rinv[c][t] ** 2
    se[j] = sey * Math.sqrt(d)
  })
  let seb: number | null = null
  if (constant) {
    let q = 0
    for (let c = 0; c < m; c++) {
      let wv = 0
      for (let i = 0; i <= c; i++) wv += Rinv[i][c] * mx[kept[i]]
      q += wv * wv
    }
    seb = sey * Math.sqrt(1 / n + q)
  }
  const F = df > 0 ? ssreg / m / (ssresid / df) : NaN
  return { coef, b, se, seb, r2, sey, F, df, ssreg, ssresid }
}

const fin = (x: number): Value => (Number.isFinite(x) ? x : ERR.NUM)

/** The LINEST layout: coefficients in reverse variable order then the constant; the 5-row block with `stats`. */
function coefBlock(f: Fit, stats: boolean, back: (x: number) => number): Val {
  const k = f.coef.length
  const row1 = [...f.coef].reverse().map(back)
  row1.push(back(f.b))
  if (!stats) return new ArrayV([row1.map(fin)])
  const na = (): Value[] => new Array<Value>(k - 1).fill(ERR.NA)
  const rowSe: Value[] = [...f.se].reverse().map(fin)
  rowSe.push(f.seb === null ? ERR.NA : fin(f.seb))
  return new ArrayV([
    row1.map(fin),
    rowSe,
    [fin(f.r2), fin(f.sey), ...na()],
    [fin(f.F), fin(f.df), ...na()],
    [fin(f.ssreg), fin(f.ssresid), ...na()],
  ])
}

/** Optional logical argument: a blank or absent one takes the default. */
function flag(a: Val[], i: number, def: boolean, ev: Ev): boolean {
  return a.length <= i || a[i] === null ? def : bool(ev.scalar(a[i]))
}

const optional = (a: Val[], i: number): Val | null => (a.length > i ? a[i] : null)

/** ln of known_y's for the exponential fits. */
function logs(y: number[]): number[] {
  if (y.some((v) => v <= 0)) throw ERR.NUM
  return y.map((v) => Math.log(v))
}

function linest(a: Val[], ev: Ev, log: boolean): Val {
  const L = layout(a[0], optional(a, 1), ev)
  const constant = flag(a, 2, true, ev)
  const stats = flag(a, 3, false, ev)
  const f = fit(log ? logs(L.y) : L.y, L.X, L.k, constant)
  return coefBlock(f, stats, log ? Math.exp : (x) => x)
}

/** TREND / GROWTH: the fitted values at new_x's (default known_x's), shaped like new_x's. */
function trend(a: Val[], ev: Ev, log: boolean): Val {
  const L = layout(a[0], optional(a, 1), ev)
  const constant = flag(a, 3, true, ev)
  const f = fit(log ? logs(L.y) : L.y, L.X, L.k, constant)
  const nv = optional(a, 2)
  let pts: number[][]
  let h: number
  let w: number
  if (nv === null) {
    pts = L.X
    ;[h, w] = L.orient === 'col' ? [L.y.length, 1] : L.orient === 'row' ? [1, L.y.length] : [L.h, L.w]
  } else {
    const d = grid(nv, ev)
    if (L.k === 1) {
      pts = flat(d).map((v) => [cellNum(v)])
      h = d.length
      w = d[0].length
    } else if (L.orient === 'col') {
      if (d[0].length !== L.k) throw ERR.REF
      pts = d.map((r) => r.map(cellNum))
      ;[h, w] = [d.length, 1]
    } else {
      if (d.length !== L.k) throw ERR.REF
      pts = Array.from({ length: d[0].length }, (_, i) => d.map((r) => cellNum(r[i])))
      ;[h, w] = [1, d[0].length]
    }
  }
  const vals = pts.map((p) => {
    let s = f.b
    for (let j = 0; j < L.k; j++) s += f.coef[j] * p[j]
    return fin(log ? Math.exp(s) : s)
  })
  return new ArrayV(Array.from({ length: h }, (_, i) => vals.slice(i * w, (i + 1) * w)))
}

// ---------------------------------------------------------------- registry

const first = (i: number) => i === 0
const second = (i: number) => i === 1

export const DESCRIBE: Record<string, FnDef> = {
  AVEDEV: A(1, INF, (a, ev) => {
    const xs = nums(a, ev)
    if (!xs.length) throw ERR.NUM
    const m = avg(xs)
    return avg(xs.map((x) => Math.abs(x - m)))
  }),
  AVERAGEA: A(1, INF, (a, ev) => {
    const xs = numsA(a, ev)
    if (!xs.length) throw ERR.DIV0
    return avg(xs)
  }),
  'AVERAGE.WEIGHTED': A(2, INF, weighted),
  CORREL: A(2, 2, correl),
  PEARSON: A(2, 2, correl),
  RSQ: A(2, 2, (a, ev) => {
    const m = paired(a, ev)
    if (m.n < 2 || m.sxx === 0 || m.syy === 0) throw ERR.DIV0
    return (m.sxy * m.sxy) / (m.sxx * m.syy)
  }),
  COVAR: A(2, 2, (a, ev) => covariance(a, ev, false)),
  'COVARIANCE.P': A(2, 2, (a, ev) => covariance(a, ev, false)),
  'COVARIANCE.S': A(2, 2, (a, ev) => covariance(a, ev, true)),
  DEVSQ: A(1, INF, (a, ev) => {
    const xs = nums(a, ev)
    if (!xs.length) throw ERR.NUM
    return devSq(xs)
  }),
  SLOPE: A(2, 2, (a, ev) => {
    const m = paired(a, ev)
    if (m.sxx === 0) throw ERR.DIV0
    return m.sxy / m.sxx
  }),
  INTERCEPT: A(2, 2, (a, ev) => {
    const m = paired(a, ev)
    if (m.sxx === 0) throw ERR.DIV0
    return m.my - (m.sxy / m.sxx) * m.mx
  }),
  FORECAST: A(3, 3, lift(first, forecast)),
  'FORECAST.LINEAR': A(3, 3, lift(first, forecast)),
  STEYX: A(2, 2, (a, ev) => {
    const [ys, xs] = pairs(a[0], a[1], ev)
    if (ys.length < 3) throw ERR.DIV0
    const m = moments(xs, ys)
    if (m.sxx === 0) throw ERR.DIV0
    return Math.sqrt(Math.max(0, m.syy - (m.sxy * m.sxy) / m.sxx) / (m.n - 2))
  }),
  FREQUENCY: A(2, 2, frequency),
  'MODE.MULT': A(1, INF, modeMult),
  GEOMEAN: A(1, INF, (a, ev) => geometric(nums(a, ev))),
  HARMEAN: A(1, INF, (a, ev) => harmonic(nums(a, ev))),
  KURT: A(1, INF, (a, ev) => kurt(nums(a, ev))),
  SKEW: A(1, INF, (a, ev) => skew(nums(a, ev), false)),
  'SKEW.P': A(1, INF, (a, ev) => skew(nums(a, ev), true)),
  MAXA: A(1, INF, (a, ev) => {
    const xs = numsA(a, ev)
    return xs.length ? Math.max(...xs) : 0
  }),
  MINA: A(1, INF, (a, ev) => {
    const xs = numsA(a, ev)
    return xs.length ? Math.min(...xs) : 0
  }),
  STDEVA: A(1, INF, (a, ev) => Math.sqrt(variance(numsA(a, ev), true))),
  STDEVPA: A(1, INF, (a, ev) => Math.sqrt(variance(numsA(a, ev), false))),
  VARA: A(1, INF, (a, ev) => variance(numsA(a, ev), true)),
  VARPA: A(1, INF, (a, ev) => variance(numsA(a, ev), false)),
  PERCENTILE: A(2, 2, lift(second, (a, ev) => percentInc(sorted(a[0], ev), kArg(a, ev)))),
  'PERCENTILE.INC': A(2, 2, lift(second, (a, ev) => percentInc(sorted(a[0], ev), kArg(a, ev)))),
  'PERCENTILE.EXC': A(2, 2, lift(second, (a, ev) => percentExc(sorted(a[0], ev), kArg(a, ev)))),
  QUARTILE: A(2, 2, lift(second, (a, ev) => quartile(a, ev, false))),
  'QUARTILE.INC': A(2, 2, lift(second, (a, ev) => quartile(a, ev, false))),
  'QUARTILE.EXC': A(2, 2, lift(second, (a, ev) => quartile(a, ev, true))),
  PERCENTRANK: A(2, 3, lift((i) => i > 0, (a, ev) => percentRank(a, ev, false))),
  'PERCENTRANK.INC': A(2, 3, lift((i) => i > 0, (a, ev) => percentRank(a, ev, false))),
  'PERCENTRANK.EXC': A(2, 3, lift((i) => i > 0, (a, ev) => percentRank(a, ev, true))),
  'RANK.AVG': A(2, 3, lift(first, rankAvg)),
  TRIMMEAN: A(2, 2, lift(second, trimmean)),
  LINEST: A(1, 4, (a, ev) => linest(a, ev, false)),
  LOGEST: A(1, 4, (a, ev) => linest(a, ev, true)),
  TREND: A(1, 4, (a, ev) => trend(a, ev, false)),
  GROWTH: A(1, 4, (a, ev) => trend(a, ev, true)),
}
