/** Statistical distributions and their tests: normal, t, chi-square, F, beta, gamma, and the discrete ones. */
import { A, INF, nums, opt, S, type Ev, type FnDef } from './fn'
import { betaI, choose, erf, factorial, gamma, gammaln, gammaP, gammaQ, invert, lnBeta, lnChoose, normCdf, normInv, normPdf } from './special'
import { ERR, type Value } from './types'
import { bool, int, num, type Val } from './values'

/** A result that is not a finite number is out of range (overflow, 0/0 at an edge): #NUM! */
function fin(x: number): number {
  if (!Number.isFinite(x)) throw ERR.NUM
  return x
}

/** a scalar function returning a number */
const N = (min: number, max: number, f: (a: Value[]) => number): FnDef => S(min, max, (a) => fin(f(a)))

/** degrees of freedom: truncated, at least 1 (and below 1e10 where `strict`, as the compatibility F functions say) */
function df(v: Value, strict = false): number {
  const d = int(v)
  if (d < 1 || d > 1e10 || (strict && d === 1e10)) throw ERR.NUM
  return d
}

/** a probability: [0, 1], or open at either end */
function prob(p: number, openLow: boolean, openHigh: boolean): number {
  if (p < 0 || p > 1 || (openLow && p === 0) || (openHigh && p === 1)) throw ERR.NUM
  return p
}

/**
 * The x in [lo, hi] where the cdf is p (or, with `right`, where the survival function is p). The smaller of the
 * two tails is solved, so a probability near 0 or 1 keeps its digits.
 */
function invCdf(cdf: (x: number) => number, sf: (x: number) => number, p: number, right: boolean, lo: number, hi: number): number {
  const left = right ? p > 0.5 : p <= 0.5
  const q = left ? (right ? 1 - p : p) : right ? p : 1 - p
  return left ? invert(cdf, q, lo, hi) : invert((x) => -sf(x), -q, lo, hi)
}

// ---------------------------------------------------------------- normal

function normDist(x: number, mean: number, sd: number, cum: boolean): number {
  if (sd <= 0) throw ERR.NUM
  const z = (x - mean) / sd
  return cum ? normCdf(z) : normPdf(z) / sd
}

function normInvScaled(p: number, mean: number, sd: number): number {
  prob(p, true, true)
  if (sd <= 0) throw ERR.NUM
  return mean + sd * normInv(p)
}

function lognormDist(x: number, mean: number, sd: number, cum: boolean): number {
  if (x <= 0 || sd <= 0) throw ERR.NUM
  const z = (Math.log(x) - mean) / sd
  return cum ? normCdf(z) : normPdf(z) / (x * sd)
}

function lognormInv(p: number, mean: number, sd: number): number {
  prob(p, true, true)
  if (sd <= 0) throw ERR.NUM
  return Math.exp(mean + sd * normInv(p))
}

function confidenceNorm(alpha: number, sd: number, size: number): number {
  prob(alpha, true, true)
  if (sd <= 0) throw ERR.NUM
  if (size < 1) throw ERR.NUM
  return (-normInv(alpha / 2) * sd) / Math.sqrt(size)
}

// ---------------------------------------------------------------- Student t

/** P(|T| > t) for t >= 0 */
function tTwoTail(t: number, v: number): number {
  return betaI(v / (v + t * t), v / 2, 0.5)
}

/** P(T > t) */
function tRight(t: number, v: number): number {
  const tail = tTwoTail(Math.abs(t), v) / 2
  return t >= 0 ? tail : 1 - tail
}

function tCdf(t: number, v: number): number {
  return tRight(-t, v)
}

function tPdf(t: number, v: number): number {
  return Math.exp(gammaln((v + 1) / 2) - gammaln(v / 2) - 0.5 * Math.log(v * Math.PI) - ((v + 1) / 2) * Math.log1p((t * t) / v))
}

/** the t >= 0 with a two-tailed probability q, 0 < q <= 1 */
function tInv2(q: number, v: number): number {
  if (q === 1) return 0
  return invert((t) => -tTwoTail(t, v), -q, 0, INF)
}

function tInv(p: number, v: number): number {
  prob(p, true, true)
  if (p === 0.5) return 0
  const t = tInv2(2 * Math.min(p, 1 - p), v)
  return p < 0.5 ? -t : t
}

