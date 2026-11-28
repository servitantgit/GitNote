/** Recursive-descent parser with Excel precedence: `:` > unary +/- > % > ^ > * / > + - > & > comparisons. */
import { FormulaSyntaxError, tokenize, type Token } from './lexer'
import type { RefAddr } from './refs'
import type { ErrorCode, Value } from './types'
import { FormulaError } from './types'
import type { Val } from './values'

export type BinOp = '+' | '-' | '*' | '/' | '^' | '&' | '=' | '<>' | '<' | '>' | '<=' | '>='

export type Ast =
  | { type: 'num'; value: number }
  | { type: 'str'; value: string }
  | { type: 'bool'; value: boolean }
  | { type: 'err'; code: ErrorCode }
  | { type: 'missing' }
  | { type: 'ref'; ref: RefAddr }
  | { type: 'name'; name: string; sheet?: string }
  | { type: 'array'; rows: Value[][] }
  | { type: 'unary'; op: '-' | '+'; arg: Ast }
  | { type: 'percent'; arg: Ast }
  | { type: 'binary'; op: BinOp; left: Ast; right: Ast }
  | { type: 'range'; left: Ast; right: Ast }
  | { type: 'union'; items: Ast[] }
  | { type: 'call'; name: string; args: Ast[] }
  /** what an expression gives, called as a function: LAMBDA(x, x + 1)(5) */
  | { type: 'invoke'; fn: Ast; args: Ast[] }
  /** a value already computed (never parsed: an argument handed to a function called through a function value) */
  | { type: 'value'; value: Val }

const CMP = new Set(['=', '<>', '<', '>', '<=', '>='])

/** the function a space between two references stands for: the cells both have (the intersection operator) */
export const INTERSECT = ' '

/** functions that give a reference: what a space after them may intersect */
const REF_FUNCTIONS = new Set(['OFFSET', 'INDEX', 'INDIRECT', 'ANCHORARRAY', INTERSECT])

const refLike = (a: Ast) => a.type === 'ref' || a.type === 'range' || a.type === 'name' || a.type === 'union' || (a.type === 'call' && REF_FUNCTIONS.has(a.name))

class Parser {
  i = 0
  constructor(
    private readonly toks: Token[],
    /** whether white space came before each token */
    private readonly spaced: boolean[] = [],
  ) {}

  private peek(): Token | undefined {
    return this.toks[this.i]
  }
  private isOp(...ops: string[]): string | undefined {
    const t = this.toks[this.i]
    return t && t.t === 'op' && ops.includes(t.v) ? t.v : undefined
  }
  private isPunc(p: string): boolean {
    const t = this.toks[this.i]
    return !!t && t.t === 'punc' && t.v === p
  }
  private fail(msg: string): never {
    const t = this.toks[this.i]
    throw new FormulaSyntaxError(msg, t ? t.s : -1)
  }
  private expectPunc(p: string): void {
    if (!this.isPunc(p)) this.fail(`expected '${p}'`)
    this.i++
  }

  expr(): Ast {
    let l = this.concat()
    for (let op = this.cmpOp(); op; op = this.cmpOp()) {
      this.i++
      l = { type: 'binary', op: op as BinOp, left: l, right: this.concat() }
    }
    return l
  }
  private cmpOp(): string | undefined {
    const t = this.peek()
    return t && t.t === 'op' && CMP.has(t.v) ? t.v : undefined
  }
  private concat(): Ast {
    let l = this.add()
    while (this.isOp('&')) {
      this.i++
      l = { type: 'binary', op: '&', left: l, right: this.add() }
    }
    return l
  }
  private add(): Ast {
    let l = this.mul()
    for (let op = this.isOp('+', '-'); op; op = this.isOp('+', '-')) {
      this.i++
      l = { type: 'binary', op: op as BinOp, left: l, right: this.mul() }
    }
    return l
  }
  private mul(): Ast {
    let l = this.pow()
    for (let op = this.isOp('*', '/'); op; op = this.isOp('*', '/')) {
      this.i++
      l = { type: 'binary', op: op as BinOp, left: l, right: this.pow() }
    }
    return l
  }
  private pow(): Ast {
    let l = this.postfix()
    while (this.isOp('^')) {
      this.i++
      l = { type: 'binary', op: '^', left: l, right: this.postfix() }
    }
    return l
  }
  private postfix(): Ast {
    let x = this.unary()
    while (this.isOp('%')) {
      this.i++
      x = { type: 'percent', arg: x }
    }
    return x
  }
  private unary(): Ast {
    const op = this.isOp('-', '+')
    if (op) {
      this.i++
      return { type: 'unary', op: op as '-' | '+', arg: this.unary() }
    }
    // @: the one value of a range / array that is the formula's own (a file writes it SINGLE)
    if (this.isOp('@')) {
      this.i++
      return { type: 'call', name: 'SINGLE', args: [this.unary()] }
    }
    return this.intersect()
  }
  /** a space between two references: the cells both have (`B2:D4 C1:C9`, `North Q1`) */
  private intersect(): Ast {
    let l = this.range()
    for (;;) {
      const t = this.toks[this.i]
      if (!t || !this.spaced[this.i] || !refLike(l)) return l
      if (!(t.t === 'ref' || t.t === 'name' || t.t === 'func' || (t.t === 'punc' && t.v === '('))) return l
      l = { type: 'call', name: INTERSECT, args: [l, this.range()] }
    }
  }
  private range(): Ast {
    let l = this.spilled()
    while (this.isOp(':')) {
      this.i++
      l = { type: 'range', left: l, right: this.spilled() }
    }
    return l
  }
  /** x#: all the cells the dynamic array formula in x fills */
  private spilled(): Ast {
    let x = this.primary()
    while (this.isOp('#')) {
      this.i++
      x = { type: 'call', name: 'ANCHORARRAY', args: [x] }
    }
    return x
  }

