/** Runtime values (references, arrays), coercions, comparison, wildcard & criteria matching. */
import { parseDateText } from './dates'
import { ERR, ERROR_CODES, ERROR_TYPE_EXTRA, FormulaError, type ErrorCode, type Value } from './types'

/** Reference to a rectangular block of cells (0-based inclusive). */
export class RangeV {
  constructor(
    readonly sheet: string | undefined,
    readonly r0: number,
    readonly c0: number,
    readonly r1: number,
    readonly c1: number,
  ) {}
  get h(): number {
    return this.r1 - this.r0 + 1
  }
  get w(): number {
    return this.c1 - this.c0 + 1
  }
}

/** In-memory array (array constants and array-evaluated results). Always at least 1x1. */
export class ArrayV {
  constructor(readonly data: Value[][]) {}
  get h(): number {
    return this.data.length
  }
  get w(): number {
    return this.data[0]?.length ?? 0
  }
}

/** Multi-area reference `(A1:B2,D4)`. */
export class UnionV {
  constructor(readonly areas: RangeV[]) {}
}

/**
 * A function as a value: what LAMBDA makes, and a function named without being called (`BYROW(rows, SUM)`). An
 * argument left out is undefined (ISOMITTED).
 */
export class LambdaV {
  constructor(
    readonly fn: (args: (Val | undefined)[]) => Val,
    /** the fewest and the most arguments it takes */
    readonly min = 0,
    readonly max = Number.POSITIVE_INFINITY,
  ) {}
}

export type Val = Value | RangeV | ArrayV | UnionV | LambdaV

export const isErr = (v: unknown): v is FormulaError => v instanceof FormulaError

// ---------------------------------------------------------------- numbers <-> text

/** a mixed number: 1 1/2, -3 3/4 */
const MIXED_RE = /^([+-])?\s*(\d+)\s+(\d+)\/(\d+)$/

const NUM_RE = /^([+-])?\s*\$?\s*((?:\d{1,3}(?:,\d{3})+|\d*)(?:\.\d*)?(?:[eE][+-]?\d+)?)\s*(%?)$/

/** Numeric text -> number (plain, 1,234.5, (5), 50%, $3, 1E3, 1 1/2, dates, times); null when not numeric. */
export function parseNumberText(s: string): number | null {
  const t = s.trim()
  if (!t) return null
  // (5) is -5, the way accounting writes a negative
  if (t[0] === '(' && t[t.length - 1] === ')' && t.length > 2) {
    const inner = t.slice(1, -1).trim()
    const n = /^[+-]/.test(inner) ? null : parseNumberText(inner)
    return n === null ? null : -n
  }
  const mixed = MIXED_RE.exec(t)
  if (mixed) {
    const den = Number(mixed[4])
    if (den === 0) return null
    const n = Number(mixed[2]) + Number(mixed[3]) / den
    return mixed[1] === '-' ? -n : n
  }
  const m = NUM_RE.exec(t)
  if (m && /\d/.test(m[2])) {
    const n = Number(m[2].replace(/,/g, ''))
    if (!Number.isNaN(n)) return ((m[1] === '-' ? -n : n) / (m[3] ? 100 : 1))
  }
  return parseDateText(t)
}

/** Excel "General" text of a number (15 significant digits). */
export function numToText(n: number): string {
  if (!Number.isFinite(n)) return '#NUM!'
  if (n === 0) return '0'
  const [mant, ex] = Math.abs(n).toExponential(14).split('e')
  const e = Number(ex)
  const digits = mant.replace('.', '').replace(/0+$/, '')
  const sign = n < 0 ? '-' : ''
  if (e >= 15 || e < -9) {
    const m = digits[0] + (digits.length > 1 ? `.${digits.slice(1)}` : '')
    return `${sign}${m}E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`
  }
  if (e < 0) return `${sign}0.${'0'.repeat(-e - 1)}${digits}`
  const int = digits.slice(0, e + 1).padEnd(e + 1, '0')
  const frac = digits.slice(e + 1)
  return sign + int + (frac ? `.${frac}` : '')
}

// ---------------------------------------------------------------- coercion (non-throwing)

export function toNum(v: Value): number | FormulaError {
  if (typeof v === 'number') return v
  if (v === null) return 0
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const n = parseNumberText(v)
    return n === null ? ERR.VALUE : n
  }
  return v
}

export function toStr(v: Value): string | FormulaError {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return numToText(v)
  if (v === null) return ''
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return v
}

export function toBool(v: Value): boolean | FormulaError {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (v === null) return false
  if (typeof v === 'string') {
    const u = v.toUpperCase()
    return u === 'TRUE' ? true : u === 'FALSE' ? false : ERR.VALUE
  }
  return v
}

// ---------------------------------------------------------------- coercion (throwing; used inside functions)

export function num(v: Value): number {
  const n = toNum(v)
  if (n instanceof FormulaError) throw n
  return n
}
export function int(v: Value): number {
  return Math.trunc(num(v))
}
export function str(v: Value): string {
  const s = toStr(v)
  if (s instanceof FormulaError) throw s
  return s
}
export function bool(v: Value): boolean {
  const b = toBool(v)
  if (b instanceof FormulaError) throw b
  return b
}
/** Throw if v is an error, else return it. */
export function check<T extends Value>(v: T): Exclude<T, FormulaError> {
  if (v instanceof FormulaError) throw v
  return v as Exclude<T, FormulaError>
}

