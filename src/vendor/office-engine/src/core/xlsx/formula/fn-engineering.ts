/** Engineering functions: number bases, bits, complex numbers, unit conversion, error and Bessel functions. */
import { A, guard, INF, opt, S, visit, type FnDef } from './fn'
import { erf, erfc, gammaln } from './special'
import { ERR, FormulaError, type Value } from './types'
import { int, num, numToText, str } from './values'

// ---------------------------------------------------------------- number bases

const BITS: Record<number, number> = { 2: 10, 8: 30, 16: 40 }
const DIGITS = '0123456789ABCDEF'

/** Text (or number) in `base` -> signed value; 10 characters at most, the top bit means negative (two's complement). */
function parseBase(v: Value, base: number): number {
  if (typeof v === 'boolean') throw ERR.VALUE
  // an empty cell is 0; a number like 1100100 is read for its digits
  const s = (v === null ? '' : str(v)).toUpperCase()
  if (s.length > 10) throw ERR.NUM
  let n = 0
  for (const ch of s) {
    const d = DIGITS.indexOf(ch)
    if (d < 0 || d >= base) throw ERR.NUM
    n = n * base + d
  }
  const size = Math.pow(2, BITS[base])
  return s.length === 10 && n >= size / 2 ? n - size : n
}

/** Signed decimal -> text in `base`, negative as 10-character two's complement, positive padded to `places`. */
function formatBase(n: number, base: number, places: Value | undefined): string {
  const size = Math.pow(2, BITS[base])
  if (n < -size / 2 || n >= size / 2) throw ERR.NUM
  // places is checked as a number even where a negative n ignores it
  const p = places === undefined ? undefined : int(places)
  if (n < 0) return (size + n).toString(base).toUpperCase()
  const s = n.toString(base).toUpperCase()
  if (p === undefined) return s
  if (p <= 0 || p > 10 || s.length > p) throw ERR.NUM
  return s.padStart(p, '0')
}

function baseConv(from: number, to: number): FnDef {
  return S(1, 2, ([x, places]) => {
    const n = from === 10 ? int(x) : parseBase(x, from)
    return to === 10 ? n : formatBase(n, to, places)
  })
}

// ---------------------------------------------------------------- bit operations

const BIT_MAX = Math.pow(2, 48) - 1

function bitArg(v: Value): bigint {
  const n = num(v)
  if (n < 0 || n > BIT_MAX || n !== Math.floor(n)) throw ERR.NUM
  return BigInt(n)
}

const bitOp = (f: (a: bigint, b: bigint) => bigint): FnDef => S(2, 2, ([a, b]) => Number(f(bitArg(a), bitArg(b))))

function shift(n: bigint, by: number): number {
  if (Math.abs(by) > 53) throw ERR.NUM
  const r = by >= 0 ? n << BigInt(by) : n >> BigInt(-by)
  if (r > BigInt(BIT_MAX)) throw ERR.NUM
  return Number(r)
}

// ---------------------------------------------------------------- complex numbers

interface Cx {
  re: number
  im: number
  /** 'i' | 'j', or '' for a plain real that takes the suffix of the other operand */
  s: string
}
type Pair = [number, number]

const NUMP = '(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?'
const RE_FULL = new RegExp(`^([+-]?${NUMP})([+-])(${NUMP})?([ij])$`)
const RE_IMAG = new RegExp(`^([+-])?(${NUMP})?([ij])$`)
const RE_REAL = new RegExp(`^[+-]?${NUMP}$`)

/** A complex argument: number (real) or text like "3+4i"; text that does not parse is #NUM!. */
function cx(v: Value): Cx {
  if (v instanceof FormulaError) throw v
  if (typeof v === 'boolean') throw ERR.VALUE
  if (v === null) return { re: 0, im: 0, s: '' }
  if (typeof v === 'number') return { re: v, im: 0, s: '' }
  if (v === '') return { re: 0, im: 0, s: '' }
  let m = RE_FULL.exec(v)
  if (m) return { re: Number(m[1]), im: (m[2] === '-' ? -1 : 1) * (m[3] === undefined ? 1 : Number(m[3])), s: m[4] }
  m = RE_IMAG.exec(v)
  if (m) return { re: 0, im: (m[1] === '-' ? -1 : 1) * (m[2] === undefined ? 1 : Number(m[2])), s: m[3] }
  if (RE_REAL.test(v)) return { re: Number(v), im: 0, s: '' }
  throw ERR.NUM
}

