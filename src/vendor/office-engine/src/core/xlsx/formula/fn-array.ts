/** Dynamic array functions: sequences, filtering, sorting, reshaping, stacking, grouping, the LAMBDA helpers, matrices. */
import { A, INF, L, type Ev, type FnDef } from './fn'
import { ERR, FormulaError, type Value } from './types'
import { ArrayV, bool, compare, LambdaV, num, RangeV, UnionV, valueEq, type Val } from './values'

/** cells an array made from nothing may have (SEQUENCE, MAKEARRAY, EXPAND…): past it #NUM!, not a tab out of memory */
const MAX_CELLS = 10_000_000

type Grid = Value[][]

function grid(v: Val, ev: Ev): Grid {
  if (v instanceof UnionV) throw ERR.VALUE
  const d = ev.toArray(v)
  if (!d.length || !d[0].length) throw ERR.CALC
  return d
}

/** a single value of an argument (errors thrown) */
function one(v: Val, ev: Ev): Value {
  const x = ev.scalar(v)
  if (x instanceof FormulaError) throw x
  return x
}

const given = (a: Val[], i: number) => a.length > i && a[i] !== null

/** whole number argument `i`, or `def` when it is left out */
function whole(a: Val[], i: number, ev: Ev, def: number): number {
  return given(a, i) ? Math.trunc(num(one(a[i], ev))) : def
}

function flag(a: Val[], i: number, ev: Ev, def = false): boolean {
  return given(a, i) ? bool(one(a[i], ev)) : def
}

/** an array as the value a function gives (never empty: #CALC!) */
function out(rows: Grid): Val {
  if (!rows.length || !rows[0].length) throw ERR.CALC
  return new ArrayV(rows)
}

function sized(h: number, w: number) {
  if (h < 1 || w < 1) throw ERR.CALC
  if (h * w > MAX_CELLS) throw ERR.NUM
}

const transpose = (d: Grid): Grid => d[0].map((_, j) => d.map((row) => row[j]))

const blank = (v: Value) => v === null || v === ''

// ---------------------------------------------------------------- order

const kind = (v: Value) => (v === null ? 4 : typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : typeof v === 'boolean' ? 2 : 3)

/** sort order of two values: numbers, text, logicals, errors; empty cells last whatever the direction (`dir` -1: descending) */
export function order(a: Value, b: Value, dir = 1): number {
  const ka = kind(a)
  const kb = kind(b)
  if (ka === 4 || kb === 4) return ka === kb ? 0 : ka === 4 ? 1 : -1
  if (ka !== kb) return (ka - kb) * dir
  if (ka === 3) return 0
  return compare(a, b) * dir
}

/** the rows of `d` in the order of the keys (each: the values to sort by, one per row, and a direction) */
function sortRows(d: Grid, keys: { by: Value[]; dir: number }[]): Grid {
  const idx = d.map((_, i) => i)
  idx.sort((x, y) => {
    for (const k of keys) {
      const c = order(k.by[x], k.by[y], k.dir)
      if (c) return c
    }
    return x - y
  })
  return idx.map((i) => d[i])
}

const direction = (v: Value) => {
  const n = Math.trunc(num(v))
  if (n !== 1 && n !== -1) throw ERR.VALUE
  return n
}

/** the values of an argument as a flat list (a single value: a list of one) */
function list(v: Val, ev: Ev): Value[] {
  const d = grid(v, ev)
  return d.length === 1 ? d[0] : d.flat()
}

function sort(a: Val[], ev: Ev): Val {
  let d = grid(a[0], ev)
  const byCol = flag(a, 3, ev)
  if (byCol) d = transpose(d)
  const idx = given(a, 1) ? list(a[1], ev).map((v) => Math.trunc(num(v))) : [1]
  const dirs = given(a, 2) ? list(a[2], ev).map(direction) : [1]
  if (dirs.length !== 1 && dirs.length !== idx.length) throw ERR.VALUE
  const keys = idx.map((k, i) => {
    if (k < 1 || k > d[0].length) throw ERR.VALUE
    return { by: d.map((row) => row[k - 1]), dir: dirs.length === 1 ? dirs[0] : dirs[i] }
  })
  const res = sortRows(d, keys)
  return out(byCol ? transpose(res) : res)
}

