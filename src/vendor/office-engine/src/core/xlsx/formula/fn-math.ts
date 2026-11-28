/** Math functions. */
import { A, eachNum, INF, opt, S, visit, type Ev, type FnDef } from './fn'
import { roundHalf } from './format'
import { ERR, FormulaError, type Value } from './types'
import { int, num, str, toNum, type Val } from './values'

/** Remove binary noise (15 significant digits). */
const clean = (x: number) => Number(x.toPrecision(15))

function roundDir(x: number, d: number, up: boolean): number {
  if (x === 0) return 0
  const ax = Math.abs(x)
  const to = up ? Math.ceil : Math.floor
  let r: number
  if (d >= 0) {
    const y = ax * Math.pow(10, d)
    // no digit left to round away (1E300 to 10 decimals)
    if (!Number.isFinite(y) || y >= 2 ** 52) return x
    r = to(clean(y)) / Math.pow(10, d)
  } else {
    const f = Math.pow(10, -d)
    // 10^400 is not a number: what is left at that scale is 0
    if (!Number.isFinite(f)) return 0
    r = to(clean(ax / f)) * f
    if (!Number.isFinite(r)) return 0
  }
  return x < 0 ? -r : r
}

function finite(x: number): number {
  if (!Number.isFinite(x)) throw ERR.NUM
  return x
}

/** multiple of `sig` via ceil/floor of the (noise-free) quotient */
const multiple = (x: number, sig: number, up: boolean) => clean((up ? Math.ceil : Math.floor)(clean(x / sig)) * sig)

function gcd2(a: number, b: number): number {
  while (b) [a, b] = [b, a % b]
  return a
}

/** the integers of GCD / LCM: an empty cell is 0, text that is not a number (even in a range) is #VALUE! */
function intArgs(args: Val[], ev: Ev): number[] {
  const out: number[] = []
  const add = (v: Value) => {
    const n = toNum(v)
    if (n instanceof FormulaError) throw n
    if (n < 0) throw ERR.NUM
    out.push(Math.trunc(n))
  }
  for (const a of args) visit(a, ev, (v) => (typeof v === 'boolean' ? add(ERR.VALUE) : add(v)), add)
  return out
}

