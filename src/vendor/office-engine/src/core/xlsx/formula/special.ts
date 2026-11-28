/** Special functions the statistical and engineering functions are made of: gamma, error function, incomplete gamma and beta, the normal law. */

const EPS = 1e-16
const TINY = 1e-300
const SQRT2 = Math.SQRT2
const SQRT2PI = Math.sqrt(2 * Math.PI)
const LN_SQRT2PI = 0.5 * Math.log(2 * Math.PI)

// Lanczos approximation (g = 7, 9 terms): about 15 significant digits
const LG = 7
const LC = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
]

/** ln |Γ(x)|. Infinity at 0 and the negative integers. */
export function gammaln(x: number): number {
  if (x <= 0 && Number.isInteger(x)) return Infinity
  // reflection: Γ(x) Γ(1 - x) = π / sin(πx)
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - gammaln(1 - x)
  const z = x - 1
  let a = LC[0]
  for (let i = 1; i < 9; i++) a += LC[i] / (z + i)
  const t = z + LG + 0.5
  return LN_SQRT2PI + (z + 0.5) * Math.log(t) - t + Math.log(a)
}

const FACT: number[] = [1]
for (let i = 1; i <= 170; i++) FACT.push(FACT[i - 1] * i)

/** n! for an integer 0 ≤ n ≤ 170 (exact as far as a number goes); Infinity past it */
export function factorial(n: number): number {
  return n <= 170 ? FACT[n] : Infinity
}

/** Γ(x). NaN at 0 and the negative integers, ±Infinity where it overflows. */
export function gamma(x: number): number {
  if (Number.isInteger(x)) {
    if (x <= 0) return NaN
    if (x <= 171) return FACT[x - 1]
    return Infinity
  }
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x))
  if (x > 171.7) return Infinity
  const z = x - 1
  let a = LC[0]
  for (let i = 1; i < 9; i++) a += LC[i] / (z + i)
  const t = z + LG + 0.5
  // (t^(z+0.5) alone overflows before the product does)
  const p = Math.pow(t, (z + 0.5) / 2)
  return SQRT2PI * p * Math.exp(-t) * p * a
}

/** ln B(a, b) */
export function lnBeta(a: number, b: number): number {
  return gammaln(a) + gammaln(b) - gammaln(a + b)
}

/** ln C(n, k) for real n ≥ k ≥ 0 */
export function lnChoose(n: number, k: number): number {
  return gammaln(n + 1) - gammaln(k + 1) - gammaln(n - k + 1)
}

/** C(n, k) for integers (exact while it fits a number) */
export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  k = Math.min(k, n - k)
  let r = 1
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i
  return Math.round(r) === r || r > 2 ** 53 ? r : Math.round(r)
}

/** regularized lower incomplete gamma P(a, x), a > 0 */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0
  if (x < a + 1) return gammaSeries(a, x)
  return 1 - gammaCf(a, x)
}

/** regularized upper incomplete gamma Q(a, x) = 1 - P(a, x), a > 0: keeps its digits where P is close to 1 */
export function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1
  if (x < a + 1) return 1 - gammaSeries(a, x)
  return gammaCf(a, x)
}

function gammaSeries(a: number, x: number): number {
  let ap = a
  let del = 1 / a
  let sum = del
  for (let n = 0; n < 100000; n++) {
    ap++
    del *= x / ap
    sum += del
    if (Math.abs(del) < Math.abs(sum) * EPS) break
  }
  return sum * Math.exp(-x + a * Math.log(x) - gammaln(a))
}

function gammaCf(a: number, x: number): number {
  // modified Lentz
  let b = x + 1 - a
  let c = 1 / TINY
  let d = 1 / b
  let h = d
  for (let i = 1; i < 100000; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < TINY) d = TINY
    c = b + an / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return Math.exp(-x + a * Math.log(x) - gammaln(a)) * h
}

