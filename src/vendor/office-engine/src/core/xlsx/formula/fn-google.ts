/** Functions Google Sheets has and Excel does not: the operators as functions, the format converters, QUERY. */
import { dateToSerial, parseDateText, serialSeconds, serialToYmd } from './dates'
import { A, S, type Ev, type FnDef } from './fn'
import { binop } from './ops'
import type { BinOp } from './parser'
import { colIndex } from './refs'
import { ERR, FormulaError, type Value } from './types'
import { ArrayV, bool, compare, num, numToText, RangeV, str, UnionV, type Val } from './values'

const op = (o: BinOp) => S(2, 2, ([a, b]) => binop(o, a, b))

// ---------------------------------------------------------------- QUERY

type Expr =
  | { t: 'col'; i: number }
  | { t: 'lit'; v: Value }
  | { t: 'agg'; fn: string; arg: Expr }
  | { t: 'call'; fn: string; args: Expr[] }
  | { t: 'bin'; op: string; l: Expr; r: Expr }
  | { t: 'not'; e: Expr }
  | { t: 'null'; e: Expr; not: boolean }

interface Tok {
  k: 'id' | 'str' | 'num' | 'p'
  v: string
}

const AGGS = new Set(['sum', 'avg', 'count', 'max', 'min'])
const CLAUSES = ['select', 'where', 'group', 'pivot', 'order', 'limit', 'offset', 'label', 'format', 'options']

function lexQuery(q: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < q.length) {
    const ch = q[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const j = q.indexOf(ch, i + 1)
      if (j < 0) throw ERR.VALUE
      out.push({ k: ch === '`' ? 'id' : 'str', v: q.slice(i + 1, j) })
      i = j + 1
      continue
    }
    let m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(q.slice(i))
    if (m) {
      out.push({ k: 'num', v: m[0] })
      i += m[0].length
      continue
    }
    m = /^[A-Za-z_][\w]*/.exec(q.slice(i))
    if (m) {
      out.push({ k: 'id', v: m[0] })
      i += m[0].length
      continue
    }
    m = /^(<=|>=|<>|!=|[=<>+\-*/(),])/.exec(q.slice(i))
    if (!m) throw ERR.VALUE
    out.push({ k: 'p', v: m[0] })
    i += m[0].length
  }
  return out
}

interface Query {
  select: Expr[] | null
  where?: Expr
  group: Expr[]
  order: { e: Expr; desc: boolean }[]
  limit?: number
  offset?: number
  labels: { e: Expr; text: string }[]
}

class QueryParser {
  i = 0
  constructor(
    private readonly toks: Tok[],
    /** the column a name stands for: a letter of the sheet, or Col1, Col2… */
    private readonly column: (name: string) => number,
  ) {}

  private kw(...words: string[]): boolean {
    for (let k = 0; k < words.length; k++) {
      const t = this.toks[this.i + k]
      if (!t || t.k !== 'id' || t.v.toLowerCase() !== words[k]) return false
    }
    this.i += words.length
    return true
  }
  private p(v: string): boolean {
    const t = this.toks[this.i]
    if (t && t.k === 'p' && t.v === v) {
      this.i++
      return true
    }
    return false
  }
  private atClause(): boolean {
    const t = this.toks[this.i]
    return !t || (t.k === 'id' && CLAUSES.includes(t.v.toLowerCase()))
  }

  parse(): Query {
    const q: Query = { select: null, group: [], order: [], labels: [] }
    if (this.kw('select')) q.select = this.p('*') ? null : this.list()
    if (this.kw('where')) q.where = this.or()
    if (this.kw('group', 'by')) q.group = this.list()
    // a pivot gives one column per value: not done
    if (this.kw('pivot')) throw ERR.VALUE
    if (this.kw('order', 'by')) {
      do {
        const e = this.sum()
        const desc = this.kw('desc')
        if (!desc) this.kw('asc')
        q.order.push({ e, desc })
      } while (this.p(','))
    }
    if (this.kw('limit')) q.limit = this.count()
    if (this.kw('offset')) q.offset = this.count()
    if (this.kw('label')) {
      do {
        const e = this.sum()
        const t = this.toks[this.i++]
        if (!t || t.k !== 'str') throw ERR.VALUE
        q.labels.push({ e, text: t.v })
      } while (this.p(','))
    }
    // how the values show is the cell's business, and the options are of the service
    if (this.kw('format')) while (!this.atClause()) this.i++
    if (this.kw('options')) while (!this.atClause()) this.i++
    if (this.i < this.toks.length) throw ERR.VALUE
    return q
  }