function tInv2T(p: number, v: number): number {
  if (p <= 0 || p > 1) throw ERR.NUM
  return tInv2(p, v)
}

/** TDIST(x, df, tails): x must be >= 0 */
function tOld(x: number, v: number, tails: number): number {
  if (tails !== 1 && tails !== 2) throw ERR.NUM
  if (x < 0) throw ERR.NUM
  const two = tTwoTail(x, v)
  return tails === 1 ? two / 2 : two
}

// ---------------------------------------------------------------- chi-square

const chiCdf = (x: number, k: number) => gammaP(k / 2, x / 2)
const chiSf = (x: number, k: number) => gammaQ(k / 2, x / 2)

function chiPdf(x: number, k: number): number {
  const a = k / 2
  if (x === 0) return k < 2 ? INF : k === 2 ? 0.5 : 0
  return Math.exp((a - 1) * Math.log(x) - x / 2 - a * Math.LN2 - gammaln(a))
}

function chiInv(p: number, k: number, right: boolean): number {
  prob(p, false, false)
  if (right ? p === 0 : p === 1) throw ERR.NUM
  if (right ? p === 1 : p === 0) return 0
  return invCdf((x) => chiCdf(x, k), (x) => chiSf(x, k), p, right, 0, INF)
}

// ---------------------------------------------------------------- F

const fCdf = (x: number, d1: number, d2: number) => betaI((d1 * x) / (d1 * x + d2), d1 / 2, d2 / 2)
const fSf = (x: number, d1: number, d2: number) => betaI(d2 / (d2 + d1 * x), d2 / 2, d1 / 2)

function fPdf(x: number, d1: number, d2: number): number {
  if (x === 0) return d1 < 2 ? INF : d1 === 2 ? 1 : 0
  return Math.exp((d1 / 2) * Math.log(d1) + (d2 / 2) * Math.log(d2) + (d1 / 2 - 1) * Math.log(x) - ((d1 + d2) / 2) * Math.log(d2 + d1 * x) - lnBeta(d1 / 2, d2 / 2))
}

function fInv(p: number, d1: number, d2: number, right: boolean): number {
  prob(p, false, false)
  if (right ? p === 0 : p === 1) throw ERR.NUM
  if (right ? p === 1 : p === 0) return 0
  return invCdf((x) => fCdf(x, d1, d2), (x) => fSf(x, d1, d2), p, right, 0, INF)
}

// ---------------------------------------------------------------- beta, gamma

function betaPdf(t: number, a: number, b: number): number {
  if (t === 0) return a < 1 ? INF : a === 1 ? b : 0
  if (t === 1) return b < 1 ? INF : b === 1 ? a : 0
  return Math.exp((a - 1) * Math.log(t) + (b - 1) * Math.log1p(-t) - lnBeta(a, b))
}

/** BETA.DIST / BETADIST on [A, B] */
function betaDist(x: number, a: number, b: number, cum: boolean, A_: number, B_: number): number {
  if (a <= 0 || b <= 0) throw ERR.NUM
  if (x < A_ || x > B_ || A_ === B_) throw ERR.NUM
  const t = (x - A_) / (B_ - A_)
  return cum ? betaI(t, a, b) : betaPdf(t, a, b) / (B_ - A_)
}

function betaInv(p: number, a: number, b: number, A_: number, B_: number): number {
  if (a <= 0 || b <= 0) throw ERR.NUM
  if (p <= 0 || p > 1) throw ERR.NUM
  if (A_ >= B_) throw ERR.NUM
  if (p === 1) return B_
  const t = invCdf((x) => betaI(x, a, b), (x) => betaI(1 - x, b, a), p, false, 0, 1)
  return A_ + t * (B_ - A_)
}

function gammaDist(x: number, a: number, b: number, cum: boolean): number {
  if (x < 0) throw ERR.NUM
  if (a <= 0 || b <= 0) throw ERR.NUM
  if (cum) return gammaP(a, x / b)
  if (x === 0) return a < 1 ? INF : a === 1 ? 1 / b : 0
  return Math.exp((a - 1) * Math.log(x) - x / b - a * Math.log(b) - gammaln(a))
}