function sortBy(a: Val[], ev: Ev): Val {
  const d = grid(a[0], ev)
  const keys: { by: Value[]; dir: number }[] = []
  let byCol: boolean | undefined
  for (let i = 1; i < a.length; i += 2) {
    const g = grid(a[i], ev)
    // a column as long as the array sorts its rows, a row as wide sorts its columns
    const col = g[0].length === 1 && g.length === d.length
    const row = g.length === 1 && g[0].length === d[0].length
    if (!col && !row) throw ERR.VALUE
    const cols = col && (byCol === undefined || !byCol) ? false : true
    if (byCol !== undefined && byCol !== cols) throw ERR.VALUE
    byCol = cols
    keys.push({ by: cols ? g[0] : g.map((r) => r[0]), dir: given(a, i + 1) ? direction(one(a[i + 1], ev)) : 1 })
  }
  if (byCol) return out(transpose(sortRows(transpose(d), keys)))
  return out(sortRows(d, keys))
}

/** rows that are equal, value for value (text without regard to case) */
const sameRow = (x: Value[], y: Value[]) => x.every((v, i) => same(v, y[i]))
const same = (a: Value, b: Value) => (a instanceof FormulaError || b instanceof FormulaError ? a instanceof FormulaError && b instanceof FormulaError && a.code === b.code : blank(a) && blank(b) ? true : valueEq(a, b))

const rowKey = (row: Value[]) =>
  row.map((v) => (v === null ? 's' : v instanceof FormulaError ? `e${v.code}` : typeof v === 'string' ? `s${v.toLowerCase()}` : typeof v === 'number' ? `n${v}` : `b${v}`)).join('\u0001')

/** the distinct rows, in the order they first come, with how many times each is there */
function distinct(d: Grid): { row: Value[]; n: number; first: number }[] {
  const seen = new Map<string, { row: Value[]; n: number; first: number }>()
  d.forEach((row, i) => {
    const k = rowKey(row)
    const hit = seen.get(k)
    if (hit) hit.n++
    else seen.set(k, { row, n: 1, first: i })
  })
  return [...seen.values()]
}

function unique(a: Val[], ev: Ev): Val {
  let d = grid(a[0], ev)
  const byCol = flag(a, 1, ev)
  const once = flag(a, 2, ev)
  if (byCol) d = transpose(d)
  const res = distinct(d)
    .filter((x) => !once || x.n === 1)
    .map((x) => x.row)
  if (!res.length) throw ERR.CALC
  return out(byCol ? transpose(res) : res)
}

function filter(a: Val[], ev: Ev): Val {
  const d = grid(a[0], ev)
  const inc = grid(a[1], ev)
  const keep = (v: Value): boolean => {
    if (v instanceof FormulaError) throw v
    if (typeof v === 'string') throw ERR.VALUE
    return v === true || (typeof v === 'number' && v !== 0)
  }
  let res: Grid
  if (inc[0].length === 1 && inc.length === d.length) res = d.filter((_, i) => keep(inc[i][0]))
  else if (inc.length === 1 && inc[0].length === d[0].length) {
    const cols = inc[0].map(keep)
    res = cols.some(Boolean) ? d.map((row) => row.filter((_, j) => cols[j])) : []
  } else throw ERR.VALUE
  if (!res.length) {
    if (a.length > 2) return a[2]
    throw ERR.CALC
  }
  return out(res)
}

// ---------------------------------------------------------------- shape

/** 1-based positions (negative: from the end) among `n`, as indexes */
function positions(args: Val[], ev: Ev, n: number): number[] {
  const res: number[] = []
  for (const x of args) {
    for (const v of list(x, ev)) {
      const k = Math.trunc(num(v))
      if (k === 0 || Math.abs(k) > n) throw ERR.VALUE
      res.push(k > 0 ? k - 1 : n + k)
    }
  }
  return res
}

/** the rows / columns TAKE keeps (`drop`: DROP leaves) of `n`, as [from, to) */
function span(n: number, k: number | undefined, drop: boolean): [number, number] {
  if (k === undefined) return [0, n]
  if (drop) return k >= 0 ? [Math.min(k, n), n] : [0, Math.max(0, n + k)]
  if (k === 0) throw ERR.CALC
  return k > 0 ? [0, Math.min(k, n)] : [Math.max(0, n + k), n]
}

