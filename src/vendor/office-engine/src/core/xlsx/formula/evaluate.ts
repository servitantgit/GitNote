/** Tree-walking evaluator. Top-level operands use implicit intersection; inside functions ranges are array-evaluated. */
import { getDate1904, setDate1904 } from './dates'
import { guard, pick, type Ev } from './fn'
import { FUNCTIONS } from './functions'
import { FormulaSyntaxError, stripFnPrefix } from './lexer'
import { binop } from './ops'
import { parseFormula, type Ast } from './parser'
import { sameSheet, type RefAddr } from './refs'
import { parseStructured, resolveStructured } from './structured'
import { references } from './transform'
import { ERR, EvalSignal, FormulaError, MAX_COL, MAX_ROW, UnsupportedFormula, type CellProvider, type EvalContext, type Value } from './types'
import { ArrayV, LambdaV, RangeV, toNum, UnionV, type Val } from './values'

/** a name of LET or a parameter of LAMBDA, and what it stands for (undefined: an argument left out) */
interface Scope {
  name: string
  value: Val | undefined
  parent: Scope | undefined
}

/** a name of LET / LAMBDA as it is looked up: without regard to case, nor to the prefix a file gives it */
const local = (name: string) => name.toLowerCase().replace(/^_xlpm\./, '')

/**
 * Calls of function values and readings of defined names one formula may make in all: past it the result is #NUM!.
 * (The depth alone does not bound the work: a function that calls itself twice at each level is 2^depth calls.)
 */
const MAX_STEPS = 10_000_000

/** function values calling one another, nested: past this many the result is #NUM! (a LAMBDA that calls itself without end) */
const MAX_CALLS = 192

type Operand = Value | Value[][]

function map1(v: Operand, f: (x: Value) => Value): Val {
  return Array.isArray(v) ? new ArrayV(v.map((row) => row.map(f))) : f(v)
}

function map2(a: Operand, b: Operand, f: (x: Value, y: Value) => Value): Val {
  if (!Array.isArray(a) && !Array.isArray(b)) return f(a, b)
  const da = Array.isArray(a) ? a : [[a]]
  const db = Array.isArray(b) ? b : [[b]]
  const h = Math.max(da.length, db.length)
  const w = Math.max(da[0].length, db[0].length)
  const out: Value[][] = []
  for (let i = 0; i < h; i++) {
    const row: Value[] = []
    for (let j = 0; j < w; j++) row.push(f(pick(da, i, j), pick(db, i, j)))
    out.push(row)
  }
  return new ArrayV(out)
}

export { binop }

export class Evaluator implements Ev {
  readonly provider: CellProvider
  readonly sheet: string | undefined
  readonly r: number
  readonly c: number
  private readonly strict: boolean
  /** the formula being evaluated: its last operation is the one that rounds noise to zero */
  private root: Ast | undefined
  /** the larger extent of the sheets the whole columns / rows of the formula are on (see `clip`) */
  private extent: { rows: number; cols: number } | undefined
  /** the names in reach of what is being evaluated (LET, LAMBDA) */
  private scope: Scope | undefined
  private calls = 0
  private steps = 0

  constructor(ctx: EvalContext, root?: Ast) {
    this.root = root
    this.provider = ctx.provider
    this.sheet = ctx.sheet
    this.r = ctx.r
    this.c = ctx.c
    this.strict = !!ctx.strict
  }

  /** what the engine cannot compute: #NAME?, or the evaluation stopped (`EvalContext.strict`) */
  private unsupported(): Val {
    if (this.strict) throw new UnsupportedFormula()
    return ERR.NAME
  }

  eval(ast: Ast, top: boolean): Val {
    switch (ast.type) {
      case 'num':
      case 'str':
      case 'bool':
        return ast.value
      case 'err':
        return new FormulaError(ast.code)
      case 'missing':
        return null
      case 'value':
        return ast.value
      case 'name':
        return this.named(ast.name, ast.sheet, top)
      case 'invoke':
        return this.invoke(this.eval(ast.fn, false), this.args(ast.args))
      case 'array':
        return new ArrayV(ast.rows)
      case 'ref':
        return this.ref(ast.ref)
      case 'range':
        return this.rangeOp(ast.left, ast.right)
      case 'union': {
        const areas: RangeV[] = []
        for (const it of ast.items) {
          const v = this.eval(it, false)
          if (v instanceof RangeV) areas.push(v)
          else if (v instanceof UnionV) areas.push(...v.areas)
          else return v instanceof FormulaError ? v : ERR.VALUE
        }
        return new UnionV(areas)
      }
      case 'unary': {
        const v = this.operand(this.eval(ast.arg, top), top)
        if (ast.op === '+') return Array.isArray(v) ? new ArrayV(v) : v
        return map1(v, (x) => {
          const n = toNum(x)
          return n instanceof FormulaError ? n : n === 0 ? 0 : -n
        })
      }
      case 'percent':
        return map1(this.operand(this.eval(ast.arg, top), top), (x) => {
          const n = toNum(x)
          return n instanceof FormulaError ? n : n / 100
        })
      case 'binary': {
        const l = this.operand(this.eval(ast.left, top), top)
        const r = this.operand(this.eval(ast.right, top), top)
        const op = ast.op
        const last = ast === this.root
        return map2(l, r, (a, b) => binop(op, a, b, last))
      }
      case 'call':
        return this.call(ast.name, ast.args, top)
    }
  }