function gammaInv(p: number, a: number, b: number): number {
  prob(p, false, false)
  if (a <= 0 || b <= 0) throw ERR.NUM
  if (p === 1) throw ERR.NUM
  if (p === 0) return 0
  return b * invCdf((x) => gammaP(a, x), (x) => gammaQ(a, x), p, false, 0, INF)
}

/** Γ(x): undefined at 0 and the negative integers */
function gammaFn(x: number): number {
  if (x <= 0 && Number.isInteger(x)) throw ERR.NUM
  return gamma(x)
}

function gammaLn(x: number): number {
  if (x <= 0) throw ERR.NUM
  return gammaln(x)
}

// ---------------------------------------------------------------- discrete

function binomPmf(k: number, n: number, p: number): number {
  if (p === 0) return k === 0 ? 1 : 0
  if (p === 1) return k === n ? 1 : 0
  if (n <= 100) {
    const r = choose(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k)
    if (r > 0) return r
  }
  return Math.exp(lnChoose(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p))
}

function binomCdf(k: number, n: number, p: number): number {
  if (k >= n || p === 0) return 1
  if (p === 1) return 0
  // the direct form where the cdf is the small side, the complement where it is the large one
  return k < n * p ? betaI(1 - p, n - k, k + 1) : 1 - betaI(p, k + 1, n - k)
}

function binomDist(k: number, n: number, p: number, cum: boolean): number {
  if (n < 0 || k < 0 || k > n) throw ERR.NUM
  if (p < 0 || p > 1) throw ERR.NUM
  return cum ? binomCdf(k, n, p) : binomPmf(k, n, p)
}

function binomRange(n: number, p: number, s: number, s2: number | undefined): number {
  if (n < 0 || p < 0 || p > 1 || s < 0 || s > n) throw ERR.NUM
  if (s2 === undefined) return binomPmf(s, n, p)
  if (s2 < s || s2 > n) throw ERR.NUM
  if (s2 - s > 1e6) return binomCdf(s2, n, p) - (s > 0 ? binomCdf(s - 1, n, p) : 0)
  let sum = 0
  for (let k = s; k <= s2; k++) sum += binomPmf(k, n, p)
  return Math.min(sum, 1)
}

/** smallest k whose cumulative binomial probability reaches alpha */
function binomInv(n: number, p: number, alpha: number): number {
  if (n < 0 || p <= 0 || p >= 1 || alpha <= 0 || alpha >= 1) throw ERR.NUM
  // a hair of slack: an alpha that is exactly a cdf value (rounded by the series) still hits that k
  const target = alpha * (1 - 1e-14)
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (binomCdf(mid, n, p) >= target) hi = mid
    else lo = mid + 1
  }
  return lo
}

function hypgeomPmf(x: number, n: number, K: number, M: number): number {
  // exact products while the binomials fit a number, logarithms past that
  if (M <= 500) return (choose(K, x) * choose(M - K, n - x)) / choose(M, n)
  return Math.exp(lnChoose(K, x) + lnChoose(M - K, n - x) - lnChoose(M, n))
}

function hypgeomDist(x: number, n: number, K: number, M: number, cum: boolean): number {
  if (x < 0 || x > Math.min(n, K)) throw ERR.NUM
  if (x < Math.max(0, n - M + K)) throw ERR.NUM
  if (n <= 0 || n > M) throw ERR.NUM
  if (K <= 0 || K > M || M <= 0) throw ERR.NUM
  if (!cum) return hypgeomPmf(x, n, K, M)
  let sum = 0
  for (let k = Math.max(0, n - M + K); k <= x; k++) sum += hypgeomPmf(k, n, K, M)
  return Math.min(sum, 1)
}

function negbinomDist(f: number, s: number, p: number, cum: boolean): number {
  if (p < 0 || p > 1) throw ERR.NUM
  if (f < 0 || s < 1) throw ERR.NUM
  if (p === 0) return 0
  if (cum) return betaI(p, s, f + 1)
  if (p === 1) return f === 0 ? 1 : 0
  return Math.exp(gammaln(f + s) - gammaln(f + 1) - gammaln(s) + s * Math.log(p) + f * Math.log1p(-p))
}

