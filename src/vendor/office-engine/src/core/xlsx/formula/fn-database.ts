/** Database functions (DSUM, DGET, …): a list with a header row, a field, a range of criteria. */
import { A, type Ev, type FnDef } from './fn'
import { ERR, FormulaError, type Value } from './types'
import { criteria, parseNumberText, toStr, UnionV, wildcardRe, type Matcher, type Val } from './values'

function grid(v: Val, ev: Ev): Value[][] {
  if (v instanceof UnionV) throw ERR.VALUE
  return ev.toArray(v)
}

const label = (v: Value): string => {
  const s = toStr(v)
  return s instanceof FormulaError ? '' : s.trim().toLowerCase()
}

const blank = (v: Value) => v === null || v === ''

/**
 * One condition cell. The D-functions differ from COUNTIF on text: one without an operator matches cells that begin
 * with it (`Ap` finds Apple); only `="=Apple"` (a cell holding =Apple) is an exact match.
 */
function condition(c: Value): Matcher {
  if (typeof c === 'string' && !/^(<=|>=|<>|<|>|=)/.test(c) && parseNumberText(c) === null) {
    const re = wildcardRe(`${c}*`)
    return (v) => typeof v === 'string' && re.test(v)
  }
  return criteria(c)
}

/** The records (rows below the header) that satisfy the criteria range, and the column of `field`. */
function select(a: Val[], ev: Ev, optionalField: boolean): { col: number; recs: Value[][] } {
  const db = grid(a[0], ev)
  const crit = grid(a[2], ev)
  const head = db[0].map(label)
  const f = ev.scalar(a[1])
  let col = -1
  if (f instanceof FormulaError) throw f
  if (typeof f === 'number') {
    col = Math.trunc(f) - 1
    if (col < 0 || col >= head.length) throw ERR.VALUE
  } else if (typeof f === 'string' && f !== '') {
    col = head.indexOf(f.trim().toLowerCase())
    if (col < 0) throw ERR.VALUE
  } else if (!(blank(f) && optionalField)) throw ERR.VALUE

  if (crit.length < 2) throw ERR.VALUE
  // criteria column -> database column; blank or unknown labels name none
  const target = crit[0].map((l) => (blank(l) ? -1 : head.indexOf(label(l))))
  const rows = crit.slice(1).map((row) => {
    const tests: { col: number; test: Matcher; flag?: boolean }[] = []
    row.forEach((c, j) => {
      if (blank(c)) return
      // under a label that is no column only a plain TRUE/FALSE (a computed criterion's result) says anything
      if (target[j] < 0) tests.push({ col: -1, test: () => c === true })
      else tests.push({ col: target[j], test: condition(c) })
    })
    return tests
  })
  const recs = db.slice(1).filter((rec) => rows.some((tests) => tests.every((t) => (t.col < 0 ? t.test(null) : t.test(rec[t.col] ?? null)))))
  return { col, recs }
}

/** Numbers of the field among the matched records; an error there is the result. */
function numbers(a: Val[], ev: Ev): number[] {
  const { col, recs } = select(a, ev, false)
  const out: number[] = []
  for (const r of recs) {
    const v = r[col] ?? null
    if (v instanceof FormulaError) throw v
    if (typeof v === 'number') out.push(v)
  }
  return out
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)

function variance(xs: number[], sample: boolean): number {
  const n = xs.length
  if (n < (sample ? 2 : 1)) throw ERR.DIV0
  const m = sum(xs) / n
  let ss = 0
  for (const x of xs) ss += (x - m) * (x - m)
  return ss / (sample ? n - 1 : n)
}

const D = (f: (xs: number[]) => number): FnDef => A(3, 3, (a, ev) => f(numbers(a, ev)))

export const DATABASE: Record<string, FnDef> = {
  DSUM: D(sum),
  DAVERAGE: D((xs) => {
    if (!xs.length) throw ERR.DIV0
    return sum(xs) / xs.length
  }),
  DMAX: D((xs) => (xs.length ? Math.max(...xs) : 0)),
  DMIN: D((xs) => (xs.length ? Math.min(...xs) : 0)),
  DPRODUCT: D((xs) => (xs.length ? xs.reduce((p, x) => p * x, 1) : 0)),
  DSTDEV: D((xs) => Math.sqrt(variance(xs, true))),
  DSTDEVP: D((xs) => Math.sqrt(variance(xs, false))),
  DVAR: D((xs) => variance(xs, true)),
  DVARP: D((xs) => variance(xs, false)),
  // a blank field counts the records
  DCOUNT: A(3, 3, (a, ev) => {
    const { col, recs } = select(a, ev, true)
    return col < 0 ? recs.length : recs.filter((r) => typeof r[col] === 'number').length
  }),
  DCOUNTA: A(3, 3, (a, ev) => {
    const { col, recs } = select(a, ev, true)
    return col < 0 ? recs.length : recs.filter((r) => (r[col] ?? null) !== null).length
  }),
  DGET: A(3, 3, (a, ev) => {
    const { col, recs } = select(a, ev, false)
    if (!recs.length) throw ERR.VALUE
    if (recs.length > 1) throw ERR.NUM
    return recs[0][col] ?? null
  }),
}
