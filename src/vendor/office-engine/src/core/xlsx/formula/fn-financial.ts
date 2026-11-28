/** Financial functions: time value of money, depreciation, securities (day-count bases 0..4 from daycount.ts). */
import { basisDays, yearfrac } from './daycount'
import { daysInMonth, serialToYmd, ymdToSerial } from './dates'
import { A, guard, INF, nums, S, type Ev, type FnDef } from './fn'
import { ERR, FormulaError, type Value } from './types'
import { roundHalf } from './format'
import { bool, int, num, str, type Val } from './values'

// ---------------------------------------------------------------- argument helpers

/** a date argument: whole serial, negative => #NUM! */
const date = (v: Value): number => {
  const n = Math.floor(num(v))
  if (n < 0) throw ERR.NUM
  return n
}

/** optional number: absent or empty argument => d */
const od = (a: Value[], i: number, d: number): number => (a.length > i && a[i] !== null ? num(a[i]) : d)

/** `type` of annuities: any non-zero value counts as 1 */
const typ = (a: Value[], i: number): number => (od(a, i, 0) !== 0 ? 1 : 0)

const need = (ok: boolean): void => {
  if (!ok) throw ERR.NUM
}

const fin = (x: number): number => {
  if (!Number.isFinite(x)) throw ERR.NUM
  return x
}

const freqOf = (v: Value): number => {
  const f = int(v)
  need(f === 1 || f === 2 || f === 4)
  return f
}

const basisOf = (a: Value[], i: number): number => {
  const b = a.length > i && a[i] !== null ? int(a[i]) : 0
  need(b >= 0 && b <= 4)
  return b
}

/** a function over ranges/arrays whose thrown errors become values (IFERROR & co see them) */
const AG = (min: number, max: number, f: (a: Val[], ev: Ev) => Value): FnDef =>
  A(min, max, (a, ev) => guard(() => f(a, ev)))

// ---------------------------------------------------------------- root finding

/**
 * A root of f near `guess` (x > lo): Newton with a numeric slope, and when it strays or stalls a scan outward from
 * lo for a sign change, bisected, taking the bracket nearest the guess. Excel gives #NUM! where this finds none.
 */
function solve(f: (x: number) => number, guess: number, lo: number): number {
  let x = guess
  for (let i = 0; i < 100; i++) {
    const y = f(x)
    if (y === 0) return x
    if (!Number.isFinite(y) || x <= lo) break
    const h = 1e-7 * (1 + Math.abs(x))
    const d = (f(x + h) - f(x - h)) / (2 * h)
    if (!Number.isFinite(d) || d === 0) break
    const nx = x - y / d
    if (!Number.isFinite(nx)) break
    if (Math.abs(nx - x) <= 1e-13 * (1 + Math.abs(nx))) {
      if (nx > lo) return nx
      break
    }
    x = nx
  }
  // bracket: grid of offsets above lo, geometric
  let best: [number, number] | null = null
  let px = NaN
  let py = NaN
  for (let k = -7; k <= 7; k += 0.05) {
    const cx = lo + Math.pow(10, k)
    const cy = f(cx)
    if (Number.isFinite(cy) && Number.isFinite(py) && (py === 0 || cy === 0 || py < 0 !== cy < 0)) {
      const dist = Math.abs((px + cx) / 2 - guess)
      if (!best || dist < Math.abs((best[0] + best[1]) / 2 - guess)) best = [px, cx]
    }
    px = cx
    py = cy
  }
  if (!best) throw ERR.NUM
  let [a, b] = best
  let fa = f(a)
  for (let i = 0; i < 300; i++) {
    const m = (a + b) / 2
    const fm = f(m)
    if (fm === 0 || b - a <= 1e-15 * (1 + Math.abs(m))) return m
    if (fa < 0 !== fm < 0) b = m
    else {
      a = m
      fa = fm
    }
  }
  return (a + b) / 2
}

// ---------------------------------------------------------------- annuities

function fv(r: number, n: number, pmt: number, pv: number, t: number): number {
  if (r === 0) return -(pv + pmt * n)
  const g = Math.pow(1 + r, n)
  return -(pv * g + (pmt * (1 + r * t) * (g - 1)) / r)
}

function pmtOf(r: number, n: number, pv: number, f: number, t: number): number {
  if (n === 0) throw ERR.NUM
  if (r === 0) return -(pv + f) / n
  const g = Math.pow(1 + r, n)
  return -((f + pv * g) * r) / ((1 + r * t) * (g - 1))
}