function takeDrop(a: Val[], ev: Ev, drop: boolean): Val {
  const d = grid(a[0], ev)
  const [r0, r1] = span(d.length, given(a, 1) ? whole(a, 1, ev, 0) : undefined, drop)
  const [c0, c1] = span(d[0].length, given(a, 2) ? whole(a, 2, ev, 0) : undefined, drop)
  if (r1 <= r0 || c1 <= c0) throw ERR.CALC
  const src = a[0]
  // of a range, a range: what takes a reference (OFFSET, ROW…) still can
  if (src instanceof RangeV) return new RangeV(src.sheet, src.r0 + r0, src.c0 + c0, src.r0 + r1 - 1, src.c0 + c1 - 1)
  return out(d.slice(r0, r1).map((row) => row.slice(c0, c1)))
}

function stack(a: Val[], ev: Ev, vertical: boolean): Val {
  const parts = a.map((x) => (vertical ? grid(x, ev) : transpose(grid(x, ev))))
  const w = Math.max(...parts.map((p) => p[0].length))
  const rows: Grid = []
  for (const p of parts) for (const row of p) rows.push(row.length === w ? row : [...row, ...new Array<Value>(w - row.length).fill(ERR.NA)])
  sized(rows.length, w)
  return out(vertical ? rows : transpose(rows))
}

/** TOCOL / TOROW: the values one after another (`ignore` 1: not the empty ones, 2: not the errors, 3: neither) */
function flatten(a: Val[], ev: Ev): Value[] {
  const d = grid(a[0], ev)
  const ignore = whole(a, 1, ev, 0)
  if (ignore < 0 || ignore > 3) throw ERR.VALUE
  const src = flag(a, 2, ev) ? transpose(d) : d
  const res: Value[] = []
  for (const row of src)
    for (const v of row) {
      if (ignore & 1 && v === null) continue
      if (ignore & 2 && v instanceof FormulaError) continue
      res.push(v)
    }
  if (!res.length) throw ERR.CALC
  return res
}

function wrap(a: Val[], ev: Ev, byRows: boolean): Val {
  const d = grid(a[0], ev)
  if (d.length > 1 && d[0].length > 1) throw ERR.VALUE
  const xs = d.length === 1 ? d[0] : d.map((r) => r[0])
  const n = whole(a, 1, ev, 0)
  if (n < 1) throw ERR.NUM
  const pad: Value = a.length > 2 ? ev.scalar(a[2]) : ERR.NA
  // (a vector shorter than a line is one line, as long as it is)
  const width = Math.min(n, xs.length)
  const lines: Grid = []
  for (let i = 0; i < xs.length; i += n) {
    const line = xs.slice(i, i + n)
    while (line.length < width) line.push(pad)
    lines.push(line)
  }
  return out(byRows ? lines : transpose(lines))
}

function expand(a: Val[], ev: Ev): Val {
  const d = grid(a[0], ev)
  const h = given(a, 1) ? whole(a, 1, ev, 0) : d.length
  const w = given(a, 2) ? whole(a, 2, ev, 0) : d[0].length
  if (h < d.length || w < d[0].length) throw ERR.VALUE
  sized(h, w)
  const pad: Value = a.length > 3 ? ev.scalar(a[3]) : ERR.NA
  return out(Array.from({ length: h }, (_, i) => Array.from({ length: w }, (_, j) => (i < d.length && j < d[0].length ? d[i][j] : pad))))
}

function trimRange(a: Val[], ev: Ev): Val {
  const src = a[0]
  const d = grid(src, ev)
  const rows = whole(a, 1, ev, 3)
  const cols = whole(a, 2, ev, 3)
  if (rows < 0 || rows > 3 || cols < 0 || cols > 3) throw ERR.VALUE
  const emptyRow = (i: number) => d[i].every((v) => v === null)
  const emptyCol = (j: number) => d.every((row) => row[j] === null)
  let r0 = 0
  let r1 = d.length - 1
  let c0 = 0
  let c1 = d[0].length - 1
  if (rows & 1) while (r0 <= r1 && emptyRow(r0)) r0++
  if (rows & 2) while (r1 >= r0 && emptyRow(r1)) r1--
  if (cols & 1) while (c0 <= c1 && emptyCol(c0)) c0++
  if (cols & 2) while (c1 >= c0 && emptyCol(c1)) c1--
  if (r1 < r0 || c1 < c0) throw ERR.REF
  if (src instanceof RangeV) return new RangeV(src.sheet, src.r0 + r0, src.c0 + c0, src.r0 + r1, src.c0 + c1)
  return out(d.slice(r0, r1 + 1).map((row) => row.slice(c0, c1 + 1)))
}