/** The suffix of an operation: i or j, never both. */
function suffix(...cs: Cx[]): string {
  let s = ''
  for (const c of cs)
    if (c.s) {
      if (s && s !== c.s) throw ERR.VALUE
      s = c.s
    }
  return s || 'i'
}

/** Complex text: parts print like numbers do (15 digits), a zero part is left out, 1i is just i. */
function fmt(re: number, im: number, s = 'i'): string {
  if (!Number.isFinite(re) || !Number.isFinite(im)) throw ERR.NUM
  if (im === 0) return numToText(re)
  const mag = Math.abs(im) === 1 ? '' : numToText(Math.abs(im))
  if (re === 0) return (im < 0 ? '-' : '') + mag + s
  return numToText(re) + (im < 0 ? '-' : '+') + mag + s
}

const cmul = ([a, b]: Pair, [c, d]: Pair): Pair => [a * c - b * d, a * d + b * c]
function cdiv([a, b]: Pair, [c, d]: Pair): Pair {
  const den = c * c + d * d
  if (den === 0) throw ERR.NUM
  return [(a * c + b * d) / den, (b * c - a * d) / den]
}
function cln([a, b]: Pair): Pair {
  if (a === 0 && b === 0) throw ERR.NUM
  return [Math.log(Math.hypot(a, b)), Math.atan2(b, a)]
}
const csin = ([a, b]: Pair): Pair => [Math.sin(a) * Math.cosh(b), Math.cos(a) * Math.sinh(b)]
const ccos = ([a, b]: Pair): Pair => [Math.cos(a) * Math.cosh(b), -Math.sin(a) * Math.sinh(b)]
const csinh = ([a, b]: Pair): Pair => [Math.sinh(a) * Math.cos(b), Math.cosh(a) * Math.sin(b)]
const ccosh = ([a, b]: Pair): Pair => [Math.cosh(a) * Math.cos(b), Math.sinh(a) * Math.sin(b)]
const ONE: Pair = [1, 0]

function csqrt([a, b]: Pair): Pair {
  const m = Math.hypot(a, b)
  if (m === 0) return [0, 0]
  // this form does not lose digits when a and m nearly cancel; the imaginary part keeps the sign of b
  const big = Math.sqrt((m + Math.abs(a)) / 2)
  const small = Math.abs(b) / (2 * big)
  return a >= 0 ? [big, b < 0 ? -small : small] : [small, b < 0 ? -big : big]
}

function cpow(z: Pair, n: number): Pair {
  if (z[0] === 0 && z[1] === 0) {
    if (n > 0) return [0, 0]
    throw ERR.NUM
  }
  if (Number.isInteger(n) && Math.abs(n) <= 64) {
    // exact repeated multiplication keeps (2+3i)^3 = -46+9i free of trig noise
    let r: Pair = ONE
    let b: Pair = z
    for (let k = Math.abs(n); k > 0; k = Math.floor(k / 2)) {
      if (k % 2) r = cmul(r, b)
      b = cmul(b, b)
    }
    return n < 0 ? cdiv(ONE, r) : r
  }
  const [lr, th] = cln(z)
  const m = Math.exp(n * lr)
  return [m * Math.cos(n * th), m * Math.sin(n * th)]
}

/** One-argument complex function; the result keeps the suffix of its argument. */
const unary = (f: (z: Pair) => Pair): FnDef =>
  S(1, 1, ([v]) => {
    const c = cx(v)
    const [re, im] = f([c.re, c.im])
    return fmt(re, im, c.s || 'i')
  })

/** IMSUM / IMPRODUCT over any mix of values, ranges and arrays. */
function fold(init: Pair, f: (acc: Pair, z: Pair) => Pair): FnDef {
  return A(1, INF, (args, ev) =>
    guard(() => {
      let acc = init
      const cs: Cx[] = []
      const add = (v: Value) => {
        const c = cx(v)
        cs.push(c)
        acc = f(acc, [c.re, c.im])
      }
      // empty cells inside a range are skipped; text there must still be a complex number
      for (const a of args)
        visit(
          a,
          ev,
          (v) => {
            if (v !== null) add(v)
          },
          add,
        )
      return fmt(acc[0], acc[1], suffix(...cs))
    }),
  )
}

// ---------------------------------------------------------------- unit conversion