/** interest part of payment `per` (Excel's convention: with payments at the start, period 1 carries none) */
function ipmtOf(r: number, per: number, n: number, pv: number, f: number, t: number): number {
  const p = pmtOf(r, n, pv, f, t)
  if (t === 1) return per <= 1 ? 0 : (fv(r, per - 2, p, pv, 1) - p) * r
  return fv(r, per - 1, p, pv, 0) * r
}

const ppmtOf = (r: number, per: number, n: number, pv: number, f: number, t: number) =>
  pmtOf(r, n, pv, f, t) - ipmtOf(r, per, n, pv, f, t)

function cum(a: Value[], principal: boolean): number {
  const r = num(a[0])
  const n = int(a[1])
  const pv = num(a[2])
  const s = int(a[3])
  const e = int(a[4])
  const t = int(a[5])
  need(r > 0 && n > 0 && pv > 0 && s >= 1 && e >= s && e <= n && (t === 0 || t === 1))
  let sum = 0
  for (let i = s; i <= e; i++) sum += principal ? ppmtOf(r, i, n, pv, 0, t) : ipmtOf(r, i, n, pv, 0, t)
  return fin(sum)
}

/** IRR-style: sign changes needed, rate > -1 */
function irr(vs: number[], guess: number): number {
  need(vs.some((v) => v > 0) && vs.some((v) => v < 0))
  return solve((r) => vs.reduce((s, v, i) => s + v / Math.pow(1 + r, i), 0), guess, -1)
}

/** values and dates of XNPV / XIRR: same count, none before the first date */
function dated(a: Val[], ev: Ev, vi: number, di: number): [number[], number[]] {
  const vs = ev.toArray(a[vi]).flat().map(num)
  const ds = ev.toArray(a[di]).flat().map(date)
  need(vs.length === ds.length)
  need(ds.every((d) => d >= ds[0]))
  return [vs, ds]
}

// ---------------------------------------------------------------- depreciation

/** DB: declining balance with the rate rounded to 3 decimals, partial first and last year */
function db(cost: number, salv: number, life: number, period: number, month: number): number {
  need(cost >= 0 && salv >= 0 && life > 0 && period > 0 && month >= 1 && month <= 12)
  need(period <= (month < 12 ? life + 1 : life))
  if (cost === 0) return 0
  const rate = Math.round((1 - Math.pow(salv / cost, 1 / life)) * 1000) / 1000
  let total = 0
  let dep = 0
  for (let i = 1; i <= period; i++) {
    if (i === 1) dep = (cost * rate * month) / 12
    else if (i > life) dep = ((cost - total) * rate * (12 - month)) / 12
    else dep = (cost - total) * rate
    total += dep
  }
  return dep
}

/** VDB / DDB core: declining balance over [s, e], switching to straight line over the rest of the life when larger */
function vdb(cost: number, salv: number, life: number, s: number, e: number, f: number, noSwitch: boolean): number {
  let bal = cost
  let total = 0
  for (let i = 0; i < Math.ceil(e); i++) {
    const room = Math.max(bal - salv, 0)
    let dep = Math.min((bal * f) / life, room)
    if (!noSwitch) {
      const rem = life - i
      dep = Math.max(dep, rem > 0 ? Math.min(room / rem, room) : room)
    }
    const lo = Math.max(i, s)
    const hi = Math.min(i + 1, e)
    if (hi > lo) total += dep * (hi - lo)
    bal -= dep
  }
  return total
}

/** shared checks of AMORLINC / AMORDEGRC; `yf` is the first period's year fraction */
function amorArgs(a: Value[]) {
  const cost = num(a[0])
  const bought = date(a[1])
  const first = date(a[2])
  const salv = num(a[3])
  const period = int(a[4])
  const rate = num(a[5])
  const basis = basisOf(a, 6)
  need(basis !== 2 && cost > 0 && salv >= 0 && salv <= cost && period >= 0 && rate > 0 && bought <= first)
  return { cost, salv, period, rate, yf: bought === first ? 0 : yearfrac(bought, first, basis) }
}

// ---------------------------------------------------------------- coupons