// ---------------------------------------------------------------- LAMBDA helpers

/** the value a function value gives for one cell: a single value (an array inside an array is #CALC!) */
function cellOf(v: Val, ev: Ev): Value {
  if (v instanceof LambdaV || v instanceof UnionV) return ERR.CALC
  if (v instanceof RangeV || v instanceof ArrayV) {
    if (v.h !== 1 || v.w !== 1) return ERR.CALC
    return v instanceof RangeV ? ev.cell(v.sheet, v.r0, v.c0) : v.data[0][0]
  }
  return v
}

function fn(v: Val): LambdaV {
  if (v instanceof FormulaError) throw v
  if (!(v instanceof LambdaV)) throw ERR.VALUE
  return v
}

/** element (i, j) of an argument for a function value: of a range, the cell itself (a reference) */
function item(src: Val, d: Grid, i: number, j: number): Val {
  if (src instanceof RangeV) return new RangeV(src.sheet, src.r0 + i, src.c0 + j, src.r0 + i, src.c0 + j)
  return d[i][j]
}

/** row i (`vertical` false: column i) of an argument, a reference when the argument is one */
function line(src: Val, d: Grid, i: number, row: boolean): Val {
  if (src instanceof RangeV) return row ? new RangeV(src.sheet, src.r0 + i, src.c0, src.r0 + i, src.c1) : new RangeV(src.sheet, src.r0, src.c0 + i, src.r1, src.c0 + i)
  return new ArrayV(row ? [d[i]] : d.map((r) => [r[i]]))
}

function map(a: Val[], ev: Ev): Val {
  const f = fn(a[a.length - 1])
  const srcs = a.slice(0, -1)
  const ds = srcs.map((x) => grid(x, ev))
  const h = Math.max(...ds.map((d) => d.length))
  const w = Math.max(...ds.map((d) => d[0].length))
  return out(
    Array.from({ length: h }, (_, i) =>
      Array.from({ length: w }, (_, j) => {
        // (arrays of different sizes: #N/A where one has no value)
        const args = ds.map((d, k): Val => (i < d.length && j < d[0].length ? item(srcs[k], d, i, j) : ERR.NA))
        return cellOf(ev.invoke(f, args), ev)
      }),
    ),
  )
}

function reduce(a: Val[], ev: Ev, scan: boolean): Val {
  const f = fn(a[2])
  const d = grid(a[1], ev)
  let acc: Val | undefined = a[0] === null ? undefined : a[0]
  const res: Grid = []
  for (let i = 0; i < d.length; i++) {
    const row: Value[] = []
    for (let j = 0; j < d[0].length; j++) {
      const x = item(a[1], d, i, j)
      // without a start, the first value is the start
      acc = acc === undefined ? (x instanceof RangeV ? ev.cell(x.sheet, x.r0, x.c0) : x) : ev.invoke(f, [acc, x])
      if (scan) row.push(cellOf(acc, ev))
    }
    res.push(row)
  }
  if (scan) return out(res)
  return acc === undefined ? ERR.CALC : acc
}

function byLine(a: Val[], ev: Ev, rows: boolean): Val {
  const f = fn(a[1])
  const d = grid(a[0], ev)
  const n = rows ? d.length : d[0].length
  const res = Array.from({ length: n }, (_, i) => cellOf(ev.invoke(f, [line(a[0], d, i, rows)]), ev))
  return out(rows ? res.map((v) => [v]) : [res])
}

// ---------------------------------------------------------------- matrices

function matrix(v: Val, ev: Ev): number[][] {
  return grid(v, ev).map((row) =>
    row.map((x) => {
      if (x instanceof FormulaError) throw x
      if (typeof x !== 'number') throw ERR.VALUE
      return x
    }),
  )
}

