/**
 * FORECAST.ETS and its companions: exponential triple smoothing with additive error, trend and season (AAA), the
 * model Excel names. Excel does not publish how it fits the three smoothing constants: here they are the ones that
 * make the squared one-step-ahead errors smallest, so a forecast may differ from Excel's in its last digits.
 */
import { serialToYmd } from './dates'
import { A, type Ev, type FnDef } from './fn'
import { normInv } from './special'
import { ERR, FormulaError, type Value } from './types'
import { num, UnionV, type Val } from './values'

interface Series {
  /** the values at every step, the missing ones filled in */
  y: number[]
  /** the time of the first value, and the step between two (in months when `monthly`) */
  t0: number
  step: number
  monthly: boolean
  /** the day of the month a monthly timeline is on */
  day: number
}

function numbers(v: Val, ev: Ev): number[] {
  if (v instanceof UnionV) throw ERR.VALUE
  const out: number[] = []
  for (const row of ev.toArray(v))
    for (const x of row) {
      if (x instanceof FormulaError) throw x
      if (typeof x !== 'number') throw ERR.VALUE
      out.push(x)
    }
  return out
}

const AGG: Record<number, (xs: number[]) => number> = {
  1: (xs) => xs.reduce((s, x) => s + x, 0) / xs.length,
  2: (xs) => xs.length,
  3: (xs) => xs.length,
  4: (xs) => Math.max(...xs),
  5: (xs) => {
    const s = [...xs].sort((a, b) => a - b)
    const h = s.length >> 1
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2
  },
  6: (xs) => Math.min(...xs),
  7: (xs) => xs.reduce((s, x) => s + x, 0),
}

/** a date as a count of months (with the part of the month gone by), for timelines that step by months */
function months(serial: number): number {
  const p = serialToYmd(serial)
  return p.y * 12 + (p.m - 1)
}

/** The values on an even timeline: sorted, those of one time aggregated, the missing times filled in. */
function series(values: Val, timeline: Val, ev: Ev, completion: number, aggregation: number): Series {
  const ys = numbers(values, ev)
  let ts = numbers(timeline, ev)
  if (ys.length !== ts.length) throw ERR.NA
  if (ys.length < 2) throw ERR.NUM
  const agg = AGG[aggregation]
  if (!agg || (completion !== 0 && completion !== 1)) throw ERR.NUM
  // dates a whole number of months apart, on the same day of the month, step by months
  const days = ts.map((t) => serialToYmd(t).d)
  const monthly = ts.every((t) => Number.isInteger(t) && t > 31) && days.every((d) => d === days[0]) && new Set(ts.map(months)).size > 1
  if (monthly) ts = ts.map(months)
  const order = ts.map((_, i) => i).sort((a, b) => ts[a] - ts[b])
  const times: number[] = []
  const groups: number[][] = []
  for (const i of order) {
    if (times.length && ts[i] === times[times.length - 1]) groups[groups.length - 1].push(ys[i])
    else {
      times.push(ts[i])
      groups.push([ys[i]])
    }
  }
  if (times.length < 2) throw ERR.NUM
  let step = Infinity
  for (let i = 1; i < times.length; i++) step = Math.min(step, times[i] - times[i - 1])
  const n = Math.round((times[times.length - 1] - times[0]) / step) + 1
  const y = new Array<number>(n).fill(NaN)
  for (let i = 0; i < times.length; i++) {
    const k = (times[i] - times[0]) / step
    // every time is a whole number of steps from the first
    if (Math.abs(k - Math.round(k)) > 1e-6) throw ERR.NUM
    y[Math.round(k)] = agg(groups[i])
  }
  // up to 30 % of the points may be missing
  const missing = y.filter(Number.isNaN).length
  if (missing > 0.3 * n) throw ERR.NUM
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(y[i])) continue
    if (completion === 0) y[i] = 0
    else {
      // between its neighbours, on the line from one to the other
      const a = i - 1
      let b = i + 1
      while (Number.isNaN(y[b])) b++
      y[i] = y[a] + ((y[b] - y[a]) * (i - a)) / (b - a)
    }
  }
  return { y, t0: times[0], step, monthly, day: days[0] }
}