  /** the values of the arguments of a function value (one left out is undefined) */
  private args(args: Ast[]): (Val | undefined)[] {
    return args.map((a) => (a.type === 'missing' ? undefined : this.eval(a, false)))
  }

  private bound(name: string): Scope | undefined {
    const lc = local(name)
    for (let s = this.scope; s; s = s.parent) if (s.name === lc) return s
    return undefined
  }

  /** evaluates outside the names of LET / LAMBDA in reach: a defined name does not see those of the formula using it */
  private apart<T>(f: () => T): T {
    const saved = this.scope
    this.scope = undefined
    if (++this.calls > MAX_CALLS || ++this.steps > MAX_STEPS) {
      if (this.calls > MAX_CALLS) this.runaway()
      this.calls--
      this.scope = saved
      throw ERR.NUM
    }
    try {
      return f()
    } finally {
      this.calls--
      this.scope = saved
    }
  }

  /** a name: of LET / LAMBDA, a structured reference, a defined name, a table, or a function named as a value */
  private named(name: string, sheet: string | undefined, top: boolean): Val {
    if (sheet === undefined) {
      const s = this.bound(name)
      if (s) return s.value === undefined ? null : s.value
      if (name.includes('[')) return this.structured(name)
    }
    const def = this.provider.name?.(name, sheet ?? this.sheet, sheet !== undefined)
    if (def) return guard(() => this.apart(() => this.eval(def, top)))
    if (sheet === undefined) {
      const tb = this.provider.table?.(name, this.sheet, this.r, this.c)
      if (tb) return new RangeV(tb.sheet, tb.r0 + tb.headers, tb.c0, Math.max(tb.r0 + tb.headers, tb.r1 - tb.totals), tb.c1)
      const fn = stripFnPrefix(name)
      if (Object.hasOwn(FUNCTIONS, fn)) return this.builtin(fn)
    }
    return this.unsupported()
  }

  private structured(text: string): Val {
    const ref = parseStructured(text)
    if (!ref || !this.provider.table) return this.unsupported()
    const tb = this.provider.table(ref.table, this.sheet, this.r, this.c)
    if (!tb) return ref.table === undefined ? ERR.REF : this.unsupported()
    const rg = resolveStructured(ref, tb, sameSheet(tb.sheet, this.sheet) ? this.r : -1)
    if (rg === 'row') return ERR.VALUE
    if (!rg) return ERR.REF
    return new RangeV(tb.sheet, rg.r0, rg.c0, rg.r1, rg.c1)
  }

  /** a function of the engine as a value (`BYROW(rows, SUM)`) */
  private builtin(name: string): LambdaV {
    return new LambdaV((args) => {
      const def = FUNCTIONS[name]
      if (args.length < def.min || args.length > def.max) return ERR.VALUE
      if (def.kind === 'lazy') return def.fn(args.map((v): Ast => (v === undefined ? { type: 'missing' } : { type: 'value', value: v })), this, false)
      return def.fn(args.map((v) => (v === undefined ? null : v)), this, false)
    }, FUNCTIONS[name].min, FUNCTIONS[name].max)
  }

  /**
   * The calls went as deep as they may: a function that calls itself without end. What is left of the evaluation
   * gets few calls more (every level of it may be calling itself again and again: 2^depth calls).
   */
  private runaway() {
    this.steps = Math.max(this.steps, MAX_STEPS - 10_000)
  }

  invoke(f: Val, args: (Val | undefined)[]): Val {
    if (!(f instanceof LambdaV)) return f instanceof FormulaError ? f : ERR.VALUE
    if (this.calls >= MAX_CALLS) {
      this.runaway()
      return ERR.NUM
    }
    if (++this.steps > MAX_STEPS) return ERR.NUM
    this.calls++
    try {
      return f.fn(args)
    } catch (e) {
      if (e instanceof FormulaError) return e
      // (the stack of the machine ran out before the count did)
      if (e instanceof RangeError) return ERR.NUM
      throw e
    } finally {
      this.calls--
    }
  }