interface Unit {
  kind: string
  /** factor to the base unit of its kind */
  f: number
  /** power the metric prefix applies at (0 = takes none) */
  pw: number
  bin?: boolean
  /** temperature scale */
  t?: string
}
const UNITS = new Map<string, Unit>()

function def(kind: string, f: number, names: string, pw = 0, more: Partial<Unit> = {}): void {
  for (const n of names.split(' ')) UNITS.set(n, { kind, f, pw, ...more })
}

const LB = 453.59237
const IN = 0.0254
const FT3 = 0.3048 ** 3
const LY = 9.4607304725808e15
const PT = IN / 72

// mass (g)
def('mass', 1, 'g', 1)
def('mass', 14593.9029372064, 'sg')
def('mass', LB, 'lbm')
def('mass', 1.660538782e-24, 'u', 1)
def('mass', 28.349523125, 'ozm')
def('mass', 0.06479891, 'grain')
def('mass', 100 * LB, 'cwt shweight')
def('mass', 112 * LB, 'uk_cwt lcwt hweight')
def('mass', 14 * LB, 'stone')
def('mass', 2000 * LB, 'ton')
def('mass', 2240 * LB, 'uk_ton LTON brton')
// distance (m)
def('dist', 1, 'm', 1)
def('dist', 1609.344, 'mi')
def('dist', 1852, 'Nmi')
def('dist', IN, 'in')
def('dist', 0.3048, 'ft')
def('dist', 0.9144, 'yd')
def('dist', 1e-10, 'ang', 1)
def('dist', 45 * IN, 'ell')
def('dist', LY, 'ly', 1)
def('dist', 3.0856775814913673e16, 'parsec pc', 1)
def('dist', PT, 'Pica Picapt')
def('dist', IN / 6, 'pica')
def('dist', 1609.347218694437, 'survey_mi')
// time (s)
def('time', 31557600, 'yr')
def('time', 86400, 'day d')
def('time', 3600, 'hr')
def('time', 60, 'mn min')
def('time', 1, 'sec s', 1)
// pressure (Pa)
def('press', 1, 'Pa p', 1)
def('press', 101325, 'atm at', 1)
def('press', 133.322363925, 'mmHg', 1)
def('press', 6894.757293168, 'psi')
def('press', 133.322368421, 'Torr', 1)
// force (N)
def('force', 1, 'N', 1)
def('force', 1e-5, 'dyn dy', 1)
def('force', 4.4482216152605, 'lbf')
def('force', 9.80665e-3, 'pond', 1)
// energy (J)
def('energy', 1, 'J', 1)
def('energy', 1e-7, 'e', 1)
def('energy', 4.184, 'c', 1)
def('energy', 4.1868, 'cal', 1)
def('energy', 1.60217646e-19, 'eV ev', 1)
def('energy', 2684519.537696172792, 'HPh hh')
def('energy', 3600, 'Wh wh', 1)
def('energy', 1.3558179483314004, 'flb')
def('energy', 1055.05585262, 'BTU btu')
// power (W)
def('power', 745.69987158227022, 'HP h')
def('power', 735.49875, 'PS')
def('power', 1, 'W w', 1)
// magnetism (T)
def('mag', 1, 'T', 1)
def('mag', 1e-4, 'ga', 1)
// temperature (through kelvin)
def('temp', 1, 'C cel', 0, { t: 'C' })
def('temp', 1, 'F fah', 0, { t: 'F' })
def('temp', 1, 'K kel', 1, { t: 'K' })
def('temp', 1, 'Reau', 0, { t: 'Re' })
def('temp', 1, 'Rank', 0, { t: 'Ra' })
// volume (m^3)
def('vol', 4.92892159375e-6, 'tsp')
def('vol', 5e-6, 'tspm')
def('vol', 1.478676478125e-5, 'tbs')
def('vol', 2.95735295625e-5, 'oz')
def('vol', 2.365882365e-4, 'cup')
def('vol', 4.73176473e-4, 'pt us_pt')
def('vol', 5.6826125e-4, 'uk_pt')
def('vol', 9.46352946e-4, 'qt')
def('vol', 1.1365225e-3, 'uk_qt')
def('vol', 3.785411784e-3, 'gal')
def('vol', 4.54609e-3, 'uk_gal')
def('vol', 1e-3, 'l L lt', 1)
def('vol', 1e-30, 'ang3 ang^3', 3)
def('vol', 0.158987294928, 'barrel')
def('vol', 0.03523907016688, 'bushel')
def('vol', 100 * FT3, 'regton GRT')
def('vol', 40 * FT3, 'MTON')
def('vol', LY ** 3, 'ly3 ly^3', 3)
def('vol', FT3, 'ft3 ft^3')
def('vol', IN ** 3, 'in3 in^3')
def('vol', 1609.344 ** 3, 'mi3 mi^3')
def('vol', 1, 'm3 m^3', 3)
def('vol', 1852 ** 3, 'Nmi3 Nmi^3')
def('vol', 0.9144 ** 3, 'yd3 yd^3')
def('vol', PT ** 3, 'Pica3 Picapt3 Pica^3 Picapt^3')
// area (m^2)
def('area', 4046.8564224, 'uk_acre')
def('area', 4046.87260987425, 'us_acre')
def('area', 1e-20, 'ang2 ang^2', 2)
def('area', 100, 'ar', 1)
def('area', 0.3048 ** 2, 'ft2 ft^2')
def('area', 1e4, 'ha')
def('area', IN ** 2, 'in2 in^2')
def('area', LY ** 2, 'ly2 ly^2', 2)
def('area', 1, 'm2 m^2', 2)
def('area', 2500, 'Morgen')
def('area', 1609.344 ** 2, 'mi2 mi^2')
def('area', 1852 ** 2, 'Nmi2 Nmi^2')
def('area', PT ** 2, 'Pica2 Picapt2 Pica^2 Picapt^2')
def('area', 0.9144 ** 2, 'yd2 yd^2')
// information (bit)
def('info', 1, 'bit', 1, { bin: true })
def('info', 8, 'byte', 1, { bin: true })
// speed (m/s)
def('speed', 1, 'm/s m/sec', 1)
def('speed', 1 / 3600, 'm/h m/hr', 1)
def('speed', 0.44704, 'mph')
def('speed', 1852 / 3600, 'kn')
def('speed', 1853.184 / 3600, 'admkn')

