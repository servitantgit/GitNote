/** The operators of a formula on two values. */
import type { BinOp } from './parser'
import { ERR, FormulaError, type Value } from './types'
import { compare, toNum, toStr } from './values'

/** the last + or - of a formula gives 0 for what is only the noise of the binary digits left (0.1+0.2-0.3), as in Excel */
const NOISE = 1e-15

function arith(op: BinOp, x: number, y: number, last = false): Value {
  let r: number
  switch (op) {
    case '+':
      r = x + y
      if (last && Math.abs(r) <= NOISE * Math.max(Math.abs(x), Math.abs(y))) r = 0
      break
    case '-':
      r = x - y
      if (last && Math.abs(r) <= NOISE * Math.max(Math.abs(x), Math.abs(y))) r = 0
      break
    case '*':
      r = x * y
      break
    case '/':
      if (y === 0) return ERR.DIV0
      r = x / y
      break
    default:
      if (x === 0 && y === 0) return ERR.NUM
      if (x === 0 && y < 0) return ERR.DIV0
      r = Math.pow(x, y)
  }
  return Number.isFinite(r) ? r : ERR.NUM
}

export function binop(op: BinOp, a: Value, b: Value, last = false): Value {
  if (a instanceof FormulaError) return a
  if (b instanceof FormulaError) return b
  switch (op) {
    case '&':
      return (toStr(a) as string) + (toStr(b) as string)
    case '=':
      return compare(a, b) === 0
    case '<>':
      return compare(a, b) !== 0
    case '<':
      return compare(a, b) < 0
    case '>':
      return compare(a, b) > 0
    case '<=':
      return compare(a, b) <= 0
    case '>=':
      return compare(a, b) >= 0
  }
  const x = toNum(a)
  if (x instanceof FormulaError) return x
  const y = toNum(b)
  if (y instanceof FormulaError) return y
  return arith(op, x, y, last)
}