/** error function */
export function erf(x: number): number {
  if (x === 0) return 0
  if (!Number.isFinite(x)) return x > 0 ? 1 : -1
  const ax = Math.abs(x)
  let r: number
  if (ax < 2.5) {
    // Maclaurin series: 2/√π Σ (-1)^n x^(2n+1) / (n! (2n+1))
    const x2 = ax * ax
    let term = ax
    let sum = ax
    for (let n = 1; n < 200; n++) {
      term *= -x2 / n
      const add = term / (2 * n + 1)
      sum += add
      if (Math.abs(add) < Math.abs(sum) * EPS) break
    }
    r = (2 / Math.sqrt(Math.PI)) * sum
  } else r = 1 - gammaCf(0.5, ax * ax)
  return x < 0 ? -r : r
}

/** complementary error function 1 - erf(x), with its digits kept in the tail */
export function erfc(x: number): number {
  if (x < 0) return 2 - erfc(-x)
  if (x < 0.5) return 1 - erf(x)
  if (x > 27) return 0
  return gammaQ(0.5, x * x)
}

/** regularized incomplete beta I_x(a, b), a, b > 0 */
export function betaI(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bt = Math.exp(a * Math.log(x) + b * Math.log1p(-x) - lnBeta(a, b))
  if (x < (a + 1) / (a + b + 2)) return (bt * betaCf(x, a, b)) / a
  return 1 - (bt * betaCf(1 - x, b, a)) / b
}

function betaCf(x: number, a: number, b: number): number {
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < TINY) d = TINY
  d = 1 / d
  let h = d
  for (let m = 1; m < 100000; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < TINY) d = TINY
    c = 1 + aa / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < TINY) d = TINY
    c = 1 + aa / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return h
}

/** density of the standard normal law */
export function normPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / SQRT2PI
}

/** distribution function of the standard normal law */
export function normCdf(z: number): number {
  return 0.5 * erfc(-z / SQRT2)
}

const NA = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
const NB = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
const NC = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
const ND = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]

/** inverse of the standard normal distribution function, 0 < p < 1 (Acklam's approximation, refined to full precision) */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  let x: number
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p))
    x = (((((NC[0] * q + NC[1]) * q + NC[2]) * q + NC[3]) * q + NC[4]) * q + NC[5]) / ((((ND[0] * q + ND[1]) * q + ND[2]) * q + ND[3]) * q + 1)
  } else if (p <= 1 - 0.02425) {
    const q = p - 0.5
    const r = q * q
    x = ((((((NA[0] * r + NA[1]) * r + NA[2]) * r + NA[3]) * r + NA[4]) * r + NA[5]) * q) / (((((NB[0] * r + NB[1]) * r + NB[2]) * r + NB[3]) * r + NB[4]) * r + 1)
  } else {
    const q = Math.sqrt(-2 * Math.log1p(-p))
    x = -(((((NC[0] * q + NC[1]) * q + NC[2]) * q + NC[3]) * q + NC[4]) * q + NC[5]) / ((((ND[0] * q + ND[1]) * q + ND[2]) * q + ND[3]) * q + 1)
  }
  // two steps of Halley's method on the distribution function
  for (let k = 0; k < 2; k++) {
    const e = normCdf(x) - p
    const u = e * SQRT2PI * Math.exp((x * x) / 2)
    x -= u / (1 + (x * u) / 2)
  }
  return x
}

/**
 * The x in [lo, hi] where the increasing function `f` is `target`: bisection, for the inverses of distribution
 * functions (always converges; about 1e-15 of the interval). `hi` may be Infinity: the bracket is grown first.
 */
export function invert(f: (x: number) => number, target: number, lo: number, hi: number): number {
  if (!Number.isFinite(hi)) {
    hi = Math.max(1, lo + 1)
    for (let k = 0; k < 2000 && f(hi) < target; k++) {
      lo = hi
      hi *= 2
    }
  }
  if (!Number.isFinite(lo)) {
    lo = Math.min(-1, hi - 1)
    for (let k = 0; k < 2000 && f(lo) > target; k++) {
      hi = lo
      lo *= 2
    }
  }
  for (let k = 0; k < 400; k++) {
    const mid = lo + (hi - lo) / 2
    if (mid === lo || mid === hi) break
    if (f(mid) < target) lo = mid
    else hi = mid
  }
  return lo + (hi - lo) / 2
}