const METRIC: [string, number][] = [
  ['da', 1e1], ['Y', 1e24], ['Z', 1e21], ['E', 1e18], ['P', 1e15], ['T', 1e12], ['G', 1e9], ['M', 1e6],
  ['k', 1e3], ['h', 1e2], ['e', 1e1], ['d', 1e-1], ['c', 1e-2], ['m', 1e-3], ['u', 1e-6], ['n', 1e-9],
  ['p', 1e-12], ['f', 1e-15], ['a', 1e-18], ['z', 1e-21], ['y', 1e-24],
]
const BINARY: [string, number][] = [
  ['Yi', 2 ** 80], ['Zi', 2 ** 70], ['Ei', 2 ** 60], ['Pi', 2 ** 50], ['Ti', 2 ** 40], ['Gi', 2 ** 30],
  ['Mi', 2 ** 20], ['ki', 2 ** 10],
]
const METRIC_MAP = new Map(METRIC)
const BINARY_MAP = new Map(BINARY)

/** A unit name, with its prefix if it has one (units and prefixes are case-sensitive). */
function unitOf(name: string): { u: Unit; m: number } {
  const direct = UNITS.get(name)
  if (direct) return { u: direct, m: 1 }
  for (const len of [2, 1]) {
    const pre = name.slice(0, len)
    const u = UNITS.get(name.slice(len))
    if (!u || name.length <= len) continue
    const bin = BINARY_MAP.get(pre)
    if (bin !== undefined && u.bin) return { u, m: bin }
    const met = METRIC_MAP.get(pre)
    if (met !== undefined && u.pw > 0) return { u, m: Math.pow(met, u.pw) }
  }
  throw ERR.NA
}

const toKelvin: Record<string, (x: number) => number> = {
  C: (x) => x + 273.15,
  F: (x) => ((x - 32) * 5) / 9 + 273.15,
  K: (x) => x,
  Re: (x) => (x * 5) / 4 + 273.15,
  Ra: (x) => (x * 5) / 9,
}
const fromKelvin: Record<string, (x: number) => number> = {
  C: (x) => x - 273.15,
  F: (x) => ((x - 273.15) * 9) / 5 + 32,
  K: (x) => x,
  Re: (x) => ((x - 273.15) * 4) / 5,
  Ra: (x) => (x * 9) / 5,
}