  letIn(a: Ast[], top: boolean): Val {
    if (a.length % 2 === 0) return ERR.VALUE
    const saved = this.scope
    try {
      for (let i = 0; i + 1 < a.length; i += 2) {
        const n = a[i]
        if (n.type !== 'name' || n.sheet !== undefined || n.name.includes('[')) return ERR.VALUE
        // (each value sees the names before it)
        const value = this.eval(a[i + 1], false)
        this.scope = { name: local(n.name), value, parent: this.scope }
      }
      return this.eval(a[a.length - 1], top)
    } finally {
      this.scope = saved
    }
  }

  lambda(a: Ast[]): Val {
    const params: { name: string; optional: boolean }[] = []
    for (let i = 0; i < a.length - 1; i++) {
      const n = a[i]
      if (n.type !== 'name' || n.sheet !== undefined) return ERR.VALUE
      // [name]: a parameter the call may leave out
      const m = /^\[([^\[\]]+)\]$/.exec(n.name)
      if (!m && n.name.includes('[')) return ERR.VALUE
      params.push({ name: local((m ? m[1] : n.name).trim()), optional: !!m })
    }
    const body = a[a.length - 1]
    const closure = this.scope
    const need = params.filter((p) => !p.optional).length
    return new LambdaV((args) => {
      if (args.length > params.length || args.length < need) return ERR.VALUE
      let scope = closure
      for (let i = 0; i < params.length; i++) scope = { name: params[i].name, value: args[i], parent: scope }
      const saved = this.scope
      this.scope = scope
      try {
        return this.eval(body, false)
      } finally {
        this.scope = saved
      }
    }, need, params.length)
  }

  omitted(arg: Ast): Val {
    if (arg.type !== 'name' || arg.sheet !== undefined) return ERR.VALUE
    const s = this.bound(arg.name)
    return s ? s.value === undefined : false
  }

  /** the sheets of a 3-D reference `First:Last`, in the order of the workbook */
  private span(sheets: string): string[] | undefined {
    const at = sheets.indexOf(':')
    const names = this.provider.sheetNames?.()
    if (at < 0 || !names) return undefined
    const find = (n: string) => names.findIndex((x) => x.toLowerCase() === n.toLowerCase())
    const a = find(sheets.slice(0, at))
    const b = find(sheets.slice(at + 1))
    if (a < 0 || b < 0) return undefined
    return names.slice(Math.min(a, b), Math.max(a, b) + 1)
  }

  private ref(a: RefAddr): Val {
    if (a.sheet !== undefined && !this.hasSheet(a.sheet)) {
      const span = this.span(a.sheet)
      if (!span) return ERR.REF
      return new UnionV(span.map((s) => new RangeV(s, a.r0, a.c0, a.r1, a.c1)))
    }
    // past Excel's last row only a sheet read from a large text file has such rows: no row there, no cell (a name, as in Excel)
    if (a.r1 > MAX_ROW && a.r1 >= (this.provider.bounds?.(a.sheet ?? this.sheet).rows ?? 0)) return ERR.NAME
    return new RangeV(a.sheet ?? this.sheet, a.r0, a.c0, a.r1, a.c1)
  }

  private rangeOp(left: Ast, right: Ast): Val {
    const l = this.eval(left, false)
    if (l instanceof FormulaError) return l
    const r = this.eval(right, false)
    if (r instanceof FormulaError) return r
    if (!(l instanceof RangeV) || !(r instanceof RangeV) || !sameSheet(l.sheet, r.sheet)) return ERR.VALUE
    return new RangeV(l.sheet, Math.min(l.r0, r.r0), Math.min(l.c0, r.c0), Math.max(l.r1, r.r1), Math.max(l.c1, r.c1))
  }

  private call(name: string, args: Ast[], top: boolean): Val {
    // a name of LET / LAMBDA called as a function comes before a function of that name
    if (this.scope) {
      const s = this.bound(name)
      if (s) return this.invoke(s.value === undefined ? null : s.value, this.args(args))
    }
    if (!Object.hasOwn(FUNCTIONS, name)) {
      // a defined name that is a LAMBDA
      const def = this.provider.name?.(name, this.sheet)
      if (def) {
        const f = guard(() => this.apart(() => this.eval(def, false)))
        if (f instanceof LambdaV) return this.invoke(f, this.args(args))
      }
      return this.unsupported()
    }
    const def = FUNCTIONS[name]
    if (args.length < def.min || args.length > def.max) return ERR.VALUE
    if (def.kind === 'lazy') return guard(() => def.fn(args, this, top))
    const vals = args.map((a) => this.eval(a, def.scalarArgs && top))
    return guard(() => def.fn(vals, this, top))
  }