/** the coupon date `steps` periods from the anchor; an anchor on a month end stays on month ends */
function addM(anchor: number, steps: number, months: number): number {
  const p = serialToYmd(anchor)
  const eom = p.d === daysInMonth(p.y, p.m)
  const tot = p.y * 12 + p.m - 1 + steps * months
  const y = Math.floor(tot / 12)
  const m = tot - y * 12 + 1
  const dim = daysInMonth(y, m)
  return ymdToSerial(y, m, eom ? dim : Math.min(p.d, dim))
}

/** length of a regular coupon period in days of the basis (the E of the price formulas) */
const normLen = (ps: number, pe: number, f: number, basis: number) =>
  basis === 1 ? pe - ps : basis === 3 ? 365 / f : 360 / f

interface Coup {
  pcd: number
  ncd: number
  /** coupons still to be paid */
  n: number
  /** days from the previous coupon to settlement */
  A: number
  /** days in the coupon period */
  E: number
  /** days from settlement to the next coupon */
  DSC: number
}

/** coupon dates around settlement counted back from maturity */
function coup(s: number, m: number, f: number, basis: number): Coup {
  const months = 12 / f
  const ys = serialToYmd(s)
  const ym = serialToYmd(m)
  let k = Math.max(0, Math.floor(((ym.y - ys.y) * 12 + ym.m - ys.m) / months) - 1)
  while (addM(m, -k, months) > s) k++
  while (k > 0 && addM(m, -(k - 1), months) <= s) k--
  const pcd = addM(m, -k, months)
  const ncd = addM(m, -(k - 1), months)
  const E = normLen(pcd, ncd, f, basis)
  const A = basisDays(pcd, s, basis)
  // 30/360 counts the rest of the period from its length, the others by the calendar
  const DSC = basis === 0 || basis === 4 ? E - A : ncd - s
  return { pcd, ncd, n: k, A, E, DSC }
}

/** common head of the COUP* functions */
function coupArgs(a: Value[]): Coup {
  const s = date(a[0])
  const m = date(a[1])
  const f = freqOf(a[2])
  const b = basisOf(a, 3)
  need(s < m)
  return coup(s, m, f, b)
}

/** PRICE per 100 for a security with regular coupons */
function priceOf(c: Coup, rate: number, yld: number, red: number, f: number): number {
  const cpn = (100 * rate) / f
  const frac = c.DSC / c.E
  if (c.n === 1) return (red + cpn) / (1 + (frac * yld) / f) - (cpn * c.A) / c.E
  const g = 1 + yld / f
  let p = red / Math.pow(g, c.n - 1 + frac)
  for (let k = 1; k <= c.n; k++) p += cpn / Math.pow(g, k - 1 + frac)
  return p - (cpn * c.A) / c.E
}

function durationOf(c: Coup, coupon: number, yld: number, f: number): number {
  const cpn = (100 * coupon) / f
  const g = 1 + yld / f
  const frac = c.DSC / c.E
  let pv = 0
  let w = 0
  for (let k = 1; k <= c.n; k++) {
    const t = k - 1 + frac
    const d = (cpn + (k === c.n ? 100 : 0)) / Math.pow(g, t)
    pv += d
    w += (d * t) / f
  }
  return w / pv
}

/**
 * Sum over the regular coupon periods (a lattice through `anchor`) of the days of [a, b] inside each, over that
 * period's normal length: the A/NL, DC/NL terms of the odd-period formulas.
 */
function quasi(a: number, b: number, anchor: number, f: number, basis: number): number {
  if (b <= a) return 0
  const months = 12 / f
  const ya = serialToYmd(a)
  const yn = serialToYmd(anchor)
  let k = Math.floor(((ya.y - yn.y) * 12 + ya.m - yn.m) / months) - 1
  while (addM(anchor, k + 1, months) <= a) k++
  while (addM(anchor, k, months) > a) k--
  let tot = 0
  for (;; k++) {
    const ps = addM(anchor, k, months)
    const pe = addM(anchor, k + 1, months)
    const lo = Math.max(ps, a)
    const hi = Math.min(pe, b)
    if (hi > lo) tot += basisDays(lo, hi, basis) / normLen(ps, pe, f, basis)
    if (pe >= b) break
  }
  return tot
}

interface OddF {
  s: number
  m: number
  iss: number
  fc: number
  rate: number
  red: number
  f: number
  b: number
}