function convert(n: number, from: string, to: string): number {
  const a = unitOf(from)
  const b = unitOf(to)
  if (a.u.kind !== b.u.kind) throw ERR.NA
  let r: number
  if (a.u.t && b.u.t) r = fromKelvin[b.u.t](toKelvin[a.u.t](n * a.m)) / b.m
  else r = (n * a.m * a.u.f) / (b.m * b.u.f)
  // drop binary noise (68 F -> 20 C)
  return Number(r.toPrecision(15))
}

// ---------------------------------------------------------------- Bessel functions

const EULER = 0.5772156649015329

/** Power series of J_n (alternating, sign -1) or I_n (sign 1); only used where its terms stay small. */
function besselSeries(x: number, n: number, sign: 1 | -1): number {
  const q = (x * x) / 4
  let term = Math.exp(n * Math.log(x / 2) - gammaln(n + 1))
  let sum = term
  for (let k = 1; k < 5000; k++) {
    term *= (sign * q) / (k * (k + n))
    sum += term
    if (Math.abs(term) <= Math.abs(sum) * 1e-17) break
  }
  return sum
}

/**
 * J_0..J_nmax+ by Miller's backward recurrence, normalised with J_0 + 2 sum J_2k = 1. Accurate to about 1e-16
 * absolute for any x (the plain series loses everything to cancellation once x is large).
 */
function millerJ(x: number, nmax: number): Float64Array {
  const m = Math.max(nmax, x)
  let top = Math.ceil(m + 40 + 3 * Math.sqrt(m))
  if (top % 2) top++
  if (top > 4e6) throw ERR.NUM
  const j = new Float64Array(top + 2)
  j[top] = 1
  for (let k = top; k >= 1; k--) {
    j[k - 1] = ((2 * k) / x) * j[k] - j[k + 1]
    if (Math.abs(j[k - 1]) > 1e250) for (let i = k - 1; i <= top; i++) j[i] *= 1e-250
  }
  let sum = j[0]
  for (let k = 2; k <= top; k += 2) sum += 2 * j[k]
  for (let k = 0; k <= top; k++) j[k] /= sum
  return j
}

/** Hankel's asymptotic series of J_n and Y_n, for x far beyond n (a Miller array would be too long). */
function hankel(x: number, n: number): { j: number; y: number } {
  const mu = 4 * n * n
  let p = 1
  let q = 0
  let term = 1
  let last = Infinity
  for (let k = 1; k < 60; k++) {
    term *= (mu - (2 * k - 1) ** 2) / (k * 8 * x)
    if (Math.abs(term) > last) break
    last = Math.abs(term)
    const s = Math.floor(k / 2) % 2 ? -1 : 1
    if (k % 2) q += s * term
    else p += s * term
    if (last < 1e-17) break
  }
  const chi = x - (n / 2 + 0.25) * Math.PI
  const f = Math.sqrt(2 / (Math.PI * x))
  return { j: f * (p * Math.cos(chi) - q * Math.sin(chi)), y: f * (p * Math.sin(chi) + q * Math.cos(chi)) }
}

const HANKEL_FROM = 5e4

function besselJ(x: number, n: number): number {
  if (x === 0) return n === 0 ? 1 : 0
  const ax = Math.abs(x)
  let r: number
  if ((ax * ax) / (4 * (n + 1)) <= 6) r = besselSeries(ax, n, -1)
  else if (ax > HANKEL_FROM && n <= 200) r = hankel(ax, n).j
  else r = millerJ(ax, n)[n]
  return x < 0 && n % 2 ? -r : r
}