/** the length of the pattern the values repeat: the lag at which they resemble themselves most; 1 when there is none */
function detect(y: number[]): number {
  const n = y.length
  if (n < 4) return 1
  // without the trend (the line through the values)
  const mx = (n - 1) / 2
  const my = y.reduce((s, v) => s + v, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (i - mx) * (y[i] - my)
    sxx += (i - mx) * (i - mx)
  }
  const slope = sxx ? sxy / sxx : 0
  const r = y.map((v, i) => v - my - slope * (i - mx))
  const var0 = r.reduce((s, v) => s + v * v, 0)
  if (var0 === 0) return 1
  const acf: number[] = [1, 0]
  let best = 0
  for (let k = 2; k <= Math.min(Math.floor(n / 2), 8760); k++) {
    let s = 0
    for (let i = k; i < n; i++) s += r[i] * r[i - k]
    acf[k] = s / var0
    if (acf[k] > best) best = acf[k]
  }
  if (best < 0.3) return 1
  // a pattern shows at its multiples too: the shortest of the lags about as good as the best
  for (let k = 2; k < acf.length; k++) if (acf[k] >= 0.95 * best && acf[k] >= acf[k - 1] && (k + 1 >= acf.length || acf[k] >= acf[k + 1])) return k
  return acf.indexOf(best)
}

interface Fit {
  alpha: number
  beta: number
  gamma: number
  level: number
  trend: number
  season: number[]
  /** one-step-ahead forecasts, for the values from `from` on */
  fitted: number[]
  from: number
  sse: number
}

/** Holt-Winters, additive: the state after the last value and the errors on the way */
function run(y: number[], m: number, alpha: number, beta: number, gamma: number): Fit {
  const n = y.length
  let level: number
  let trend: number
  const season: number[] = []
  let from: number
  if (m > 1) {
    let a = 0
    let b = 0
    for (let i = 0; i < m; i++) {
      a += y[i]
      b += y[m + i]
    }
    // the trend from one cycle to the next; the season: the first cycle without its trend; the level: one step before the first value
    trend = (b - a) / (m * m)
    for (let i = 0; i < m; i++) season.push(y[i] - (a / m + (i - (m - 1) / 2) * trend))
    level = a / m - trend * ((m - 1) / 2 + 1)
    from = 0
  } else {
    level = y[0]
    trend = y[1] - y[0]
    from = 1
  }
  const fitted: number[] = []
  let sse = 0
  for (let t = from; t < n; t++) {
    const s = m > 1 ? season[t % m] : 0
    const f = level + trend + s
    fitted.push(f)
    const e = y[t] - f
    sse += e * e
    const prev = level
    level = alpha * (y[t] - s) + (1 - alpha) * (level + trend)
    trend = beta * (level - prev) + (1 - beta) * trend
    if (m > 1) season[t % m] = gamma * (y[t] - level) + (1 - gamma) * s
  }
  return { alpha, beta, gamma, level, trend, season, fitted, from, sse }
}

/** the smoothing constants with the smallest squared error: a coarse grid, then each refined in turn */
function fit(y: number[], m: number): Fit {
  let best = run(y, m, 0.5, 0.1, 0.1)
  const seasonal = m > 1
  const grid = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95]
  for (const a of grid) for (const b of grid) for (const g of seasonal ? grid : [0]) {
    const f = run(y, m, a, b, g)
    if (f.sse < best.sse) best = f
  }
  for (let d = 0.1; d > 1e-5; d /= 2) {
    let moved = true
    while (moved) {
      moved = false
      for (const key of seasonal ? (['alpha', 'beta', 'gamma'] as const) : (['alpha', 'beta'] as const)) {
        for (const sign of [1, -1]) {
          const p = { alpha: best.alpha, beta: best.beta, gamma: best.gamma }
          p[key] = Math.min(1, Math.max(0, p[key] + sign * d))
          const f = run(y, m, p.alpha, p.beta, p.gamma)
          if (f.sse < best.sse * (1 - 1e-12)) {
            best = f
            moved = true
          }
        }
      }
    }
  }
  return best
}

/** the forecast `h` steps after the last value (h a whole number ≥ 1) */
function ahead(f: Fit, m: number, n: number, h: number): number {
  return f.level + h * f.trend + (m > 1 ? f.season[(n + h - 1) % m] : 0)
}

interface Model {
  s: Series
  m: number
  f: Fit
}

function model(values: Val, timeline: Val, ev: Ev, seasonality: number, completion: number, aggregation: number): Model {
  const s = series(values, timeline, ev, completion, aggregation)
  const k = Math.trunc(seasonality)
  if (k < 0 || k > 8760) throw ERR.NUM
  let m = k === 1 ? detect(s.y) : k
  // a season needs two cycles of values to be told from the trend
  if (m < 2 || s.y.length < 2 * m) m = 1
  return { s, m, f: fit(s.y, m) }
}