// ---------------------------------------------------------------- comparison

export function numEq(a: number, b: number): boolean {
  return a === b || Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-15
}

/**
 * Excel's text order: by letters, then accents, never by case; punctuation before digits before letters, and `đ`
 * between `d` and `e`. One collator for the whole run (building one costs far more than a comparison).
 */
const collator = new Intl.Collator('vi', { sensitivity: 'accent' })

const plain = (s: string) => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (!(c >= 97 && c <= 122) && !(c >= 65 && c <= 90) && !(c >= 48 && c <= 57) && c !== 32) return false
  }
  return true
}

/** text order: plain ASCII (letters, digits, spaces) sorts as its lower case does, the rest by collation */
export function compareText(a: string, b: string): number {
  if (a === b) return 0
  if (plain(a) && plain(b)) {
    const x = a.toLowerCase()
    const y = b.toLowerCase()
    return x < y ? -1 : x > y ? 1 : 0
  }
  return collator.compare(a, b)
}

const rank = (v: number | string | boolean) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2)

/** Excel ordering: numbers < text < booleans; text case-insensitive; empty adopts the other side's type. Errors not allowed. */
export function compare(a: Value, b: Value): number {
  if (a === null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0
  if (b === null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0
  if (a instanceof FormulaError || b instanceof FormulaError) return 0
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return ra < rb ? -1 : 1
  if (typeof a === 'number') {
    const y = b as number
    return numEq(a, y) ? 0 : a < y ? -1 : 1
  }
  if (typeof a === 'string') return compareText(a, b as string)
  return (a ? 1 : 0) - (b ? 1 : 0)
}

/** Lookup equality: same type, text case-insensitive. */
export function valueEq(a: Value, b: Value): boolean {
  if (a === null || b === null) return a === b
  if (a instanceof FormulaError || b instanceof FormulaError) return false
  return typeof a === typeof b && compare(a, b) === 0
}

// ---------------------------------------------------------------- wildcards & criteria

export const hasWildcard = (s: string) => /[*?~]/.test(s)

export function wildcardRe(pat: string, anchored = true): RegExp {
  let re = ''
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i]
    if (ch === '~' && i + 1 < pat.length && '*?~'.includes(pat[i + 1])) re += `\\${pat[++i]}`
    else if (ch === '*') re += '[\\s\\S]*'
    else if (ch === '?') re += '[\\s\\S]'
    else re += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  }
  return new RegExp(anchored ? `^${re}$` : re, 'i')
}

export type Matcher = (v: Value) => boolean

function cmpOp(op: string, c: number): boolean {
  switch (op) {
    case '<':
      return c < 0
    case '<=':
      return c <= 0
    case '>':
      return c > 0
    case '>=':
      return c >= 0
    case '<>':
      return c !== 0
    default:
      return c === 0
  }
}

const errCode = (s: string): ErrorCode | undefined => {
  const up = s.toUpperCase()
  return ERROR_CODES.find((c) => c === up) ?? (Object.hasOwn(ERROR_TYPE_EXTRA, up) ? (up as ErrorCode) : undefined)
}

/** Criteria of COUNTIF/SUMIF/...: "<5", ">=10", "<>x", "=abc", "a*c", 3, TRUE, "" (blank). */
export function criteria(crit: Value): Matcher {
  if (crit instanceof FormulaError) {
    const code = crit.code
    return (v) => v instanceof FormulaError && v.code === code
  }
  if (crit === null) crit = 0
  if (typeof crit === 'number') {
    const n = crit
    return (v) => (typeof v === 'number' && numEq(v, n)) || (typeof v === 'string' && parseNumberText(v) === n)
  }
  if (typeof crit === 'boolean') {
    const b = crit
    return (v) => v === b
  }
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(crit)!
  const op = m[1] ?? ''
  const rest = m[2]
  const eq = op === '' || op === '='
  if (rest === '') {
    if (op === '') return (v) => v === null || v === ''
    if (op === '=') return (v) => v === null
    if (op === '<>') return (v) => v !== null && v !== ''
    return () => false
  }
  const n = parseNumberText(rest)
  if (n !== null) {
    if (eq) return (v) => (typeof v === 'number' && numEq(v, n)) || (typeof v === 'string' && parseNumberText(v) === n)
    // a number kept as text is equal to it (as for =), so it is not <> it
    if (op === '<>') return (v) => !((typeof v === 'number' && numEq(v, n)) || (typeof v === 'string' && parseNumberText(v) === n))
    return (v) => typeof v === 'number' && cmpOp(op, compare(v, n))
  }
  const up = rest.toUpperCase()
  if (up === 'TRUE' || up === 'FALSE') {
    const b = up === 'TRUE'
    if (eq) return (v) => v === b
    if (op === '<>') return (v) => v !== b
    return (v) => typeof v === 'boolean' && cmpOp(op, compare(v, b))
  }
  const ec = errCode(rest)
  if (ec) {
    const hit = (v: Value) => v instanceof FormulaError && v.code === ec
    return op === '<>' ? (v) => !hit(v) : (v) => hit(v)
  }
  if (eq || op === '<>') {
    const re = wildcardRe(rest)
    const hit = (v: Value) => typeof v === 'string' && re.test(v)
    return op === '<>' ? (v) => !hit(v) : hit
  }
  return (v) => typeof v === 'string' && cmpOp(op, compare(v, rest))
}