/** [Y_0, Y_1]: series for small x, Neumann series over Miller's J_k otherwise, Hankel for huge x. */
function y01(x: number): Pair {
  if (x <= 3) {
    const q = (x * x) / 4
    // Y0 = 2/pi [(ln(x/2)+g) J0 + sum (-1)^(k+1) H_k q^k / k!^2]
    // Y1 = -2/(pi x) + 2/pi ln(x/2) J1 - (x/2)/pi sum (-q)^k [psi(k+1)+psi(k+2)] / (k!(k+1)!)
    let t0 = 1
    let t1 = 1
    let h = 0
    let s0 = 0
    let s1 = 1 - 2 * EULER
    for (let k = 1; k < 100; k++) {
      t0 *= q / (k * k)
      h += 1 / k
      const a = (k % 2 ? 1 : -1) * h * t0
      s0 += a
      t1 *= -q / (k * (k + 1))
      const b = t1 * (-2 * EULER + 2 * h + 1 / (k + 1))
      s1 += b
      if (Math.abs(a) < 1e-18 && Math.abs(b) < 1e-18) break
    }
    const l = Math.log(x / 2)
    const y0 = (2 / Math.PI) * ((l + EULER) * besselSeries(x, 0, -1) + s0)
    const y1 = -2 / (Math.PI * x) + (2 / Math.PI) * l * besselSeries(x, 1, -1) - (x / 2 / Math.PI) * s1
    return [y0, y1]
  }
  if (x > HANKEL_FROM) return [hankel(x, 0).y, hankel(x, 1).y]
  const j = millerJ(x, 1)
  const l = Math.log(x / 2) + EULER
  let s1 = 0
  let s2 = 0
  for (let k = 1; 2 * k + 1 < j.length - 1; k++) {
    const sg = k % 2 ? -1 : 1
    s1 += (sg * j[2 * k]) / k
    s2 += (sg * (j[2 * k - 1] - j[2 * k + 1])) / (2 * k)
  }
  const y0 = (2 / Math.PI) * l * j[0] - (4 / Math.PI) * s1
  // Y1 = -Y0'
  const d = (2 / Math.PI) * (j[0] / x - l * j[1]) - (4 / Math.PI) * s2
  return [y0, -d]
}

function besselY(x: number, n: number): number {
  if (x <= 0) throw ERR.NUM
  let [a, b] = y01(x)
  if (n === 0) return a
  for (let k = 1; k < n; k++) {
    ;[a, b] = [b, ((2 * k) / x) * b - a]
    if (!Number.isFinite(b)) throw ERR.NUM
  }
  return b
}

function besselI(x: number, n: number): number {
  if (x === 0) return n === 0 ? 1 : 0
  const r = besselSeries(Math.abs(x), n, 1)
  return x < 0 && n % 2 ? -r : r
}

/** e^x K_0 or e^x K_1: the trapezoid rule on the integral of exp(-x cosh t) cosh(nt), exact to rounding for it. */
function kScaled(x: number, n: 0 | 1): number {
  // the integrand is a bell of width ~1/sqrt(x): the step has to follow it
  const h = Math.min(0.2, 0.7 / Math.sqrt(x))
  let sum = 0.5
  for (let k = 1; ; k++) {
    const t = k * h
    const s = Math.sinh(t / 2)
    const e = 2 * x * s * s
    if (e > 745) break
    sum += Math.exp(-e) * (n ? Math.cosh(t) : 1)
  }
  return sum * h
}

function besselK(x: number, n: number): number {
  if (x <= 0) throw ERR.NUM
  let a = kScaled(x, 0)
  let b = n === 0 ? a : kScaled(x, 1)
  for (let k = 1; k < n; k++) {
    ;[a, b] = [b, a + ((2 * k) / x) * b]
    if (!Number.isFinite(b)) throw ERR.NUM
  }
  return b * Math.exp(-x)
}

/** BESSELx(x, n): n is cut to an integer, below 0 it is #NUM!. */
const bessel = (f: (x: number, n: number) => number): FnDef =>
  S(2, 2, ([x, n]) => {
    const xv = num(x)
    const nv = int(n)
    if (nv < 0) throw ERR.NUM
    const r = f(xv, nv)
    if (!Number.isFinite(r)) throw ERR.NUM
    return r
  })

// ---------------------------------------------------------------- registry