  hasSheet(name: string): boolean {
    return this.provider.hasSheet ? this.provider.hasSheet(name) : true
  }

  now(): Date {
    return this.provider.now?.() ?? new Date()
  }

  cell(sheet: string | undefined, r: number, c: number): Value {
    const v = this.provider.value(sheet, r, c)
    return v === undefined ? null : v
  }

  /**
   * The rows and columns of the longest sheet among those the formula has whole columns / rows of: `A:A` and `B:B` of
   * two sheets must have the same size (SUMPRODUCT(Data!C:C,T!A:A)), as they do in Excel, without reading the blank
   * rows of a million.
   */
  private wholeExtent(): { rows: number; cols: number } {
    if (this.extent) return this.extent
    let rows = 0
    let cols = 0
    if (this.root && this.provider.bounds) {
      const seen = new Set<string>()
      for (const ref of references(this.root)) {
        if (!('r0' in ref) || (ref.r1 < MAX_ROW && ref.c1 < MAX_COL)) continue
        const key = (ref.sheet ?? this.sheet ?? '').toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        const b = this.provider.bounds(ref.sheet ?? this.sheet)
        rows = Math.max(rows, b.rows)
        cols = Math.max(cols, b.cols)
      }
    }
    return (this.extent = { rows, cols })
  }

  /** Clip whole-row/whole-column style ranges to the provider's used extent. */
  private clip(rg: RangeV): { r1: number; c1: number } {
    let { r1, c1 } = rg
    if ((r1 >= MAX_ROW || c1 === MAX_COL) && this.provider.bounds) {
      const b = this.provider.bounds(rg.sheet)
      const ext = this.wholeExtent()
      // a whole column is all the rows the sheet has: more than Excel's when it was read from a large text file
      if (r1 >= MAX_ROW) r1 = Math.max(rg.r0, Math.max(b.rows, ext.rows) - 1)
      if (c1 === MAX_COL) c1 = Math.max(rg.c0, Math.min(c1, Math.max(b.cols, ext.cols) - 1))
    }
    return { r1, c1 }
  }

  forEach(rg: RangeV, cb: (v: Value, i: number, j: number) => void): void {
    const { r1, c1 } = this.clip(rg)
    const p = this.provider
    const kept = p.block?.(rg.sheet, rg.r0, rg.c0, r1, c1)
    if (kept) {
      for (let i = 0; i < kept.length; i++) for (let j = 0, row = kept[i]; j < row.length; j++) cb(row[j], i, j)
      return
    }
    if (p.read) return p.read(rg.sheet, rg.r0, rg.c0, r1, c1, cb)
    for (let r = rg.r0; r <= r1; r++) for (let c = rg.c0; c <= c1; c++) cb(this.cell(rg.sheet, r, c), r - rg.r0, c - rg.c0)
  }

  /** The values of a range / array / scalar as rows. Those of a range may be shared (see `CellProvider.block`): read, never changed. */
  toArray(v: Val): Value[][] {
    if (v instanceof RangeV) {
      const { r1, c1 } = this.clip(v)
      const p = this.provider
      const kept = p.block?.(v.sheet, v.r0, v.c0, r1, c1)
      if (kept) return kept
      const out: Value[][] = []
      if (p.read) {
        const last = c1 - v.c0
        let row: Value[] = []
        p.read(v.sheet, v.r0, v.c0, r1, c1, (x, _i, j) => {
          row.push(x)
          if (j === last) {
            out.push(row)
            row = []
          }
        })
        return out
      }
      for (let r = v.r0; r <= r1; r++) {
        const row: Value[] = []
        for (let c = v.c0; c <= c1; c++) row.push(this.cell(v.sheet, r, c))
        out.push(row)
      }
      return out
    }
    if (v instanceof ArrayV) return v.data
    if (v instanceof UnionV) throw ERR.VALUE
    if (v instanceof LambdaV) throw ERR.CALC
    return [[v]]
  }