export const MATH: Record<string, FnDef> = {
  ABS: S(1, 1, ([x]) => Math.abs(num(x))),
  ROUND: S(2, 2, ([x, d]) => roundHalf(num(x), int(d))),
  ROUNDUP: S(2, 2, ([x, d]) => roundDir(num(x), int(d), true)),
  ROUNDDOWN: S(2, 2, ([x, d]) => roundDir(num(x), int(d), false)),
  TRUNC: S(1, 2, (a) => roundDir(num(a[0]), Math.trunc(opt(a, 1, 0)), false)),
  INT: S(1, 1, ([x]) => Math.floor(num(x))),
  MOD: S(2, 2, ([x, y]) => {
    const n = num(x)
    const d = num(y)
    if (d === 0) throw ERR.DIV0
    return clean(n - d * Math.floor(n / d))
  }),
  POWER: S(2, 2, ([x, y]) => {
    const b = num(x)
    const e = num(y)
    if (b === 0 && e === 0) throw ERR.NUM
    if (b === 0 && e < 0) throw ERR.DIV0
    const r = Math.pow(b, e)
    if (Number.isNaN(r)) throw ERR.NUM
    return finite(r)
  }),
  SQRT: S(1, 1, ([x]) => {
    const n = num(x)
    if (n < 0) throw ERR.NUM
    return Math.sqrt(n)
  }),
  EXP: S(1, 1, ([x]) => finite(Math.exp(num(x)))),
  LN: S(1, 1, ([x]) => {
    const n = num(x)
    if (n <= 0) throw ERR.NUM
    return Math.log(n)
  }),
  LOG: S(1, 2, (a) => {
    const n = num(a[0])
    const b = opt(a, 1, 10)
    if (n <= 0 || b <= 0) throw ERR.NUM
    if (b === 1) throw ERR.DIV0
    return clean(Math.log(n) / Math.log(b))
  }),
  LOG10: S(1, 1, ([x]) => {
    const n = num(x)
    if (n <= 0) throw ERR.NUM
    return Math.log10(n)
  }),
  PI: A(0, 0, () => Math.PI),
  SIGN: S(1, 1, ([x]) => Math.sign(num(x))),
  CEILING: S(1, 2, (a) => {
    const x = num(a[0])
    const sig = opt(a, 1, 1)
    if (sig === 0 || x === 0) return 0
    if (x > 0 && sig < 0) throw ERR.NUM
    return multiple(x, sig, true)
  }),
  FLOOR: S(1, 2, (a) => {
    const x = num(a[0])
    const sig = opt(a, 1, 1)
    if (sig === 0) throw ERR.DIV0
    if (x > 0 && sig < 0) throw ERR.NUM
    return multiple(x, sig, false)
  }),
  'CEILING.MATH': S(1, 3, (a) => {
    const x = num(a[0])
    const sig = Math.abs(opt(a, 1, 1))
    if (sig === 0 || x === 0) return 0
    if (x < 0 && opt(a, 2, 0) !== 0) return -multiple(-x, sig, true)
    return multiple(x, sig, true)
  }),
  'FLOOR.MATH': S(1, 3, (a) => {
    const x = num(a[0])
    const sig = Math.abs(opt(a, 1, 1))
    if (sig === 0 || x === 0) return 0
    if (x < 0 && opt(a, 2, 0) !== 0) return -multiple(-x, sig, false)
    return multiple(x, sig, false)
  }),
  RAND: A(0, 0, () => Math.random()),
  RANDBETWEEN: S(2, 2, ([a, b]) => {
    const lo = Math.ceil(num(a))
    const hi = Math.floor(num(b))
    if (lo > hi) throw ERR.NUM
    return lo + Math.floor(Math.random() * (hi - lo + 1))
  }),
  FACT: S(1, 1, ([x]) => {
    const v = num(x)
    // 171! is past what a number holds: no need to count up to it (nor to 1E15)
    if (v < 0 || v >= 171) throw ERR.NUM
    const n = Math.trunc(v)
    let r = 1
    for (let i = 2; i <= n; i++) r *= i
    return finite(r)
  }),
  EVEN: S(1, 1, ([x]) => {
    const n = num(x)
    const v = Math.ceil(clean(Math.abs(n) / 2)) * 2
    return n < 0 ? -v : v
  }),
  ODD: S(1, 1, ([x]) => {
    const n = num(x)
    let v = Math.ceil(clean(Math.abs(n)))
    if (v % 2 === 0) v++
    return n < 0 ? -v : v
  }),
  GCD: A(1, INF, (a, ev) => intArgs(a, ev).reduce((g, n) => gcd2(g, n), 0)),
  LCM: A(1, INF, (a, ev) =>
    finite(intArgs(a, ev).reduce((l, n) => (l === 0 || n === 0 ? 0 : (l / gcd2(l, n)) * n), 1)),
  ),

  // ---------------------------------------------------------------- trigonometry
  SIN: S(1, 1, ([x]) => Math.sin(angle(x))),
  COS: S(1, 1, ([x]) => Math.cos(angle(x))),
  TAN: S(1, 1, ([x]) => Math.tan(angle(x))),
  COT: S(1, 1, ([x]) => inverse(Math.tan(angle(x)))),
  SEC: S(1, 1, ([x]) => inverse(Math.cos(angle(x)))),
  CSC: S(1, 1, ([x]) => inverse(Math.sin(angle(x)))),
  ASIN: S(1, 1, ([x]) => Math.asin(within(num(x), -1, 1))),
  ACOS: S(1, 1, ([x]) => Math.acos(within(num(x), -1, 1))),
  ATAN: S(1, 1, ([x]) => Math.atan(num(x))),
  ATAN2: S(2, 2, ([x, y]) => {
    const a = num(x)
    const b = num(y)
    if (a === 0 && b === 0) throw ERR.DIV0
    return Math.atan2(b, a)
  }),
  // the angle between 0 and π whose cotangent is x
  ACOT: S(1, 1, ([x]) => Math.PI / 2 - Math.atan(num(x))),
  SINH: S(1, 1, ([x]) => finite(Math.sinh(num(x)))),
  COSH: S(1, 1, ([x]) => finite(Math.cosh(num(x)))),
  TANH: S(1, 1, ([x]) => Math.tanh(num(x))),
  COTH: S(1, 1, ([x]) => inverse(Math.tanh(num(x)))),
  SECH: S(1, 1, ([x]) => 1 / Math.cosh(num(x))),
  CSCH: S(1, 1, ([x]) => inverse(Math.sinh(num(x)))),
  ASINH: S(1, 1, ([x]) => Math.asinh(num(x))),
  ACOSH: S(1, 1, ([x]) => {
    const n = num(x)
    if (n < 1) throw ERR.NUM
    return Math.acosh(n)
  }),
  ATANH: S(1, 1, ([x]) => {
    const n = num(x)
    if (n <= -1 || n >= 1) throw ERR.NUM
    return Math.atanh(n)
  }),
  ACOTH: S(1, 1, ([x]) => {
    const n = num(x)
    if (n >= -1 && n <= 1) throw ERR.NUM
    return Math.atanh(1 / n)
  }),
  DEGREES: S(1, 1, ([x]) => (num(x) * 180) / Math.PI),
  RADIANS: S(1, 1, ([x]) => (num(x) * Math.PI) / 180),
  SQRTPI: S(1, 1, ([x]) => {
    const n = num(x)
    if (n < 0) throw ERR.NUM
    return Math.sqrt(n * Math.PI)
  }),

  // ---------------------------------------------------------------- rounding
  MROUND: S(2, 2, ([x, m]) => {
    const n = num(x)
    const k = num(m)
    if (k === 0 || n === 0) return 0
    if (n < 0 !== k < 0) throw ERR.NUM
    return clean(roundHalf(clean(n / k), 0) * k)
  }),
  QUOTIENT: S(2, 2, ([x, y]) => {
    const n = num(x)
    const d = num(y)
    if (d === 0) throw ERR.DIV0
    return Math.trunc(clean(n / d))
  }),
  // up toward +∞ / down toward -∞, whatever the signs
  'CEILING.PRECISE': S(1, 2, (a) => precise(num(a[0]), opt(a, 1, 1), true)),
  'ISO.CEILING': S(1, 2, (a) => precise(num(a[0]), opt(a, 1, 1), true)),
  'FLOOR.PRECISE': S(1, 2, (a) => precise(num(a[0]), opt(a, 1, 1), false)),

  // ---------------------------------------------------------------- counting
  COMBIN: S(2, 2, ([x, y]) => {
    const n = Math.trunc(num(x))
    const k = Math.trunc(num(y))
    if (n < 0 || k < 0 || k > n) throw ERR.NUM
    return finite(combin(n, k))
  }),
  COMBINA: S(2, 2, ([x, y]) => {
    const n = Math.trunc(num(x))
    const k = Math.trunc(num(y))
    if (n < 0 || k < 0) throw ERR.NUM
    if (k === 0) return 1
    if (n === 0) throw ERR.NUM
    return finite(combin(n + k - 1, k))
  }),
  FACTDOUBLE: S(1, 1, ([x]) => {
    const n = Math.trunc(num(x))
    if (n < -1 || n > 300) throw ERR.NUM
    let r = 1
    for (let i = n; i > 1; i -= 2) r *= i
    return finite(r)
  }),
  MULTINOMIAL: A(1, INF, (a, ev) => {
    const xs = intArgs(a, ev)
    // (a+b+…)! / (a! b! …) as a product of binomials: no factorial to overflow on the way
    let total = 0
    let r = 1
    for (const x of xs) {
      total += x
      r *= combin(total, x)
    }
    return finite(Math.round(r))
  }),

  // ---------------------------------------------------------------- numerals
  ROMAN: S(1, 2, (a) => {
    const n = Math.trunc(num(a[0]))
    const f = a.length > 1 ? a[1] : 0
    const form = typeof f === 'boolean' ? (f ? 0 : 4) : Math.trunc(num(f))
    if (n < 0 || n > 3999 || form < 0 || form > 4) throw ERR.VALUE
    return roman(n, form)
  }),
  ARABIC: S(1, 1, ([x]) => arabic(str(x))),
  BASE: S(2, 3, (a) => {
    const n = Math.trunc(num(a[0]))
    const radix = Math.trunc(num(a[1]))
    const len = Math.trunc(opt(a, 2, 0))
    if (n < 0 || n >= 2 ** 53 || radix < 2 || radix > 36 || len < 0 || len > 255) throw ERR.NUM
    return n.toString(radix).toUpperCase().padStart(len, '0')
  }),
  DECIMAL: S(2, 2, ([t, r]) => {
    const text = str(t).trim().toUpperCase()
    const radix = Math.trunc(num(r))
    if (radix < 2 || radix > 36 || text.length > 255) throw ERR.NUM
    let n = 0
    for (const ch of text) {
      const d = ch >= '0' && ch <= '9' ? ch.charCodeAt(0) - 48 : ch >= 'A' && ch <= 'Z' ? ch.charCodeAt(0) - 55 : 99
      if (d >= radix) throw ERR.NUM
      n = n * radix + d
    }
    return finite(n)
  }),

  // ---------------------------------------------------------------- sums
  SUMSQ: A(1, INF, (a, ev) => {
    let s = 0
    eachNum(a, ev, (n) => (s += n * n))
    return finite(s)
  }),
  SUMX2MY2: A(2, 2, (a, ev) => pairs(a, ev, (x, y) => x * x - y * y)),
  SUMX2PY2: A(2, 2, (a, ev) => pairs(a, ev, (x, y) => x * x + y * y)),
  SUMXMY2: A(2, 2, (a, ev) => pairs(a, ev, (x, y) => (x - y) * (x - y))),
  SERIESSUM: A(4, 4, (a, ev) => {
    const x = num(ev.scalar(a[0]))
    const n = num(ev.scalar(a[1]))
    const m = num(ev.scalar(a[2]))
    let s = 0
    let i = 0
    visit(
      a[3],
      ev,
      (v) => {
        if (v instanceof FormulaError) throw v
        if (typeof v !== 'number') throw ERR.VALUE
        s += v * Math.pow(x, n + m * i++)
      },
      (v) => (s += num(v) * Math.pow(x, n + m * i++)),
    )
    return finite(s)
  }),
  // the part a subset is of the whole
  PERCENTOF: A(2, 2, (a, ev) => {
    let part = 0
    let all = 0
    eachNum([a[0]], ev, (n) => (part += n))
    eachNum([a[1]], ev, (n) => (all += n))
    if (all === 0) throw ERR.DIV0
    return part / all
  }),
  COUNTUNIQUE: A(1, INF, (a, ev) => {
    const seen = new Set<string>()
    const add = (v: Value) => {
      if (v === null || v === '') return
      seen.add(v instanceof FormulaError ? `e${v.code}` : typeof v === 'string' ? `s${v}` : typeof v === 'number' ? `n${v}` : `b${v}`)
    }
    for (const x of a) visit(x, ev, add, add)
    return seen.size
  }),
}