/** ODDFPRICE: coupons counted back from the first coupon; the odd first period is paid in proportion */
function oddfPrice(o: OddF, yld: number): number {
  const months = 12 / o.f
  const g = 1 + yld / o.f
  const cpn = (100 * o.rate) / o.f
  const yf = serialToYmd(o.fc)
  const ym = serialToYmd(o.m)
  // regular coupons after the first one
  const N = Math.max(1, Math.ceil(((ym.y - yf.y) * 12 + ym.m - yf.m) / months - 1e-9))
  let js = 1
  while (addM(o.fc, -js, months) > o.s) js++
  const qs = addM(o.fc, -js, months)
  const qn = addM(o.fc, -(js - 1), months)
  const E = normLen(qs, qn, o.f, o.b)
  const As = basisDays(qs, o.s, o.b)
  const DSC = o.b === 0 || o.b === 4 ? E - As : qn - o.s
  const t1 = js - 1 + DSC / E
  let p = o.red / Math.pow(g, N + t1) + (cpn * quasi(o.iss, o.fc, o.fc, o.f, o.b)) / Math.pow(g, t1)
  for (let k = 1; k <= N; k++) p += cpn / Math.pow(g, k + t1)
  return p - cpn * quasi(o.iss, o.s, o.fc, o.f, o.b)
}

function oddfArgs(a: Value[]) {
  const s = date(a[0])
  const m = date(a[1])
  const iss = date(a[2])
  const fc = date(a[3])
  const rate = num(a[4])
  const y = num(a[5])
  const red = num(a[6])
  const f = freqOf(a[7])
  const b = basisOf(a, 8)
  need(rate >= 0 && red > 0 && m > fc && fc > s && s > iss)
  const o: OddF = { s, m, iss, fc, rate, red, f, b }
  return { o, y }
}

/** ODDLPRICE / ODDLYIELD pieces: the last coupon period is paid in proportion, all discounted at once */
function oddlParts(s: number, m: number, li: number, f: number, b: number) {
  return {
    full: quasi(li, m, li, f, b),
    toSettle: quasi(li, s, li, f, b),
    rest: quasi(s, m, li, f, b),
  }
}

// ---------------------------------------------------------------- security helpers

/** year fraction with a sign (an issue date may follow the settlement) */
const yf = (x: number, y: number, b: number) => (x <= y ? yearfrac(x, y, b) : -yearfrac(y, x, b))

/** head of the discount-security functions: settlement < maturity, basis */
function discArgs(a: Value[]) {
  const s = date(a[0])
  const m = date(a[1])
  const x = num(a[2])
  const y = num(a[3])
  const b = basisOf(a, 4)
  need(s < m && x > 0 && y > 0)
  return { x, y, f: yearfrac(s, m, b) }
}

/** T-bill head: days to maturity, at most a year */
function tbill(a: Value[]): number {
  const s = date(a[0])
  const m = date(a[1])
  const p = serialToYmd(s)
  need(s < m && m <= ymdToSerial(p.y + 1, p.m, Math.min(p.d, daysInMonth(p.y + 1, p.m))))
  return m - s
}