/** LU decomposition with partial pivoting, in place: the sign of the permutation, 0 when the matrix is singular */
function lu(m: number[][], perm: number[]): number {
  const n = m.length
  let sign = 1
  for (let k = 0; k < n; k++) {
    let p = k
    for (let i = k + 1; i < n; i++) if (Math.abs(m[i][k]) > Math.abs(m[p][k])) p = i
    if (m[p][k] === 0) return 0
    if (p !== k) {
      ;[m[p], m[k]] = [m[k], m[p]]
      ;[perm[p], perm[k]] = [perm[k], perm[p]]
      sign = -sign
    }
    for (let i = k + 1; i < n; i++) {
      const f = (m[i][k] /= m[k][k])
      if (f !== 0) for (let j = k + 1; j < n; j++) m[i][j] -= f * m[k][j]
    }
  }
  return sign
}

function determinant(src: number[][]): number {
  const n = src.length
  if (src.some((r) => r.length !== n)) throw ERR.VALUE
  const m = src.map((r) => r.slice())
  const sign = lu(
    m,
    m.map((_, i) => i),
  )
  if (!sign) return 0
  let det = sign
  for (let i = 0; i < n; i++) det *= m[i][i]
  return det
}

function inverse(src: number[][]): number[][] {
  const n = src.length
  if (src.some((r) => r.length !== n)) throw ERR.VALUE
  const m = src.map((r) => r.slice())
  const perm = m.map((_, i) => i)
  if (!lu(m, perm)) throw ERR.NUM
  // what is left of the pivots against the size of the matrix tells a singular one from rounding
  const scale = Math.max(...src.map((r) => Math.max(...r.map(Math.abs))))
  for (let i = 0; i < n; i++) if (Math.abs(m[i][i]) < scale * 1e-15) throw ERR.NUM
  const inv: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let c = 0; c < n; c++) {
    // solve L U x = P e_c
    const x = new Array<number>(n).fill(0)
    for (let i = 0; i < n; i++) {
      let s = perm[i] === c ? 1 : 0
      for (let j = 0; j < i; j++) s -= m[i][j] * x[j]
      x[i] = s
    }
    for (let i = n - 1; i >= 0; i--) {
      let s = x[i]
      for (let j = i + 1; j < n; j++) s -= m[i][j] * x[j]
      x[i] = s / m[i][i]
    }
    for (let i = 0; i < n; i++) inv[i][c] = x[i]
  }
  return inv
}

// ---------------------------------------------------------------- GROUPBY / PIVOTBY

/** the headers an argument has: 0 none, 1 yes (not shown), 2 none (made up), 3 yes (shown); left out: yes when the values start with a text over a number */
function headerMode(a: Val[], i: number, ev: Ev, values: Grid): { has: boolean; show: boolean } {
  if (given(a, i)) {
    const n = whole(a, i, ev, 0)
    if (n < 0 || n > 3) throw ERR.VALUE
    return { has: n === 1 || n === 3, show: n >= 2 }
  }
  const has = values.length > 1 && typeof values[0][0] === 'string' && typeof values[1][0] === 'number'
  return { has, show: has }
}

/** the aggregate a function value gives of the values of a group (and of all the values, for one that takes both: PERCENTOF) */
function aggregate(f: LambdaV, ev: Ev, vals: Value[], all: Value[]): Value {
  const col = (xs: Value[]) => new ArrayV(xs.length ? xs.map((v) => [v]) : [[null]])
  const args: Val[] = f.min === 2 ? [col(vals), col(all)] : [col(vals)]
  return cellOf(ev.invoke(f, args), ev)
}

interface Group {
  key: Value[]
  rows: number[]
}

function groups(fields: Grid, rows: number[]): Group[] {
  const seen = new Map<string, Group>()
  for (const i of rows) {
    const k = rowKey(fields[i])
    const g = seen.get(k)
    if (g) g.rows.push(i)
    else seen.set(k, { key: fields[i], rows: [i] })
  }
  return [...seen.values()]
}

/** `sort_order`: column numbers of the result to sort by, negative for descending; left out: by the fields, ascending */
function sortOrder(a: Val[], i: number, ev: Ev, def: number[]): number[] {
  if (!given(a, i)) return def
  return list(a[i], ev).map((v) => Math.trunc(num(v)))
}

function sortGroups<T>(items: T[], spec: number[], col: (item: T, k: number) => Value) {
  items.sort((x, y) => {
    for (const s of spec) {
      const c = order(col(x, Math.abs(s) - 1), col(y, Math.abs(s) - 1), s < 0 ? -1 : 1)
      if (c) return c
    }
    return 0
  })
}