/** an angle a trigonometric function takes: Excel has none past 2^27 */
function angle(v: Value): number {
  const x = num(v)
  if (Math.abs(x) >= 134217728) throw ERR.NUM
  return x
}

function inverse(x: number): number {
  if (x === 0) throw ERR.DIV0
  return 1 / x
}

function within(x: number, lo: number, hi: number): number {
  if (x < lo || x > hi) throw ERR.NUM
  return x
}

function precise(x: number, sig: number, up: boolean): number {
  const s = Math.abs(sig)
  if (s === 0 || x === 0) return 0
  return multiple(x, s, up)
}

function combin(n: number, k: number): number {
  k = Math.min(k, n - k)
  let r = 1
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i
  return r < 2 ** 53 ? Math.round(r) : r
}

/** Σ f(x, y) over the cells of two ranges of one size, where both hold a number */
function pairs(a: Val[], ev: Ev, f: (x: number, y: number) => number): number {
  const x = ev.toArray(a[0])
  const y = ev.toArray(a[1])
  if (x.length * x[0].length !== y.length * y[0].length) throw ERR.NA
  const xs = x.length === 1 ? x[0] : x.flat()
  const ys = y.length === 1 ? y[0] : y.flat()
  let s = 0
  for (let i = 0; i < xs.length; i++) {
    const p = xs[i]
    const q = ys[i]
    if (p instanceof FormulaError) throw p
    if (q instanceof FormulaError) throw q
    if (typeof p === 'number' && typeof q === 'number') s += f(p, q)
  }
  return finite(s)
}

