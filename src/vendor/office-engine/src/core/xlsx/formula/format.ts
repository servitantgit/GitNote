/** TEXT(): the format codes of the cell display (`../numfmt`), applied to a value. */
import { formatText as formatTextCell, formatValue } from '../numfmt'
import { getDate1904 } from './dates'
import { ERR, FormulaError, type Value } from './types'
import { parseNumberText } from './values'

export { fixedDecimal, pickSection } from '../numfmt'

/** Round half away from zero to d decimals, removing binary noise first. */
export function roundHalf(x: number, d: number): number {
  if (x === 0) return 0
  const ax = Math.abs(x)
  let r: number
  if (d >= 0) {
    const y = ax * Math.pow(10, d)
    // no digit left to round away (1E300 to 10 decimals, 1.5 to 400)
    if (!Number.isFinite(y) || y >= 2 ** 52) return x
    r = Math.floor(Number(y.toPrecision(15)) + 0.5) / Math.pow(10, d)
  } else {
    const f = Math.pow(10, -d)
    // 10^400 is not a number: every value rounds to 0 at that scale
    if (!Number.isFinite(f)) return 0
    r = Math.floor(Number((ax / f).toPrecision(15)) + 0.5) * f
  }
  return x < 0 ? -r : r
}

/** TEXT(value, format). Throws FormulaError on invalid input. */
export function formatText(v: Value, fmt: string): string {
  if (v instanceof FormulaError) throw v
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  let n: number
  if (typeof v === 'string') {
    const p = parseNumberText(v)
    if (p === null) return formatTextCell(v, fmt)
    n = p
  } else n = v ?? 0
  const f = formatValue(n, fmt, getDate1904(), true)
  if (f.invalid) throw ERR.VALUE
  return f.text
}