function poisson(x: number, mean: number, cum: boolean): number {
  if (x < 0 || mean < 0) throw ERR.NUM
  if (mean === 0) return cum || x === 0 ? 1 : 0
  if (cum) return gammaQ(x + 1, mean)
  if (x <= 170) {
    const r = (Math.exp(-mean) * Math.pow(mean, x)) / factorial(x)
    if (Number.isFinite(r) && r > 0) return r
  }
  return Math.exp(-mean + x * Math.log(mean) - gammaln(x + 1))
}

function expon(x: number, lambda: number, cum: boolean): number {
  if (x < 0 || lambda <= 0) throw ERR.NUM
  return cum ? -Math.expm1(-lambda * x) : lambda * Math.exp(-lambda * x)
}

function weibull(x: number, a: number, b: number, cum: boolean): number {
  if (x < 0 || a <= 0 || b <= 0) throw ERR.NUM
  const u = Math.pow(x / b, a)
  // x = 0 with a < 1: the density is infinite (#NUM!)
  return cum ? -Math.expm1(-u) : (a / b) * Math.pow(x / b, a - 1) * Math.exp(-u)
}

function permut(n: number, k: number): number {
  if (n <= 0 || k < 0 || n < k) throw ERR.NUM
  if (k > 1000) return Math.exp(gammaln(n + 1) - gammaln(n - k + 1))
  let r = 1
  for (let i = 0; i < k; i++) r *= n - i
  return r
}

// ---------------------------------------------------------------- tests over ranges