  private count(): number {
    const t = this.toks[this.i++]
    if (!t || t.k !== 'num') throw ERR.VALUE
    return Math.trunc(Number(t.v))
  }
  private list(): Expr[] {
    const out = [this.sum()]
    while (this.p(',')) out.push(this.sum())
    return out
  }
  private or(): Expr {
    let l = this.and()
    while (this.kw('or')) l = { t: 'bin', op: 'or', l, r: this.and() }
    return l
  }
  private and(): Expr {
    let l = this.not()
    while (this.kw('and')) l = { t: 'bin', op: 'and', l, r: this.not() }
    return l
  }
  private not(): Expr {
    if (this.kw('not')) return { t: 'not', e: this.not() }
    return this.cmp()
  }
  private cmp(): Expr {
    const l = this.sum()
    if (this.kw('is', 'not', 'null')) return { t: 'null', e: l, not: true }
    if (this.kw('is', 'null')) return { t: 'null', e: l, not: false }
    for (const [words, name] of [
      [['starts', 'with'], 'starts'],
      [['ends', 'with'], 'ends'],
      [['contains'], 'contains'],
      [['matches'], 'matches'],
      [['like'], 'like'],
    ] as [string[], string][])
      if (this.kw(...words)) return { t: 'bin', op: name, l, r: this.sum() }
    const t = this.toks[this.i]
    if (t && t.k === 'p' && ['=', '!=', '<>', '<', '<=', '>', '>='].includes(t.v)) {
      this.i++
      return { t: 'bin', op: t.v === '!=' ? '<>' : t.v, l, r: this.sum() }
    }
    return l
  }
  private sum(): Expr {
    let l = this.product()
    for (;;) {
      if (this.p('+')) l = { t: 'bin', op: '+', l, r: this.product() }
      else if (this.p('-')) l = { t: 'bin', op: '-', l, r: this.product() }
      else return l
    }
  }
  private product(): Expr {
    let l = this.atom()
    for (;;) {
      if (this.p('*')) l = { t: 'bin', op: '*', l, r: this.atom() }
      else if (this.p('/')) l = { t: 'bin', op: '/', l, r: this.atom() }
      else return l
    }
  }
  private atom(): Expr {
    const t = this.toks[this.i++]
    if (!t) throw ERR.VALUE
    if (t.k === 'num') return { t: 'lit', v: Number(t.v) }
    if (t.k === 'str') return { t: 'lit', v: t.v }
    if (t.k === 'p') {
      if (t.v === '(') {
        const e = this.or()
        if (!this.p(')')) throw ERR.VALUE
        return e
      }
      if (t.v === '-') {
        const e = this.atom()
        return { t: 'bin', op: '-', l: { t: 'lit', v: 0 }, r: e }
      }
      throw ERR.VALUE
    }
    const lc = t.v.toLowerCase()
    if (lc === 'true' || lc === 'false') return { t: 'lit', v: lc === 'true' }
    // date '2024-01-15', datetime '2024-01-15 10:00:00', timeofday '10:00:00'
    if (lc === 'date' || lc === 'datetime' || lc === 'timeofday' || lc === 'timestamp') {
      const s = this.toks[this.i]
      if (s && s.k === 'str') {
        this.i++
        const n = parseDateText(s.v.trim())
        if (n === null) throw ERR.VALUE
        return { t: 'lit', v: n }
      }
    }
    if (this.p('(')) {
      const args: Expr[] = []
      if (!this.p(')')) {
        do args.push(this.or())
        while (this.p(','))
        if (!this.p(')')) throw ERR.VALUE
      }
      if (AGGS.has(lc)) {
        if (args.length !== 1) throw ERR.VALUE
        return { t: 'agg', fn: lc, arg: args[0] }
      }
      return { t: 'call', fn: lc, args }
    }
    return { t: 'col', i: this.column(t.v) }
  }
}