const ROMAN_CHARS = 'MDCLXVI'
const ROMAN_VALUES = [1000, 500, 100, 50, 10, 5, 1]

/** ROMAN(n, form): form 0 is the classic numeral, 1 to 4 more and more concise (499: CDXCIX, LDVLIV, XDIX, VDIV, ID) */
function roman(n: number, form: number): string {
  let out = ''
  let val = n
  for (let i = 0; i <= 3; i++) {
    let idx = 2 * i
    const digit = Math.floor(val / ROMAN_VALUES[idx])
    if (digit % 5 === 4) {
      const idx2 = digit === 4 ? idx - 1 : idx - 2
      let steps = 0
      while (steps < form && idx < 6) {
        steps++
        if (ROMAN_VALUES[idx2] - ROMAN_VALUES[idx + 1] <= val) idx++
        else steps = form
      }
      out += ROMAN_CHARS[idx] + ROMAN_CHARS[idx2]
      val += ROMAN_VALUES[idx] - ROMAN_VALUES[idx2]
    } else {
      if (digit > 4) out += ROMAN_CHARS[idx - 1]
      out += ROMAN_CHARS[idx].repeat(digit % 5)
      val %= ROMAN_VALUES[idx]
    }
  }
  return out
}

function arabic(text: string): number {
  let t = text.trim().toUpperCase()
  if (t.length > 255) throw ERR.VALUE
  const neg = t.startsWith('-')
  if (neg) t = t.slice(1)
  let total = 0
  let prev = 0
  for (let i = t.length - 1; i >= 0; i--) {
    const k = ROMAN_CHARS.indexOf(t[i])
    if (k < 0) throw ERR.VALUE
    const v = ROMAN_VALUES[k]
    // a smaller numeral before a larger one is taken from it
    if (v < prev) total -= v
    else {
      total += v
      prev = v
    }
  }
  return neg ? -total : total
}