  /** Implicit intersection of a range with the formula cell's row/column. */
  intersect(rg: RangeV): Value {
    if (rg.h === 1 && rg.w === 1) return this.cell(rg.sheet, rg.r0, rg.c0)
    if (rg.w === 1 && this.r >= rg.r0 && this.r <= rg.r1) return this.cell(rg.sheet, this.r, rg.c0)
    if (rg.h === 1 && this.c >= rg.c0 && this.c <= rg.c1) return this.cell(rg.sheet, rg.r0, this.c)
    return ERR.VALUE
  }

  scalar(v: Val): Value {
    if (v instanceof RangeV) return this.intersect(v)
    if (v instanceof ArrayV) return v.data[0][0]
    if (v instanceof UnionV) return ERR.VALUE
    if (v instanceof LambdaV) return ERR.CALC
    return v
  }

  operand(v: Val, top: boolean): Operand {
    if (v instanceof RangeV) {
      if (v.h === 1 && v.w === 1) return this.cell(v.sheet, v.r0, v.c0)
      return top ? this.intersect(v) : this.toArray(v)
    }
    if (v instanceof ArrayV) return v.h === 1 && v.w === 1 ? v.data[0][0] : v.data
    if (v instanceof UnionV) return ERR.VALUE
    if (v instanceof LambdaV) return ERR.CALC
    return v
  }
}

/** a value as a cell holds it: an empty one is 0, a number that is not one is #NUM! */
function settle(x: Value): Value {
  if (x === null) return 0
  if (typeof x === 'number') return Number.isFinite(x) ? x + 0 : ERR.NUM
  return x
}

/**
 * Evaluate a parsed formula for the cell at ctx.{sheet,r,c}. Errors come back as FormulaError; it throws nothing but
 * an `EvalSignal` (one the provider throws, or `UnsupportedFormula` when `ctx.strict`).
 */
export function evaluate(ast: Ast, ctx: EvalContext): Value {
  const prev = getDate1904()
  setDate1904(!!ctx.provider.date1904)
  try {
    const ev = new Evaluator(ctx, ast)
    const v = ev.eval(ast, true)
    return settle(v instanceof RangeV ? ev.intersect(v) : v instanceof ArrayV ? v.data[0][0] : v instanceof UnionV ? ERR.VALUE : v instanceof LambdaV ? ERR.CALC : v)
  } catch (e) {
    if (e instanceof EvalSignal) throw e
    return e instanceof FormulaError ? e : ERR.VALUE
  } finally {
    setDate1904(prev)
  }
}

/**
 * Evaluate an array formula (entered over `h` × `w` cells): no implicit intersection at the top, and a value for
 * each cell. A result of one row / column / value repeats over the cells; cells past a larger one are #N/A.
 */
export function evaluateArray(ast: Ast, ctx: EvalContext, h: number, w: number): Value[][] {
  const prev = getDate1904()
  setDate1904(!!ctx.provider.date1904)
  const fill = (f: (i: number, j: number) => Value) => Array.from({ length: h }, (_, i) => Array.from({ length: w }, (_, j) => f(i, j)))
  try {
    const ev = new Evaluator(ctx, ast)
    const v = ev.eval(ast, false)
    const data = v instanceof UnionV ? [[ERR.VALUE as Value]] : ev.toArray(v)
    return fill((i, j) => settle(pick(data, i, j)))
  } catch (e) {
    if (e instanceof EvalSignal) throw e
    const err = e instanceof FormulaError ? e : ERR.VALUE
    return fill(() => err)
  } finally {
    setDate1904(prev)
  }
}

/**
 * Evaluate a dynamic array formula: no implicit intersection, and all the values it gives, as rows (one row of one
 * value when it gives a single one). Those spill over the cells next to the formula's.
 */
export function evaluateDynamic(ast: Ast, ctx: EvalContext): Value[][] {
  const prev = getDate1904()
  setDate1904(!!ctx.provider.date1904)
  try {
    const ev = new Evaluator(ctx, ast)
    const v = ev.eval(ast, false)
    if (v instanceof UnionV) return [[ERR.VALUE]]
    const data = ev.toArray(v)
    if (!data.length || !data[0].length) return [[ERR.CALC]]
    return data.map((row) => row.map(settle))
  } catch (e) {
    if (e instanceof EvalSignal) throw e
    return [[e instanceof FormulaError ? e : ERR.VALUE]]
  } finally {
    setDate1904(prev)
  }
}

/** Parse + evaluate. Syntax errors evaluate to #NAME?. */
export function evaluateFormula(text: string, ctx: EvalContext): Value {
  let ast: Ast
  try {
    ast = parseFormula(text)
  } catch (e) {
    if (e instanceof FormulaSyntaxError) return ERR.NAME
    return ERR.VALUE
  }
  return evaluate(ast, ctx)
}
