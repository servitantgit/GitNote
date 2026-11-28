/** SUBTOTAL and AGGREGATE: aggregates that leave out hidden rows, errors and one another. */
import { A, INF, type Ev, type FnDef } from './fn'
import { ERR, FormulaError, type Value } from './types'
import { num, RangeV, UnionV, type Val } from './values'

interface Skip {
  /** rows hidden by hand (the rows a filter hides are always left out by SUBTOTAL) */
  hidden: boolean
  /** only the rows a filter hides */
  filtered: boolean
  errors: boolean
  /** the cells that are a SUBTOTAL / AGGREGATE themselves: a total of subtotals does not count them twice */
  nested: boolean
}

/** the values of the arguments that count: `all` every cell that holds something (COUNTA), else the numbers */
function collect(args: Val[], ev: Ev, skip: Skip, all: boolean, refsOnly: boolean): Value[] {
  const out: Value[] = []
  const p = ev.provider
  const take = (v: Value) => {
    if (v instanceof FormulaError) {
      if (skip.errors) return
      if (!all) throw v
    }
    if (all ? v !== null : typeof v === 'number') out.push(v)
  }
  const range = (rg: RangeV) => {
    let last = -1
    let off = false
    ev.forEach(rg, (v, i, j) => {
      const r = rg.r0 + i
      if (r !== last) {
        last = r
        off = (skip.hidden && !!p.rowHidden?.(rg.sheet, r, false)) || (skip.filtered && !!p.rowHidden?.(rg.sheet, r, true))
      }
      if (off) return
      if (skip.nested && v !== null && p.isSubtotal?.(rg.sheet, r, rg.c0 + j)) return
      take(v)
    })
  }
  for (const a of args) {
    if (a instanceof RangeV) range(a)
    else if (a instanceof UnionV) a.areas.forEach(range)
    else if (refsOnly) throw ERR.VALUE
    else for (const row of ev.toArray(a)) row.forEach(take)
  }
  return out
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)

function mean(xs: number[]): number {
  if (!xs.length) throw ERR.DIV0
  return sum(xs) / xs.length
}

function variance(xs: number[], sample: boolean): number {
  const n = xs.length
  if (n < (sample ? 2 : 1)) throw ERR.DIV0
  const m = sum(xs) / n
  let ss = 0
  for (const x of xs) ss += (x - m) * (x - m)
  return ss / (sample ? n - 1 : n)
}

function median(xs: number[]): number {
  if (!xs.length) throw ERR.NUM
  const s = [...xs].sort((a, b) => a - b)
  const h = s.length >> 1
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2
}

function mode(xs: number[]): number {
  const counts = new Map<number, number>()
  let best = 1
  for (const x of xs) {
    const n = (counts.get(x) ?? 0) + 1
    counts.set(x, n)
    if (n > best) best = n
  }
  if (best < 2) throw ERR.NA
  for (const x of xs) if (counts.get(x) === best) return x
  throw ERR.NA
}

/** the k-th percentile (0..1) of the numbers: `exc` leaves out the ends (k from 1/(n+1) to n/(n+1)) */
function percentile(xs: number[], k: number, exc: boolean): number {
  const n = xs.length
  if (!n || !(k >= 0 && k <= 1)) throw ERR.NUM
  const s = [...xs].sort((a, b) => a - b)
  const pos = exc ? k * (n + 1) - 1 : k * (n - 1)
  if (pos < 0 || pos > n - 1) throw ERR.NUM
  const lo = Math.floor(pos)
  return lo + 1 < n ? s[lo] + (pos - lo) * (s[lo + 1] - s[lo]) : s[lo]
}

function quartile(xs: number[], q: number, exc: boolean): number {
  const k = Math.trunc(q)
  if (exc ? k < 1 || k > 3 : k < 0 || k > 4) throw ERR.NUM
  return percentile(xs, k / 4, exc)
}

function kth(xs: number[], k: number, largest: boolean): number {
  const n = Math.ceil(k)
  if (n < 1 || n > xs.length) throw ERR.NUM
  return [...xs].sort((a, b) => (largest ? b - a : a - b))[n - 1]
}

/** the functions SUBTOTAL and AGGREGATE number 1 to 11 (2 and 3 count) */
function basic(code: number, xs: number[]): number {
  switch (code) {
    case 1:
      return mean(xs)
    case 4:
      return xs.length ? xs.reduce((m, x) => (x > m ? x : m), -Infinity) : 0
    case 5:
      return xs.length ? xs.reduce((m, x) => (x < m ? x : m), Infinity) : 0
    case 6:
      return xs.length ? xs.reduce((p, x) => p * x, 1) : 0
    case 7:
      return Math.sqrt(variance(xs, true))
    case 8:
      return Math.sqrt(variance(xs, false))
    case 9:
      return sum(xs)
    case 10:
      return variance(xs, true)
    case 11:
      return variance(xs, false)
  }
  throw ERR.VALUE
}

export const AGGREGATES: Record<string, FnDef> = {
  SUBTOTAL: A(2, INF, (a, ev) => {
    const raw = Math.trunc(num(ev.scalar(a[0])))
    const code = raw > 100 ? raw - 100 : raw
    if (code < 1 || code > 11 || (raw > 11 && raw < 101)) throw ERR.VALUE
    // 101-111 leave out the rows hidden by hand too
    const skip: Skip = { hidden: raw > 100, filtered: true, errors: false, nested: true }
    const vals = collect(a.slice(1), ev, skip, code === 3, true)
    if (code === 2 || code === 3) return vals.length
    return basic(code, vals as number[])
  }),
  AGGREGATE: A(3, INF, (a, ev) => {
    const code = Math.trunc(num(ev.scalar(a[0])))
    const opt = Math.trunc(num(ev.scalar(a[1])))
    if (code < 1 || code > 19 || opt < 0 || opt > 7) throw ERR.VALUE
    const skip: Skip = { hidden: opt === 1 || opt === 3 || opt === 5 || opt === 7, filtered: false, errors: opt === 2 || opt === 3 || opt === 6 || opt === 7, nested: opt <= 3 }
    if (code >= 14) {
      // the array form: an array (or a range) and a second argument
      if (a.length !== 4) throw ERR.VALUE
      const xs = collect([a[2]], ev, skip, false, false) as number[]
      const k = num(ev.scalar(a[3]))
      switch (code) {
        case 14:
          return kth(xs, k, true)
        case 15:
          return kth(xs, k, false)
        case 16:
          return percentile(xs, k, false)
        case 17:
          return quartile(xs, k, false)
        case 18:
          return percentile(xs, k, true)
        default:
          return quartile(xs, k, true)
      }
    }
    const vals = collect(a.slice(2), ev, skip, code === 3, true)
    if (code === 2 || code === 3) return vals.length
    if (code === 12) return median(vals as number[])
    if (code === 13) return mode(vals as number[])
    return basic(code, vals as number[])
  }),
}