function mean(xs: number[]): number {
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

/** sample variance (n - 1) around a known mean */
function svar(xs: number[], m: number): number {
  let s = 0
  for (const x of xs) s += (x - m) * (x - m)
  return s / (xs.length - 1)
}

function zTest(a: Val[], ev: Ev): number {
  const xs = nums([a[0]], ev)
  if (!xs.length) throw ERR.NA
  const x = num(ev.scalar(a[1]))
  const m = mean(xs)
  let sigma: number
  if (a.length > 2) {
    sigma = num(ev.scalar(a[2]))
    if (sigma <= 0) throw ERR.NUM
  } else {
    if (xs.length < 2) throw ERR.DIV0
    sigma = Math.sqrt(svar(xs, m))
  }
  if (sigma === 0) throw ERR.DIV0
  // P(sample mean > observed) when the population mean is x
  return normCdf((x - m) / (sigma / Math.sqrt(xs.length)))
}

function tTest(a: Val[], ev: Ev): number {
  const xs = nums([a[0]], ev)
  const ys = nums([a[1]], ev)
  const tails = Math.trunc(num(ev.scalar(a[2])))
  const type = Math.trunc(num(ev.scalar(a[3])))
  if (tails !== 1 && tails !== 2) throw ERR.NUM
  if (type < 1 || type > 3) throw ERR.NUM
  let t: number
  let v: number
  if (type === 1) {
    if (xs.length !== ys.length) throw ERR.NA
    const n = xs.length
    if (n < 2) throw ERR.DIV0
    const d = xs.map((x, i) => x - ys[i])
    const m = mean(d)
    const s2 = svar(d, m)
    if (s2 === 0) throw ERR.DIV0
    t = m / Math.sqrt(s2 / n)
    v = n - 1
  } else {
    const n1 = xs.length
    const n2 = ys.length
    if (n1 < 2 || n2 < 2) throw ERR.DIV0
    const m1 = mean(xs)
    const m2 = mean(ys)
    const v1 = svar(xs, m1)
    const v2 = svar(ys, m2)
    if (type === 2) {
      const sp = ((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2)
      if (sp === 0) throw ERR.DIV0
      t = (m1 - m2) / Math.sqrt(sp * (1 / n1 + 1 / n2))
      v = n1 + n2 - 2
    } else {
      const e1 = v1 / n1
      const e2 = v2 / n2
      if (e1 + e2 === 0) throw ERR.DIV0
      t = (m1 - m2) / Math.sqrt(e1 + e2)
      // Welch–Satterthwaite: a fractional number of degrees of freedom
      v = ((e1 + e2) * (e1 + e2)) / ((e1 * e1) / (n1 - 1) + (e2 * e2) / (n2 - 1))
    }
  }
  const two = tTwoTail(Math.abs(t), v)
  return tails === 1 ? two / 2 : two
}

function fTest(a: Val[], ev: Ev): number {
  const xs = nums([a[0]], ev)
  const ys = nums([a[1]], ev)
  if (xs.length < 2 || ys.length < 2) throw ERR.DIV0
  const v1 = svar(xs, mean(xs))
  const v2 = svar(ys, mean(ys))
  if (v1 === 0 || v2 === 0) throw ERR.DIV0
  const f = v1 / v2
  const d1 = xs.length - 1
  const d2 = ys.length - 1
  // two-tailed
  return Math.min(1, 2 * Math.min(fCdf(f, d1, d2), fSf(f, d1, d2)))
}

function chiTest(a: Val[], ev: Ev): number {
  const act = ev.toArray(a[0])
  const exp = ev.toArray(a[1])
  const r = act.length
  const c = act[0]?.length ?? 0
  if (r !== exp.length || c !== (exp[0]?.length ?? 0)) throw ERR.NA
  let chi = 0
  for (let i = 0; i < r; i++)
    for (let j = 0; j < c; j++) {
      const x = act[i][j]
      const e = exp[i][j]
      if (typeof x !== 'number' || typeof e !== 'number') throw ERR.VALUE
      if (e === 0) throw ERR.DIV0
      chi += ((x - e) * (x - e)) / e
    }
  const k = r > 1 && c > 1 ? (r - 1) * (c - 1) : r * c - 1
  if (k < 1) throw ERR.NA
  return chiSf(chi, k)
}

function probFn(a: Val[], ev: Ev): number {
  const xs = nums([a[0]], ev)
  const ps = nums([a[1]], ev)
  if (xs.length !== ps.length) throw ERR.NA
  let total = 0
  for (const p of ps) {
    if (p < 0 || p > 1) throw ERR.NUM
    total += p
  }
  if (Math.abs(total - 1) > 1e-9) throw ERR.NUM
  const low = num(ev.scalar(a[2]))
  const up = a.length > 3 ? num(ev.scalar(a[3])) : low
  let r = 0
  for (let i = 0; i < xs.length; i++) if (xs[i] >= low && xs[i] <= up) r += ps[i]
  return r
}

/** Google Sheets: z · s / √n for the confidence level, s the sample standard deviation */
function marginOfError(a: Val[], ev: Ev): number {
  const xs = nums([a[0]], ev)
  const conf = num(ev.scalar(a[1]))
  if (conf <= 0 || conf >= 1) throw ERR.NUM
  if (xs.length < 2) throw ERR.DIV0
  return (-normInv((1 - conf) / 2) * Math.sqrt(svar(xs, mean(xs)))) / Math.sqrt(xs.length)
}

/** the bounds A and B of the beta functions: 0 and 1 when omitted */
const lowB = (a: Value[], i: number) => opt(a, i, 0)
const upB = (a: Value[], i: number) => opt(a, i, 1)

// ---------------------------------------------------------------- registry

const normDistF = N(4, 4, ([x, m, s, c]) => normDist(num(x), num(m), num(s), bool(c)))
const normInvF = N(3, 3, ([p, m, s]) => normInvScaled(num(p), num(m), num(s)))
const normSInv = N(1, 1, ([p]) => normInvScaled(num(p), 0, 1))
const lognormDistF = N(4, 4, ([x, m, s, c]) => lognormDist(num(x), num(m), num(s), bool(c)))
const lognormInvF = N(3, 3, ([p, m, s]) => lognormInv(num(p), num(m), num(s)))
const confNorm = N(3, 3, ([al, sd, n]) => confidenceNorm(num(al), num(sd), int(n)))
const zTestF = A(2, 3, (a, ev) => fin(zTest(a, ev)))

const tInv2TF = N(2, 2, ([p, d]) => tInv2T(num(p), df(d)))
const tTestF = A(4, 4, (a, ev) => fin(tTest(a, ev)))

const chiDistRT = N(2, 2, ([x, d]) => {
  const k = df(d)
  const v = num(x)
  if (v < 0) throw ERR.NUM
  return chiSf(v, k)
})
const chiInvRT = N(2, 2, ([p, d]) => chiInv(num(p), df(d), true))
const chiTestF = A(2, 2, (a, ev) => fin(chiTest(a, ev)))

const fDistRT = N(3, 3, ([x, d1, d2]) => {
  const a = df(d1, true)
  const b = df(d2, true)
  const v = num(x)
  if (v < 0) throw ERR.NUM
  return fSf(v, a, b)
})
const fInvRT = N(3, 3, ([p, d1, d2]) => fInv(num(p), df(d1, true), df(d2, true), true))
const fTestF = A(2, 2, (a, ev) => fin(fTest(a, ev)))

const betaInvF = N(3, 5, (a) => betaInv(num(a[0]), num(a[1]), num(a[2]), lowB(a, 3), upB(a, 4)))
const gammaDistF = N(4, 4, ([x, a, b, c]) => gammaDist(num(x), num(a), num(b), bool(c)))
const gammaInvF = N(3, 3, ([p, a, b]) => gammaInv(num(p), num(a), num(b)))

const binomDistF = N(4, 4, ([k, n, p, c]) => binomDist(int(k), int(n), num(p), bool(c)))
const binomInvF = N(3, 3, ([n, p, al]) => binomInv(int(n), num(p), num(al)))
const hypgeomDistF = N(5, 5, ([x, n, K, M, c]) => hypgeomDist(int(x), int(n), int(K), int(M), bool(c)))
const negbinomDistF = N(4, 4, ([f, s, p, c]) => negbinomDist(int(f), int(s), num(p), bool(c)))
const poissonF = N(3, 3, ([x, m, c]) => poisson(int(x), num(m), bool(c)))
const exponF = N(3, 3, ([x, l, c]) => expon(num(x), num(l), bool(c)))
const weibullF = N(4, 4, ([x, a, b, c]) => weibull(num(x), num(a), num(b), bool(c)))

export const DIST: Record<string, FnDef> = {
  // normal
  'NORM.DIST': normDistF,
  NORMDIST: normDistF,
  'NORM.INV': normInvF,
  NORMINV: normInvF,
  'NORM.S.DIST': N(2, 2, ([z, c]) => (bool(c) ? normCdf(num(z)) : normPdf(num(z)))),
  NORMSDIST: N(1, 1, ([z]) => normCdf(num(z))),
  'NORM.S.INV': normSInv,
  NORMSINV: normSInv,
  // the area between the mean and z: erf keeps its digits near 0 where Φ(z) - 0.5 would not
  GAUSS: N(1, 1, ([z]) => erf(num(z) / Math.SQRT2) / 2),
  PHI: N(1, 1, ([x]) => normPdf(num(x))),
  STANDARDIZE: N(3, 3, ([x, m, s]) => {
    const sd = num(s)
    if (sd <= 0) throw ERR.NUM
    return (num(x) - num(m)) / sd
  }),
  'LOGNORM.DIST': lognormDistF,
  LOGNORMDIST: N(3, 3, ([x, m, s]) => lognormDist(num(x), num(m), num(s), true)),
  'LOGNORM.INV': lognormInvF,
  LOGINV: lognormInvF,
  CONFIDENCE: confNorm,
  'CONFIDENCE.NORM': confNorm,
  'CONFIDENCE.T': N(3, 3, ([al, sd, n]) => {
    const alpha = num(al)
    const s = num(sd)
    const size = int(n)
    prob(alpha, true, true)
    if (s <= 0) throw ERR.NUM
    if (size === 1) throw ERR.DIV0
    if (size < 1) throw ERR.NUM
    return (tInv2(alpha, size - 1) * s) / Math.sqrt(size)
  }),
  'Z.TEST': zTestF,
  ZTEST: zTestF,
  FISHER: N(1, 1, ([x]) => {
    const v = num(x)
    if (v <= -1 || v >= 1) throw ERR.NUM
    return Math.atanh(v)
  }),
  FISHERINV: N(1, 1, ([y]) => Math.tanh(num(y))),

  // Student t
  'T.DIST': N(3, 3, ([x, d, c]) => {
    const v = df(d)
    const t = num(x)
    return bool(c) ? tCdf(t, v) : tPdf(t, v)
  }),
  'T.DIST.2T': N(2, 2, ([x, d]) => {
    const v = df(d)
    const t = num(x)
    if (t < 0) throw ERR.NUM
    return tTwoTail(t, v)
  }),
  'T.DIST.RT': N(2, 2, ([x, d]) => tRight(num(x), df(d))),
  'T.INV': N(2, 2, ([p, d]) => tInv(num(p), df(d))),
  'T.INV.2T': tInv2TF,
  TINV: tInv2TF,
  'T.TEST': tTestF,
  TTEST: tTestF,
  TDIST: N(3, 3, ([x, d, t]) => tOld(num(x), df(d), int(t))),

  // chi-square
  'CHISQ.DIST': N(3, 3, ([x, d, c]) => {
    const k = df(d)
    const v = num(x)
    if (v < 0) throw ERR.NUM
    return bool(c) ? chiCdf(v, k) : chiPdf(v, k)
  }),
  'CHISQ.DIST.RT': chiDistRT,
  CHIDIST: chiDistRT,
  'CHISQ.INV': N(2, 2, ([p, d]) => chiInv(num(p), df(d), false)),
  'CHISQ.INV.RT': chiInvRT,
  CHIINV: chiInvRT,
  'CHISQ.TEST': chiTestF,
  CHITEST: chiTestF,

  // F
  'F.DIST': N(4, 4, ([x, d1, d2, c]) => {
    const a = df(d1)
    const b = df(d2)
    const v = num(x)
    if (v < 0) throw ERR.NUM
    return bool(c) ? fCdf(v, a, b) : fPdf(v, a, b)
  }),
  'F.DIST.RT': fDistRT,
  FDIST: fDistRT,
  'F.INV': N(3, 3, ([p, d1, d2]) => fInv(num(p), df(d1), df(d2), false)),
  'F.INV.RT': fInvRT,
  FINV: fInvRT,
  'F.TEST': fTestF,
  FTEST: fTestF,

  // beta, gamma
  'BETA.DIST': N(4, 6, (a) => betaDist(num(a[0]), num(a[1]), num(a[2]), bool(a[3]), lowB(a, 4), upB(a, 5))),
  // the old one has no cumulative flag: always the cdf
  BETADIST: N(3, 5, (a) => betaDist(num(a[0]), num(a[1]), num(a[2]), true, lowB(a, 3), upB(a, 4))),
  'BETA.INV': betaInvF,
  BETAINV: betaInvF,
  GAMMA: N(1, 1, ([x]) => gammaFn(num(x))),
  'GAMMA.DIST': gammaDistF,
  GAMMADIST: gammaDistF,
  'GAMMA.INV': gammaInvF,
  GAMMAINV: gammaInvF,
  GAMMALN: N(1, 1, ([x]) => gammaLn(num(x))),
  'GAMMALN.PRECISE': N(1, 1, ([x]) => gammaLn(num(x))),

  // discrete
  'BINOM.DIST': binomDistF,
  BINOMDIST: binomDistF,
  'BINOM.DIST.RANGE': N(3, 4, (a) => binomRange(int(a[0]), num(a[1]), int(a[2]), a.length > 3 ? int(a[3]) : undefined)),
  'BINOM.INV': binomInvF,
  CRITBINOM: binomInvF,
  'HYPGEOM.DIST': hypgeomDistF,
  HYPGEOMDIST: N(4, 4, ([x, n, K, M]) => hypgeomDist(int(x), int(n), int(K), int(M), false)),
  'NEGBINOM.DIST': negbinomDistF,
  NEGBINOMDIST: N(3, 3, ([f, s, p]) => negbinomDist(int(f), int(s), num(p), false)),
  POISSON: poissonF,
  'POISSON.DIST': poissonF,
  'EXPON.DIST': exponF,
  EXPONDIST: exponF,
  WEIBULL: weibullF,
  'WEIBULL.DIST': weibullF,
  PERMUT: N(2, 2, ([n, k]) => permut(int(n), int(k))),
  PERMUTATIONA: N(2, 2, ([n, k]) => {
    const a = int(n)
    const b = int(k)
    if (a < 0 || b < 0) throw ERR.NUM
    return Math.pow(a, b)
  }),
  PROB: A(3, 4, (a, ev) => fin(probFn(a, ev))),
  MARGINOFERROR: A(2, 2, (a, ev) => fin(marginOfError(a, ev))),
}