function split(v: Val, ev: Ev, has: boolean): { head: Value[]; body: Grid } {
  const d = grid(v, ev)
  return has ? { head: d[0], body: d.slice(1) } : { head: d[0].map(() => null), body: d }
}

function included(a: Val[], i: number, ev: Ev, n: number, has: boolean): number[] {
  const all = Array.from({ length: n }, (_, k) => k)
  if (!given(a, i)) return all
  let f = list(a[i], ev)
  if (has && f.length === n + 1) f = f.slice(1)
  if (f.length !== n) throw ERR.VALUE
  return all.filter((k) => {
    const v = f[k]
    if (v instanceof FormulaError) throw v
    return v === true || (typeof v === 'number' && v !== 0)
  })
}

function groupBy(a: Val[], ev: Ev): Val {
  const f = fn(a[2])
  const mode = headerMode(a, 3, ev, grid(a[1], ev))
  const fields = split(a[0], ev, mode.has)
  const values = split(a[1], ev, mode.has)
  if (fields.body.length !== values.body.length) throw ERR.VALUE
  const depth = given(a, 4) ? whole(a, 4, ev, 0) : 1
  if (depth < -2 || depth > 2) throw ERR.VALUE
  const nf = fields.body[0]?.length ?? 0
  const nv = values.body[0]?.length ?? 0
  const rows = included(a, 6, ev, fields.body.length, mode.has)
  const column = (k: number, of: number[]) => of.map((i) => values.body[i][k])
  const row = (key: Value[], of: number[]): Value[] => [...key, ...Array.from({ length: nv }, (_, k) => aggregate(f, ev, column(k, of), column(k, rows)))]
  const gs = groups(fields.body, rows).map((g) => ({ ...g, out: row(g.key, g.rows) }))
  sortGroups(gs, sortOrder(a, 5, ev, Array.from({ length: nf }, (_, k) => k + 1)), (g, k) => {
    if (k < 0 || k >= nf + nv) throw ERR.VALUE
    return g.out[k]
  })
  const res: Grid = []
  const total = (label: string, key: Value[], of: number[]) => row([...key, label, ...new Array<Value>(Math.max(0, nf - key.length - 1)).fill('')], of)
  const subs = Math.abs(depth) === 2 && nf > 1
  if (subs) {
    // the groups of the first field together, each with its own total (before it when the totals go on top)
    for (const top of groups(gs.map((g) => [g.key[0]]), gs.map((_, i) => i))) {
      const body = top.rows.map((i) => gs[i].out)
      const sub = total('', [top.key[0]], top.rows.flatMap((i) => gs[i].rows))
      if (depth < 0) res.push(sub, ...body)
      else res.push(...body, sub)
    }
  } else for (const g of gs) res.push(g.out)
  if (depth !== 0 && rows.length) {
    const grand = total(subs ? 'Grand Total' : 'Total', [], rows)
    if (depth < 0) res.unshift(grand)
    else res.push(grand)
  }
  if (mode.show) res.unshift([...fields.head, ...values.head].map((v) => (v === null ? '' : v)))
  return out(res)
}

function pivotBy(a: Val[], ev: Ev): Val {
  const f = fn(a[3])
  const mode = headerMode(a, 4, ev, grid(a[2], ev))
  const rf = split(a[0], ev, mode.has)
  const cf = split(a[1], ev, mode.has)
  const values = split(a[2], ev, mode.has)
  const n = values.body.length
  if (rf.body.length !== n || cf.body.length !== n) throw ERR.VALUE
  if ((values.body[0]?.length ?? 0) !== 1) throw ERR.VALUE
  const rowDepth = given(a, 5) ? whole(a, 5, ev, 0) : 1
  const colDepth = given(a, 7) ? whole(a, 7, ev, 0) : 1
  const rows = included(a, 9, ev, n, mode.has)
  const nr = rf.body[0]?.length ?? 0
  const nc = cf.body[0]?.length ?? 0
  const vals = (of: number[]) => of.map((i) => values.body[i][0])
  const all = vals(rows)
  const rg = groups(rf.body, rows)
  const cg = groups(cf.body, rows)
  sortGroups(rg, sortOrder(a, 6, ev, Array.from({ length: nr }, (_, k) => k + 1)), (g, k) => g.key[Math.min(k, nr - 1)])
  sortGroups(cg, sortOrder(a, 8, ev, Array.from({ length: nc }, (_, k) => k + 1)), (g, k) => g.key[Math.min(k, nc - 1)])
  const res: Grid = []
  // the column fields, one row each, over the columns of values
  for (let k = 0; k < nc; k++) {
    const head: Value[] = new Array<Value>(nr).fill('')
    for (const c of cg) head.push(c.key[k] ?? '')
    if (colDepth !== 0) head.push(k === 0 ? 'Total' : '')
    res.push(head)
  }
  const line = (key: Value[], of: number[]): Value[] => {
    const inRow = new Set(of)
    const cells = cg.map((c) => {
      const hit = c.rows.filter((i) => inRow.has(i))
      return hit.length ? aggregate(f, ev, vals(hit), all) : ''
    })
    if (colDepth !== 0) cells.push(aggregate(f, ev, vals(of), all))
    return [...key, ...cells]
  }
  const body = rg.map((g) => line(g.key, g.rows))
  if (rowDepth !== 0 && rows.length) {
    const grand = line(['Total', ...new Array<Value>(Math.max(0, nr - 1)).fill('')], rows)
    if (rowDepth < 0) body.unshift(grand)
    else body.push(grand)
  }
  res.push(...body)
  return out(res)
}