export const FINANCIAL: Record<string, FnDef> = {
  // ---- annuities
  FV: S(3, 5, (a) => fin(fv(num(a[0]), num(a[1]), num(a[2]), od(a, 3, 0), typ(a, 4)))),
  PV: S(3, 5, (a) => {
    const [r, n, p] = [num(a[0]), num(a[1]), num(a[2])]
    const f = od(a, 3, 0)
    const t = typ(a, 4)
    if (r === 0) return fin(-(f + p * n))
    const g = Math.pow(1 + r, n)
    return fin(-(f + (p * (1 + r * t) * (g - 1)) / r) / g)
  }),
  PMT: S(3, 5, (a) => fin(pmtOf(num(a[0]), num(a[1]), num(a[2]), od(a, 3, 0), typ(a, 4)))),
  NPER: S(3, 5, (a) => {
    const [r, p, pv] = [num(a[0]), num(a[1]), num(a[2])]
    const f = od(a, 3, 0)
    const t = typ(a, 4)
    if (r === 0) {
      need(p !== 0)
      return fin(-(pv + f) / p)
    }
    const z = (p * (1 + r * t)) / r
    return fin(Math.log((z - f) / (z + pv)) / Math.log(1 + r))
  }),
  RATE: S(3, 6, (a) => {
    const [n, p, pv] = [num(a[0]), num(a[1]), num(a[2])]
    const f = od(a, 3, 0)
    const t = typ(a, 4)
    need(n > 0)
    const g = (r: number) =>
      r === 0 ? pv + p * n + f : pv * Math.pow(1 + r, n) + (p * (1 + r * t) * (Math.pow(1 + r, n) - 1)) / r + f
    return fin(solve(g, od(a, 5, 0.1), -1))
  }),
  IPMT: S(4, 6, (a) => {
    const [r, per, n] = [num(a[0]), num(a[1]), num(a[2])]
    need(per >= 1 && per <= n)
    return fin(ipmtOf(r, per, n, num(a[3]), od(a, 4, 0), typ(a, 5)))
  }),
  PPMT: S(4, 6, (a) => {
    const [r, per, n] = [num(a[0]), num(a[1]), num(a[2])]
    need(per >= 1 && per <= n)
    return fin(ppmtOf(r, per, n, num(a[3]), od(a, 4, 0), typ(a, 5)))
  }),
  ISPMT: S(4, 4, (a) => {
    const [r, per, n, pv] = [num(a[0]), num(a[1]), num(a[2]), num(a[3])]
    if (n === 0) throw ERR.DIV0
    return fin(pv * r * (per / n - 1))
  }),
  CUMIPMT: S(6, 6, (a) => cum(a, false)),
  CUMPRINC: S(6, 6, (a) => cum(a, true)),
  NPV: AG(2, INF, (a, ev) => {
    const r = num(ev.scalar(a[0]))
    if (r === -1) throw ERR.DIV0
    const vs = nums(a.slice(1), ev)
    return fin(vs.reduce((s, v, i) => s + v / Math.pow(1 + r, i + 1), 0))
  }),
  IRR: AG(1, 2, (a, ev) => {
    const g = a.length > 1 ? ev.scalar(a[1]) : null
    return fin(irr(nums([a[0]], ev), g === null ? 0.1 : num(g)))
  }),
  MIRR: AG(3, 3, (a, ev) => {
    const vs = nums([a[0]], ev)
    const fr = num(ev.scalar(a[1]))
    const rr = num(ev.scalar(a[2]))
    const n = vs.length
    if (!vs.some((v) => v > 0) || !vs.some((v) => v < 0)) throw ERR.DIV0
    let pos = 0
    let neg = 0
    vs.forEach((v, i) => {
      if (v > 0) pos += v * Math.pow(1 + rr, n - 1 - i)
      else neg += v / Math.pow(1 + fr, i)
    })
    return fin(Math.pow(pos / -neg, 1 / (n - 1)) - 1)
  }),
  XNPV: AG(3, 3, (a, ev) => {
    const r = num(ev.scalar(a[0]))
    const [vs, ds] = dated(a, ev, 1, 2)
    need(r > -1)
    return fin(vs.reduce((s, v, i) => s + v / Math.pow(1 + r, (ds[i] - ds[0]) / 365), 0))
  }),
  XIRR: AG(2, 3, (a, ev) => {
    const [vs, ds] = dated(a, ev, 0, 1)
    const g = a.length > 2 ? ev.scalar(a[2]) : null
    need(vs.some((v) => v > 0) && vs.some((v) => v < 0))
    const f = (r: number) => vs.reduce((s, v, i) => s + v / Math.pow(1 + r, (ds[i] - ds[0]) / 365), 0)
    return fin(solve(f, g === null ? 0.1 : num(g), -1))
  }),
  FVSCHEDULE: AG(2, 2, (a, ev) => {
    let p = num(ev.scalar(a[0]))
    for (const v of ev.toArray(a[1]).flat()) {
      if (v instanceof FormulaError) throw v
      if (v === null) continue
      if (typeof v !== 'number') throw ERR.VALUE
      p *= 1 + v
    }
    return fin(p)
  }),
  EFFECT: S(2, 2, ([r, n]) => {
    const [nom, p] = [num(r), int(n)]
    need(nom > 0 && p >= 1)
    return fin(Math.pow(1 + nom / p, p) - 1)
  }),
  NOMINAL: S(2, 2, ([r, n]) => {
    const [eff, p] = [num(r), int(n)]
    need(eff > 0 && p >= 1)
    return fin(p * (Math.pow(1 + eff, 1 / p) - 1))
  }),
  RRI: S(3, 3, ([n, pv, f]) => {
    const [np, p, fu] = [num(n), num(pv), num(f)]
    need(np > 0 && p !== 0)
    return fin(Math.pow(fu / p, 1 / np) - 1)
  }),
  PDURATION: S(3, 3, ([r, pv, f]) => {
    const [rate, p, fu] = [num(r), num(pv), num(f)]
    need(rate > 0 && p > 0 && fu > 0)
    return fin((Math.log(fu) - Math.log(p)) / Math.log(1 + rate))
  }),
  DOLLARDE: S(2, 2, ([d, f]) => {
    const x = num(d)
    const fr = int(f)
    need(fr >= 0)
    if (fr === 0) throw ERR.DIV0
    const whole = Math.trunc(x)
    const digits = Math.ceil(Math.log10(fr))
    return Number((whole + ((x - whole) * Math.pow(10, digits)) / fr).toPrecision(15))
  }),
  DOLLARFR: S(2, 2, ([d, f]) => {
    const x = num(d)
    const fr = int(f)
    need(fr >= 0)
    if (fr === 0) throw ERR.DIV0
    const whole = Math.trunc(x)
    const digits = Math.ceil(Math.log10(fr))
    return Number((whole + ((x - whole) * fr) / Math.pow(10, digits)).toPrecision(15))
  }),

  // ---- depreciation
  SLN: S(3, 3, ([c, s, l]) => {
    const life = num(l)
    if (life === 0) throw ERR.DIV0
    return fin((num(c) - num(s)) / life)
  }),
  SYD: S(4, 4, ([c, s, l, p]) => {
    const [cost, salv, life, per] = [num(c), num(s), num(l), num(p)]
    need(life > 0 && per > 0 && per <= life)
    return fin(((cost - salv) * (life - per + 1) * 2) / (life * (life + 1)))
  }),
  DB: S(4, 5, (a) => fin(db(num(a[0]), num(a[1]), num(a[2]), Math.trunc(num(a[3])), Math.trunc(od(a, 4, 12))))),
  DDB: S(4, 5, (a) => {
    const [cost, salv, life, per] = [num(a[0]), num(a[1]), num(a[2]), num(a[3])]
    const f = od(a, 4, 2)
    need(cost >= 0 && salv >= 0 && life > 0 && per > 0 && per <= life && f > 0)
    return fin(vdb(cost, salv, life, per - 1, per, f, true))
  }),
  VDB: S(5, 7, (a) => {
    const [cost, salv, life, s, e] = [num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4])]
    const f = od(a, 5, 2)
    const ns = a.length > 6 && a[6] !== null ? bool(a[6]) : false
    need(cost >= 0 && salv >= 0 && life > 0 && s >= 0 && e >= s && e <= life && f >= 0)
    return fin(vdb(cost, salv, life, s, e, f, ns))
  }),
  AMORLINC: S(6, 7, (a) => {
    const { cost, salv, period, rate, yf: y0 } = amorArgs(a)
    const one = cost * rate
    const first = y0 * rate * cost
    const full = Math.floor((cost - salv - first) / one)
    if (period === 0) return first
    if (period <= full) return one
    if (period === full + 1) return cost - salv - one * full - first
    return 0
  }),
  AMORDEGRC: S(6, 7, (a) => {
    const { cost, salv, period, rate, yf: y0 } = amorArgs(a)
    const life = 1 / rate
    // Microsoft: lives of 0-3 and 4-5 years have no coefficient
    need(life >= 3 && !(life > 4 && life < 5))
    const k = life <= 4 ? 1.5 : life <= 6 ? 2 : 2.5
    const r = rate * k
    let c = cost
    let dep = Math.floor(y0 * r * c + 0.5)
    c -= dep
    let rest = c - salv
    for (let n = 0; n < period; n++) {
      dep = Math.floor(r * c + 0.5)
      rest -= dep
      if (rest < 0) return period - n <= 1 ? Math.floor(c * 0.5 + 0.5) : 0
      c -= dep
    }
    return dep
  }),

  // ---- coupons
  COUPDAYBS: S(3, 4, (a) => coupArgs(a).A),
  COUPDAYS: S(3, 4, (a) => coupArgs(a).E),
  COUPDAYSNC: S(3, 4, (a) => coupArgs(a).DSC),
  COUPNCD: S(3, 4, (a) => coupArgs(a).ncd),
  COUPPCD: S(3, 4, (a) => coupArgs(a).pcd),
  COUPNUM: S(3, 4, (a) => coupArgs(a).n),

  // ---- securities with periodic interest
  PRICE: S(6, 7, (a) => {
    const [s, m, rate, yld, red] = [date(a[0]), date(a[1]), num(a[2]), num(a[3]), num(a[4])]
    const f = freqOf(a[5])
    const b = basisOf(a, 6)
    need(yld >= 0 && rate >= 0 && red > 0 && s < m)
    return fin(priceOf(coup(s, m, f, b), rate, yld, red, f))
  }),
  YIELD: S(6, 7, (a) => {
    const [s, m, rate, pr, red] = [date(a[0]), date(a[1]), num(a[2]), num(a[3]), num(a[4])]
    const f = freqOf(a[5])
    const b = basisOf(a, 6)
    need(rate >= 0 && pr > 0 && red > 0 && s < m)
    const c = coup(s, m, f, b)
    if (c.n === 1) {
      const acc = pr / 100 + ((c.A / c.E) * rate) / f
      return fin((((red / 100 + rate / f - acc) / acc) * f * c.E) / c.DSC)
    }
    return fin(solve((y) => priceOf(c, rate, y, red, f) - pr, rate > 0 ? rate : 0.05, -f))
  }),
  DURATION: S(5, 6, (a) => {
    const [s, m, cp, yld] = [date(a[0]), date(a[1]), num(a[2]), num(a[3])]
    const f = freqOf(a[4])
    const b = basisOf(a, 5)
    need(cp >= 0 && yld >= 0 && s < m)
    return fin(durationOf(coup(s, m, f, b), cp, yld, f))
  }),
  MDURATION: S(5, 6, (a) => {
    const [s, m, cp, yld] = [date(a[0]), date(a[1]), num(a[2]), num(a[3])]
    const f = freqOf(a[4])
    const b = basisOf(a, 5)
    need(cp >= 0 && yld >= 0 && s < m)
    return fin(durationOf(coup(s, m, f, b), cp, yld, f) / (1 + yld / f))
  }),

  // ---- odd first / last period
  ODDFPRICE: S(8, 9, (a) => {
    const { o, y } = oddfArgs(a)
    need(y >= 0)
    return fin(oddfPrice(o, y))
  }),
  ODDFYIELD: S(8, 9, (a) => {
    const { o, y: pr } = oddfArgs(a)
    need(pr > 0)
    return fin(solve((y) => oddfPrice(o, y) - pr, o.rate > 0 ? o.rate : 0.05, -o.f))
  }),
  ODDLPRICE: S(7, 8, (a) => {
    const [s, m, li, rate, yld, red] = [date(a[0]), date(a[1]), date(a[2]), num(a[3]), num(a[4]), num(a[5])]
    const f = freqOf(a[6])
    const b = basisOf(a, 7)
    need(rate >= 0 && yld >= 0 && red > 0 && m > s && s > li)
    const c = (100 * rate) / f
    const q = oddlParts(s, m, li, f, b)
    return fin((red + c * q.full) / (1 + (q.rest * yld) / f) - c * q.toSettle)
  }),
  ODDLYIELD: S(7, 8, (a) => {
    const [s, m, li, rate, pr, red] = [date(a[0]), date(a[1]), date(a[2]), num(a[3]), num(a[4]), num(a[5])]
    const f = freqOf(a[6])
    const b = basisOf(a, 7)
    need(rate >= 0 && pr > 0 && red > 0 && m > s && s > li)
    const c = (100 * rate) / f
    const q = oddlParts(s, m, li, f, b)
    const dirty = pr + c * q.toSettle
    return fin((((red + c * q.full - dirty) / dirty) * f) / q.rest)
  }),

  // ---- securities at maturity / discount
  ACCRINT: S(6, 8, (a) => {
    const [iss, first, s, rate] = [date(a[0]), date(a[1]), date(a[2]), num(a[3])]
    const par = a[4] === null ? 1000 : num(a[4])
    const f = freqOf(a[5])
    const b = basisOf(a, 6)
    const calc = a.length > 7 && a[7] !== null ? bool(a[7]) : true
    need(rate > 0 && par > 0 && iss < s)
    // FALSE counts from the first interest date, once settlement is past it
    const from = !calc && s > first ? first : iss
    return fin(((par * rate) / f) * quasi(from, s, first, f, b))
  }),
  ACCRINTM: S(4, 5, (a) => {
    const [iss, s, rate] = [date(a[0]), date(a[1]), num(a[2])]
    const par = a[3] === null ? 1000 : num(a[3])
    const b = basisOf(a, 4)
    need(rate > 0 && par > 0 && iss < s)
    return fin(par * rate * yearfrac(iss, s, b))
  }),
  DISC: S(4, 5, (a) => {
    const { x, y, f } = discArgs(a)
    return fin((y - x) / y / f)
  }),
  PRICEDISC: S(4, 5, (a) => {
    const { x, y, f } = discArgs(a)
    return fin(y - x * y * f)
  }),
  YIELDDISC: S(4, 5, (a) => {
    const { x, y, f } = discArgs(a)
    return fin((y - x) / x / f)
  }),
  INTRATE: S(4, 5, (a) => {
    const { x, y, f } = discArgs(a)
    return fin((y - x) / x / f)
  }),
  RECEIVED: S(4, 5, (a) => {
    const { x, y, f } = discArgs(a)
    return fin(x / (1 - y * f))
  }),
  PRICEMAT: S(5, 6, (a) => {
    const [s, m, iss, rate, yld] = [date(a[0]), date(a[1]), date(a[2]), num(a[3]), num(a[4])]
    const b = basisOf(a, 5)
    need(rate >= 0 && yld >= 0 && s < m)
    return fin((100 + yf(iss, m, b) * rate * 100) / (1 + yearfrac(s, m, b) * yld) - yf(iss, s, b) * rate * 100)
  }),
  YIELDMAT: S(5, 6, (a) => {
    const [s, m, iss, rate, pr] = [date(a[0]), date(a[1]), date(a[2]), num(a[3]), num(a[4])]
    const b = basisOf(a, 5)
    need(rate >= 0 && pr > 0 && s < m)
    const dirty = pr / 100 + yf(iss, s, b) * rate
    return fin((1 + yf(iss, m, b) * rate - dirty) / dirty / yearfrac(s, m, b))
  }),
  TBILLPRICE: S(3, 3, (a) => {
    const d = num(a[2])
    const days = tbill(a)
    need(d > 0)
    const p = 100 * (1 - (d * days) / 360)
    need(p > 0)
    return p
  }),
  TBILLYIELD: S(3, 3, (a) => {
    const pr = num(a[2])
    const days = tbill(a)
    need(pr > 0)
    return fin((((100 - pr) / pr) * 360) / days)
  }),
  TBILLEQ: S(3, 3, (a) => {
    const d = num(a[2])
    const days = tbill(a)
    need(d > 0)
    if (days <= 182) {
      need(360 - d * days > 0)
      return fin((365 * d) / (360 - d * days))
    }
    // more than half a year: the bond-equivalent yield solves a quadratic
    const p = 100 * (1 - (d * days) / 360)
    need(p > 0)
    const t = days / 365
    return fin((-t + Math.sqrt(t * t - (2 * t - 1) * (1 - 100 / p))) / (t - 0.5))
  }),
  EUROCONVERT: S(3, 5, (a) => {
    const n = num(a[0])
    const from = EURO[str(a[1]).toUpperCase()]
    const to = EURO[str(a[2]).toUpperCase()]
    const full = a.length > 3 && a[3] !== null ? bool(a[3]) : false
    const tri = a.length > 4 && a[4] !== null ? int(a[4]) : undefined
    if (!from || !to || (tri !== undefined && tri < 3)) throw ERR.VALUE
    if (from === to) return n
    // through the euro: the amount in euros (rounded when asked), then in the currency asked
    let euro = n / from[0]
    if (tri !== undefined && from[0] !== 1) euro = roundHalf(euro, tri)
    const res = euro * to[0]
    return fin(full ? res : roundHalf(res, to[1]))
  }),
}

/** the currencies the euro replaced: how many make one euro (the rates the EU fixed), and the decimals an amount is computed to */
const EURO: Record<string, [number, number]> = {
  BEF: [40.3399, 0],
  LUF: [40.3399, 0],
  DEM: [1.95583, 2],
  ESP: [166.386, 0],
  FRF: [6.55957, 2],
  IEP: [0.787564, 2],
  ITL: [1936.27, 0],
  NLG: [2.20371, 2],
  ATS: [13.7603, 2],
  PTE: [200.482, 0],
  FIM: [5.94573, 2],
  GRD: [340.75, 0],
  SIT: [239.64, 2],
  EUR: [1, 2],
}