const hasAgg = (e: Expr): boolean =>
  e.t === 'agg' || (e.t === 'bin' && (hasAgg(e.l) || hasAgg(e.r))) || (e.t === 'call' && e.args.some(hasAgg)) || ((e.t === 'not' || e.t === 'null') && hasAgg(e.e))

const sameExpr = (a: Expr, b: Expr) => JSON.stringify(a) === JSON.stringify(b)

const likeRe = (pat: string) => new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '[\\s\\S]*').replace(/_/g, '[\\s\\S]')}$`)

function scalarFn(name: string, a: Value[], ev: Ev): Value {
  const d = (v: Value) => {
    if (typeof v !== 'number') throw ERR.VALUE
    return v
  }
  if (a.some((v) => v === null) && name !== 'now') return null
  switch (name) {
    case 'year':
      return serialToYmd(d(a[0])).y
    // (months count from 0 in the query language)
    case 'month':
      return serialToYmd(d(a[0])).m - 1
    case 'day':
      return serialToYmd(d(a[0])).d
    case 'quarter':
      return Math.floor((serialToYmd(d(a[0])).m - 1) / 3) + 1
    case 'dayofweek':
      return serialToYmd(d(a[0])).dow + 1
    case 'hour':
      return Math.floor(serialSeconds(d(a[0])) / 3600)
    case 'minute':
      return Math.floor((serialSeconds(d(a[0])) % 3600) / 60)
    case 'second':
      return serialSeconds(d(a[0])) % 60
    case 'now':
      return dateToSerial(ev.now())
    case 'datediff':
      return Math.floor(d(a[0])) - Math.floor(d(a[1]))
    case 'todate':
      return Math.floor(d(a[0]))
    case 'upper':
      return str(a[0]).toUpperCase()
    case 'lower':
      return str(a[0]).toLowerCase()
  }
  throw ERR.VALUE
}

/** the value of an expression for a row; `rows`: the rows of its group, when the query aggregates */
function evalExpr(e: Expr, row: Value[], rows: Value[][] | undefined, ev: Ev): Value {
  switch (e.t) {
    case 'col':
      return row[e.i] ?? null
    case 'lit':
      return e.v
    case 'null':
      return (evalExpr(e.e, row, rows, ev) === null) !== e.not
    case 'not':
      return evalExpr(e.e, row, rows, ev) !== true
    case 'call':
      return scalarFn(
        e.fn,
        e.args.map((x) => evalExpr(x, row, rows, ev)),
        ev,
      )
    case 'agg': {
      if (!rows) throw ERR.VALUE
      const vals = rows.map((r) => evalExpr(e.arg, r, undefined, ev)).filter((v) => v !== null)
      if (e.fn === 'count') return vals.length
      if (!vals.length) return null
      if (e.fn === 'max' || e.fn === 'min') return vals.reduce((m, v) => ((e.fn === 'max' ? compare(v, m) > 0 : compare(v, m) < 0) ? v : m))
      const ns = vals.filter((v): v is number => typeof v === 'number')
      if (ns.length !== vals.length) throw ERR.VALUE
      const s = ns.reduce((x, y) => x + y, 0)
      return e.fn === 'sum' ? s : s / ns.length
    }
    case 'bin': {
      if (e.op === 'and') return evalExpr(e.l, row, rows, ev) === true && evalExpr(e.r, row, rows, ev) === true
      if (e.op === 'or') return evalExpr(e.l, row, rows, ev) === true || evalExpr(e.r, row, rows, ev) === true
      const l = evalExpr(e.l, row, rows, ev)
      const r = evalExpr(e.r, row, rows, ev)
      if (l instanceof FormulaError || r instanceof FormulaError) return e.op.length <= 2 && /[<>=]/.test(e.op) ? false : l instanceof FormulaError ? l : r
      switch (e.op) {
        case '+':
        case '-':
        case '*':
        case '/':
          if (l === null || r === null) return null
          if (typeof l !== 'number' || typeof r !== 'number') throw ERR.VALUE
          if (e.op === '/' && r === 0) return null
          return e.op === '+' ? l + r : e.op === '-' ? l - r : e.op === '*' ? l * r : l / r
        case 'contains':
          return typeof l === 'string' && l.includes(str(r))
        case 'starts':
          return typeof l === 'string' && l.startsWith(str(r))
        case 'ends':
          return typeof l === 'string' && l.endsWith(str(r))
        case 'matches':
          return typeof l === 'string' && new RegExp(`^(?:${str(r)})$`).test(l)
        case 'like':
          return typeof l === 'string' && likeRe(str(r)).test(l)
      }
      // a comparison with nothing holds for <> only; text is compared as written (case matters)
      if (l === null || r === null) return e.op === '<>' ? l !== r : e.op === '=' ? l === r : false
      if (typeof l !== typeof r) return e.op === '<>'
      const c = typeof l === 'string' ? (l < (r as string) ? -1 : l > (r as string) ? 1 : 0) : compare(l, r)
      return e.op === '=' ? c === 0 : e.op === '<>' ? c !== 0 : e.op === '<' ? c < 0 : e.op === '<=' ? c <= 0 : e.op === '>' ? c > 0 : c >= 0
    }
  }
}

function query(a: Val[], ev: Ev): Val {
  const src = a[0]
  if (src instanceof UnionV) throw ERR.VALUE
  const data = ev.toArray(src)
  const text = str(ev.scalar(a[1]))
  const w = data[0]?.length ?? 0
  let headers = a.length > 2 && a[2] !== null ? Math.trunc(num(ev.scalar(a[2]))) : -1
  if (headers < 0) {
    // a first row of text over values of another kind is a row of headers
    const first = data[0] ?? []
    const textual = first.some((v) => v !== null) && first.every((v) => v === null || typeof v === 'string')
    headers = textual && data.slice(1).some((row) => row.some((v, j) => v !== null && typeof v !== 'string' && first[j] !== null)) ? 1 : 0
  }
  headers = Math.min(headers, data.length)
  const names = Array.from({ length: w }, (_, j) =>
    data
      .slice(0, headers)
      .map((row) => (row[j] === null ? '' : str(row[j])))
      .filter(Boolean)
      .join(' '),
  )
  const base = src instanceof RangeV ? src.c0 : -1
  const column = (name: string): number => {
    const m = /^col(\d+)$/i.exec(name)
    let i = m ? Number(m[1]) - 1 : -1
    if (!m && base >= 0 && /^[A-Za-z]{1,3}$/.test(name)) i = colIndex(name) - base
    if (i < 0 || i >= w) throw ERR.VALUE
    return i
  }
  const q = new QueryParser(lexQuery(text), column).parse()
  let rows = data.slice(headers)
  if (q.where) rows = rows.filter((row) => evalExpr(q.where!, row, undefined, ev) === true)
  const select: Expr[] = q.select ?? Array.from({ length: w }, (_, i): Expr => ({ t: 'col', i }))
  const grouped = q.group.length > 0 || select.some(hasAgg)
  let result: { out: Value[]; row: Value[]; rows?: Value[][] }[]
  if (grouped) {
    // what is selected beside the aggregates must be what the rows are grouped by
    for (const e of select) if (!hasAgg(e) && !q.group.some((g) => sameExpr(g, e))) throw ERR.VALUE
    const buckets = new Map<string, Value[][]>()
    for (const row of rows) {
      const key = q.group.map((g) => JSON.stringify(evalExpr(g, row, undefined, ev))).join('\u0001')
      const b = buckets.get(key)
      if (b) b.push(row)
      else buckets.set(key, [row])
    }
    if (!q.group.length && !buckets.size) buckets.set('', [])
    result = [...buckets.values()].map((rs) => ({ out: select.map((e) => evalExpr(e, rs[0] ?? [], rs, ev)), row: rs[0] ?? [], rows: rs }))
    // groups come in the order of what they are grouped by, unless the query orders them
    if (!q.order.length) result.sort((x, y) => cmpList(q.group.map((g) => evalExpr(g, x.row, x.rows, ev)), q.group.map((g) => evalExpr(g, y.row, y.rows, ev))))
  } else result = rows.map((row) => ({ out: select.map((e) => evalExpr(e, row, undefined, ev)), row }))
  if (q.order.length) {
    const keys = result.map((r) => q.order.map((o) => evalExpr(o.e, r.row, r.rows, ev)))
    const idx = result.map((_, i) => i)
    idx.sort((x, y) => {
      for (let k = 0; k < q.order.length; k++) {
        const c = cmpNull(keys[x][k], keys[y][k])
        if (c) return q.order[k].desc ? -c : c
      }
      return x - y
    })
    result = idx.map((i) => result[i])
  }
  if (q.offset) result = result.slice(q.offset)
  if (q.limit !== undefined) result = result.slice(0, q.limit)
  const label = (e: Expr): string => {
    const given = q.labels.find((l) => sameExpr(l.e, e))
    if (given) return given.text
    if (e.t === 'col') return names[e.i]
    if (e.t === 'agg' && e.arg.t === 'col') return `${e.fn} ${names[e.arg.i]}`.trim()
    return ''
  }
  const head = select.map(label)
  const out: Value[][] = result.map((r) => r.out)
  if (head.some(Boolean)) out.unshift(head)
  if (!out.length) throw ERR.NA
  return new ArrayV(out)
}

/** order of two values in a query: nothing first, then by kind and value */
function cmpNull(a: Value, b: Value): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1
  if (a instanceof FormulaError || b instanceof FormulaError) return 0
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  return compare(a, b)
}

function cmpList(a: Value[], b: Value[]): number {
  for (let i = 0; i < a.length; i++) {
    const c = cmpNull(a[i], b[i])
    if (c) return c
  }
  return 0
}

// ---------------------------------------------------------------- registry

/** a number as it is: the converters change how a cell shows it, which is the cell's format, not its value */
const asNumber = S(1, 1, ([x]) => x)

export const GOOGLE: Record<string, FnDef> = {
  ADD: op('+'),
  MINUS: op('-'),
  MULTIPLY: op('*'),
  DIVIDE: op('/'),
  POW: op('^'),
  EQ: op('='),
  NE: op('<>'),
  GT: op('>'),
  GTE: op('>='),
  LT: op('<'),
  LTE: op('<='),
  UMINUS: S(1, 1, ([x]) => {
    const n = num(x)
    return n === 0 ? 0 : -n
  }),
  UPLUS: S(1, 1, ([x]) => x),
  UNARY_PERCENT: S(1, 1, ([x]) => num(x) / 100),
  ISBETWEEN: S(3, 5, (a) => {
    const [v, lo, hi] = a
    for (const x of [v, lo, hi]) if (x instanceof FormulaError) throw x
    const loIn = a.length > 3 && a[3] !== null ? bool(a[3]) : true
    const hiIn = a.length > 4 && a[4] !== null ? bool(a[4]) : true
    const l = compare(v, lo)
    const h = compare(v, hi)
    return (loIn ? l >= 0 : l > 0) && (hiIn ? h <= 0 : h < 0)
  }),
  TO_DATE: asNumber,
  TO_DOLLARS: asNumber,
  TO_PERCENT: asNumber,
  TO_PURE_NUMBER: asNumber,
  TO_TEXT: S(1, 1, ([x]) => (typeof x === 'number' ? numToText(x) : typeof x === 'boolean' ? (x ? 'TRUE' : 'FALSE') : x)),
  QUERY: A(2, 3, query),
}