  private primary(): Ast {
    const t = this.peek()
    if (!t) this.fail('unexpected end of formula')
    this.i++
    switch (t.t) {
      case 'num':
        return { type: 'num', value: t.v }
      case 'str':
        return { type: 'str', value: t.v }
      case 'bool':
        return { type: 'bool', value: t.v }
      case 'err':
        return { type: 'err', code: t.v }
      case 'ref':
        return { type: 'ref', ref: t.ref }
      case 'name':
        return t.sheet === undefined ? { type: 'name', name: t.v } : { type: 'name', name: t.v, sheet: t.sheet }
      case 'func': {
        this.expectPunc('(')
        return this.called({ type: 'call', name: t.v, args: this.args() })
      }
      case 'punc':
        if (t.v === '(') {
          const first = this.expr()
          if (!this.isPunc(',')) {
            this.expectPunc(')')
            return this.called(first)
          }
          const items = [first]
          while (this.isPunc(',')) {
            this.i++
            items.push(this.expr())
          }
          this.expectPunc(')')
          return { type: 'union', items }
        }
        if (t.v === '{') return this.array()
    }
    this.i--
    return this.fail('unexpected token')
  }

  /** `x` followed by arguments is `x` called with them: LAMBDA(…)(1, 2) */
  private called(x: Ast): Ast {
    while (this.isPunc('(')) {
      this.i++
      x = { type: 'invoke', fn: x, args: this.args() }
    }
    return x
  }

  private args(): Ast[] {
    const args: Ast[] = []
    if (this.isPunc(')')) {
      this.i++
      return args
    }
    for (;;) {
      args.push(this.isPunc(',') || this.isPunc(')') ? { type: 'missing' } : this.expr())
      if (this.isPunc(')')) {
        this.i++
        return args
      }
      this.expectPunc(',')
    }
  }

  private array(): Ast {
    const rows: Value[][] = [[]]
    for (;;) {
      rows[rows.length - 1].push(this.arrayItem())
      const t = this.peek()
      if (!t || t.t !== 'punc') this.fail('bad array constant')
      this.i++
      if (t.v === '}') break
      if (t.v === ';') rows.push([])
      else if (t.v !== ',') this.fail('bad array constant')
    }
    if (rows.some((r) => r.length !== rows[0].length)) this.fail('array rows differ in length')
    return { type: 'array', rows }
  }
  private arrayItem(): Value {
    const sign = this.isOp('-', '+')
    if (sign) this.i++
    const t = this.peek()
    if (!t) this.fail('bad array constant')
    this.i++
    if (t.t === 'num') return sign === '-' ? -t.v : t.v
    if (sign) this.fail('bad array constant')
    if (t.t === 'str' || t.t === 'bool') return t.v
    if (t.t === 'err') return new FormulaError(t.v)
    this.i--
    return this.fail('bad array constant')
  }
}

/** Parse formula text (OOXML stored form, without '='; a leading '=' is tolerated). Throws FormulaSyntaxError. */
export function parseFormula(text: string): Ast {
  const src = text.startsWith('=') ? text.slice(1) : text
  const toks: Token[] = []
  const spaced: boolean[] = []
  let space = false
  for (const t of tokenize(src)) {
    if (t.t === 'ws') space = true
    else {
      toks.push(t)
      spaced.push(space)
      space = false
    }
  }
  if (!toks.length) throw new FormulaSyntaxError('empty formula', 0)
  const p = new Parser(toks, spaced)
  const ast = p.expr()
  if (p.i < toks.length) throw new FormulaSyntaxError('unexpected token', toks[p.i].s)
  return ast
}