export const ENGINEERING: Record<string, FnDef> = {
  BIN2DEC: baseConv(2, 10),
  BIN2HEX: baseConv(2, 16),
  BIN2OCT: baseConv(2, 8),
  DEC2BIN: baseConv(10, 2),
  DEC2HEX: baseConv(10, 16),
  DEC2OCT: baseConv(10, 8),
  HEX2BIN: baseConv(16, 2),
  HEX2DEC: baseConv(16, 10),
  HEX2OCT: baseConv(16, 8),
  OCT2BIN: baseConv(8, 2),
  OCT2DEC: baseConv(8, 10),
  OCT2HEX: baseConv(8, 16),

  BITAND: bitOp((a, b) => a & b),
  BITOR: bitOp((a, b) => a | b),
  BITXOR: bitOp((a, b) => a ^ b),
  BITLSHIFT: S(2, 2, ([n, by]) => shift(bitArg(n), int(by))),
  BITRSHIFT: S(2, 2, ([n, by]) => shift(bitArg(n), -int(by))),

  COMPLEX: S(2, 3, ([re, im, s]) => {
    const suf = s === undefined || s === null ? 'i' : str(s)
    if (suf !== 'i' && suf !== 'j') throw ERR.VALUE
    return fmt(num(re), num(im), suf)
  }),
  IMABS: S(1, 1, ([v]) => {
    const c = cx(v)
    return Math.hypot(c.re, c.im)
  }),
  IMAGINARY: S(1, 1, ([v]) => cx(v).im),
  IMREAL: S(1, 1, ([v]) => cx(v).re),
  IMARGUMENT: S(1, 1, ([v]) => {
    const c = cx(v)
    if (c.re === 0 && c.im === 0) throw ERR.DIV0
    return Math.atan2(c.im, c.re)
  }),
  IMCONJUGATE: unary(([a, b]) => [a, -b]),
  IMCOS: unary(ccos),
  IMCOSH: unary(ccosh),
  IMCOT: unary((z) => cdiv(ccos(z), csin(z))),
  IMCOTH: unary((z) => cdiv(ccosh(z), csinh(z))),
  IMCSC: unary((z) => cdiv(ONE, csin(z))),
  IMCSCH: unary((z) => cdiv(ONE, csinh(z))),
  IMSEC: unary((z) => cdiv(ONE, ccos(z))),
  IMSECH: unary((z) => cdiv(ONE, ccosh(z))),
  IMSIN: unary(csin),
  IMSINH: unary(csinh),
  IMTAN: unary((z) => cdiv(csin(z), ccos(z))),
  IMTANH: unary((z) => cdiv(csinh(z), ccosh(z))),
  IMEXP: unary(([a, b]) => [Math.exp(a) * Math.cos(b), Math.exp(a) * Math.sin(b)]),
  IMLN: unary(cln),
  IMLOG10: unary((z) => {
    const [a, b] = cln(z)
    return [a / Math.LN10, b / Math.LN10]
  }),
  IMLOG2: unary((z) => {
    const [a, b] = cln(z)
    return [a / Math.LN2, b / Math.LN2]
  }),
  // Google Sheets: logarithm to a real base
  IMLOG: S(2, 2, ([v, b]) => {
    const c = cx(v)
    const base = num(b)
    if (base <= 0 || base === 1) throw ERR.NUM
    const [a, th] = cln([c.re, c.im])
    const lb = Math.log(base)
    return fmt(a / lb, th / lb, c.s || 'i')
  }),
  IMSQRT: unary(csqrt),
  IMPOWER: S(2, 2, ([v, n]) => {
    const c = cx(v)
    const [re, im] = cpow([c.re, c.im], num(n))
    return fmt(re, im, c.s || 'i')
  }),
  IMDIV: S(2, 2, ([a, b]) => {
    const x = cx(a)
    const y = cx(b)
    const [re, im] = cdiv([x.re, x.im], [y.re, y.im])
    return fmt(re, im, suffix(x, y))
  }),
  IMSUB: S(2, 2, ([a, b]) => {
    const x = cx(a)
    const y = cx(b)
    return fmt(x.re - y.re, x.im - y.im, suffix(x, y))
  }),
  IMSUM: fold([0, 0], (p, z) => [p[0] + z[0], p[1] + z[1]]),
  IMPRODUCT: fold(ONE, cmul),

  CONVERT: S(3, 3, ([n, from, to]) => convert(num(n), str(from), str(to))),
  DELTA: S(1, 2, (a) => (num(a[0]) === opt(a, 1, 0) ? 1 : 0)),
  GESTEP: S(1, 2, (a) => (num(a[0]) >= opt(a, 1, 0) ? 1 : 0)),
  ERF: S(1, 2, ([lo, hi]) => (hi === undefined ? erf(num(lo)) : erf(num(hi)) - erf(num(lo)))),
  'ERF.PRECISE': S(1, 1, ([x]) => erf(num(x))),
  ERFC: S(1, 1, ([x]) => erfc(num(x))),
  'ERFC.PRECISE': S(1, 1, ([x]) => erfc(num(x))),

  BESSELI: bessel(besselI),
  BESSELJ: bessel(besselJ),
  BESSELK: bessel(besselK),
  BESSELY: bessel(besselY),
}