/** how many steps after the last value a date is */
function horizon(mod: Model, target: number): number {
  const { s } = mod
  // (on a timeline that steps by months, a day past the timeline's own is that part of a month further)
  const t = s.monthly ? months(target) + (serialToYmd(target).d - s.day) / 30 : target
  const h = (t - (s.t0 + (s.y.length - 1) * s.step)) / s.step
  if (h < 0) throw ERR.NUM
  return h
}

function forecast(mod: Model, h: number): number {
  const n = mod.s.y.length
  if (h === 0) return mod.s.y[n - 1]
  const lo = Math.floor(h)
  const at = (k: number) => (k === 0 ? mod.s.y[n - 1] : ahead(mod.f, mod.m, n, k))
  // between two steps: on the line from one forecast to the next
  return lo === h ? at(lo) : at(lo) + (h - lo) * (at(lo + 1) - at(lo))
}

function errors(mod: Model): { e: number[]; y: number[]; f: number[] } {
  const y = mod.s.y.slice(mod.f.from)
  return { e: y.map((v, i) => v - mod.f.fitted[i]), y, f: mod.f.fitted }
}

function rmse(mod: Model): number {
  const { e } = errors(mod)
  return Math.sqrt(e.reduce((s, x) => s + x * x, 0) / e.length)
}

const arg = (a: Val[], i: number, ev: Ev, def: number): number => (a.length > i && a[i] !== null ? num(scalar(a[i], ev)) : def)

function scalar(v: Val, ev: Ev): Value {
  const x = ev.scalar(v)
  if (x instanceof FormulaError) throw x
  return x
}

const finite = (x: number) => {
  if (!Number.isFinite(x)) throw ERR.NUM
  return x
}

export const FORECAST: Record<string, FnDef> = {
  'FORECAST.ETS': A(3, 6, (a, ev) => {
    const mod = model(a[1], a[2], ev, arg(a, 3, ev, 1), arg(a, 4, ev, 1), arg(a, 5, ev, 1))
    return finite(forecast(mod, horizon(mod, num(scalar(a[0], ev)))))
  }),
  'FORECAST.ETS.CONFINT': A(3, 7, (a, ev) => {
    const level = arg(a, 3, ev, 0.95)
    if (!(level > 0 && level < 1)) throw ERR.NUM
    const mod = model(a[1], a[2], ev, arg(a, 4, ev, 1), arg(a, 5, ev, 1), arg(a, 6, ev, 1))
    const h = Math.max(1, Math.ceil(horizon(mod, num(scalar(a[0], ev)))))
    // the variance of the forecast h steps ahead, from the one-step error and what each step adds to it
    const { alpha, beta, gamma } = mod.f
    let v = 1
    for (let j = 1; j < h; j++) {
      const c = alpha * (1 + j * beta) + (mod.m > 1 && j % mod.m === 0 ? gamma * (1 - alpha) : 0)
      v += c * c
    }
    return finite(normInv(1 - (1 - level) / 2) * rmse(mod) * Math.sqrt(v))
  }),
  'FORECAST.ETS.SEASONALITY': A(2, 4, (a, ev) => {
    const s = series(a[0], a[1], ev, arg(a, 2, ev, 1), arg(a, 3, ev, 1))
    const m = detect(s.y)
    return m < 2 || s.y.length < 2 * m ? 0 : m
  }),
  'FORECAST.ETS.STAT': A(3, 6, (a, ev) => {
    const type = Math.trunc(num(scalar(a[2], ev)))
    if (type < 1 || type > 8) throw ERR.NUM
    const mod = model(a[0], a[1], ev, arg(a, 3, ev, 1), arg(a, 4, ev, 1), arg(a, 5, ev, 1))
    const { e, y, f } = errors(mod)
    const mae = e.reduce((s, x) => s + Math.abs(x), 0) / e.length
    switch (type) {
      case 1:
        return mod.f.alpha
      case 2:
        return mod.f.beta
      case 3:
        return mod.f.gamma
      case 4: {
        // against the forecast that repeats the value one season (or one step) before
        const all = mod.s.y
        const lag = mod.m > 1 ? mod.m : 1
        let d = 0
        for (let i = lag; i < all.length; i++) d += Math.abs(all[i] - all[i - lag])
        d /= all.length - lag
        if (d === 0) throw ERR.DIV0
        return mae / d
      }
      case 5:
        return e.reduce((s, x, i) => s + (Math.abs(y[i]) + Math.abs(f[i]) === 0 ? 0 : (2 * Math.abs(x)) / (Math.abs(y[i]) + Math.abs(f[i]))), 0) / e.length
      case 6:
        return mae
      case 7:
        return rmse(mod)
      default:
        return mod.s.step
    }
  }),
}