// ---------------------------------------------------------------- registry

export const ARRAY: Record<string, FnDef> = {
  SEQUENCE: A(1, 4, (a, ev) => {
    const h = whole(a, 0, ev, 1)
    const w = whole(a, 1, ev, 1)
    const start = given(a, 2) ? num(one(a[2], ev)) : 1
    const step = given(a, 3) ? num(one(a[3], ev)) : 1
    if (h < 0 || w < 0) throw ERR.VALUE
    sized(h, w)
    return out(Array.from({ length: h }, (_, i) => Array.from({ length: w }, (_, j) => start + step * (i * w + j))))
  }),
  RANDARRAY: A(0, 5, (a, ev) => {
    const h = whole(a, 0, ev, 1)
    const w = whole(a, 1, ev, 1)
    const lo = given(a, 2) ? num(one(a[2], ev)) : 0
    const hi = given(a, 3) ? num(one(a[3], ev)) : 1
    const int = flag(a, 4, ev)
    if (h < 0 || w < 0 || lo > hi || (int && (!Number.isInteger(lo) || !Number.isInteger(hi)))) throw ERR.VALUE
    sized(h, w)
    return out(Array.from({ length: h }, () => Array.from({ length: w }, () => (int ? lo + Math.floor(Math.random() * (hi - lo + 1)) : lo + Math.random() * (hi - lo)))))
  }),
  TRANSPOSE: A(1, 1, ([v], ev) => out(transpose(grid(v, ev)))),
  FILTER: A(2, 3, filter),
  SORT: A(1, 4, sort),
  SORTBY: A(2, INF, sortBy),
  UNIQUE: A(1, 3, unique),
  CHOOSECOLS: A(2, INF, (a, ev) => {
    const d = grid(a[0], ev)
    const idx = positions(a.slice(1), ev, d[0].length)
    return out(d.map((row) => idx.map((j) => row[j])))
  }),
  CHOOSEROWS: A(2, INF, (a, ev) => {
    const d = grid(a[0], ev)
    return out(positions(a.slice(1), ev, d.length).map((i) => d[i]))
  }),
  HSTACK: A(1, INF, (a, ev) => stack(a, ev, false)),
  VSTACK: A(1, INF, (a, ev) => stack(a, ev, true)),
  TOCOL: A(1, 3, (a, ev) => out(flatten(a, ev).map((v) => [v]))),
  TOROW: A(1, 3, (a, ev) => out([flatten(a, ev)])),
  WRAPCOLS: A(2, 3, (a, ev) => wrap(a, ev, false)),
  WRAPROWS: A(2, 3, (a, ev) => wrap(a, ev, true)),
  TAKE: A(2, 3, (a, ev) => takeDrop(a, ev, false)),
  DROP: A(2, 3, (a, ev) => takeDrop(a, ev, true)),
  EXPAND: A(2, 4, expand),
  TRIMRANGE: A(1, 3, trimRange),
  GROUPBY: A(3, 8, groupBy),
  PIVOTBY: A(4, 11, pivotBy),

  MAP: A(2, INF, map),
  REDUCE: A(3, 3, (a, ev) => reduce(a, ev, false)),
  SCAN: A(3, 3, (a, ev) => reduce(a, ev, true)),
  BYROW: A(2, 2, (a, ev) => byLine(a, ev, true)),
  BYCOL: A(2, 2, (a, ev) => byLine(a, ev, false)),
  MAKEARRAY: A(3, 3, (a, ev) => {
    const h = whole(a, 0, ev, 0)
    const w = whole(a, 1, ev, 0)
    const f = fn(a[2])
    if (h < 1 || w < 1) throw ERR.VALUE
    sized(h, w)
    return out(Array.from({ length: h }, (_, i) => Array.from({ length: w }, (_, j) => cellOf(ev.invoke(f, [i + 1, j + 1]), ev))))
  }),

  MMULT: A(2, 2, (a, ev) => {
    const x = matrix(a[0], ev)
    const y = matrix(a[1], ev)
    if (x[0].length !== y.length) throw ERR.VALUE
    return out(
      x.map((row) =>
        y[0].map((_, j) => {
          let s = 0
          for (let k = 0; k < y.length; k++) s += row[k] * y[k][j]
          if (!Number.isFinite(s)) throw ERR.NUM
          return s
        }),
      ),
    )
  }),
  MDETERM: A(1, 1, ([v], ev) => {
    const d = determinant(matrix(v, ev))
    if (!Number.isFinite(d)) throw ERR.NUM
    return d
  }),
  MINVERSE: A(1, 1, ([v], ev) => out(inverse(matrix(v, ev)))),
  MUNIT: A(1, 1, ([v], ev) => {
    const n = Math.trunc(num(one(v, ev)))
    if (n < 1) throw ERR.VALUE
    sized(n, n)
    return out(Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))))
  }),

  // Google Sheets
  ARRAYFORMULA: L(1, 1, (a, ev) => ev.eval(a[0], false)),
  FLATTEN: A(1, INF, (a, ev) => out(a.flatMap((x) => grid(x, ev).flat()).map((v) => [v]))),
  ARRAY_CONSTRAIN: A(3, 3, (a, ev) => {
    const d = grid(a[0], ev)
    const h = whole(a, 1, ev, 0)
    const w = whole(a, 2, ev, 0)
    if (h < 1 || w < 1) throw ERR.VALUE
    return out(d.slice(0, h).map((row) => row.slice(0, w)))
  }),
  SORTN: A(1, INF, (a, ev) => {
    const d = grid(a[0], ev)
    const n = whole(a, 1, ev, 1)
    const ties = whole(a, 2, ev, 0)
    if (n < 0 || ties < 0 || ties > 3) throw ERR.VALUE
    const keys: { by: Value[]; dir: number }[] = []
    for (let i = 3; i < a.length; i += 2) {
      const col = grid(a[i], ev)
      // a column of the range by its number, or a column of values as long as it
      const by = col.length === 1 && col[0].length === 1 ? d.map((row) => row[Math.trunc(num(col[0][0])) - 1]) : col.map((r) => r[0])
      if (by.length !== d.length || by.some((v) => v === undefined)) throw ERR.VALUE
      keys.push({ by, dir: flag(a, i + 1, ev, true) ? 1 : -1 })
    }
    if (!keys.length) keys.push({ by: d.map((row) => row[0]), dir: 1 })
    const idx = d.map((_, i) => i)
    const cmp = (x: number, y: number) => {
      for (const k of keys) {
        const c = order(k.by[x], k.by[y], k.dir)
        if (c) return c
      }
      return 0
    }
    idx.sort((x, y) => cmp(x, y) || x - y)
    let pick: number[]
    if (ties === 0) pick = idx.slice(0, n)
    // 1: and the rows that tie with the last one; 2: the first n of the distinct rows; 3: the first n distinct rows, with their duplicates
    else if (ties === 1) pick = idx.filter((x, i) => i < n || (n > 0 && cmp(x, idx[n - 1]) === 0))
    else {
      const firsts: number[] = []
      for (const x of idx) if (!firsts.some((y) => sameRow(d[x], d[y]))) firsts.push(x)
      const kept = firsts.slice(0, n)
      pick = ties === 2 ? kept : idx.filter((x) => kept.some((y) => sameRow(d[x], d[y])))
    }
    if (!pick.length) throw ERR.NA
    return out(pick.map((i) => d[i]))
  }),
}
