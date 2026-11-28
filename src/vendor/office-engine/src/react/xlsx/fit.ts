import { formatGeneral } from '../../core/xlsx/numfmt'

/** px size of a CSS font size ('11pt', px number), `base` when unset */
export const fontPx = (v: string | number | undefined, base: number) =>
  typeof v === 'string' && v.endsWith('pt') ? (parseFloat(v) * 4) / 3 : typeof v === 'number' ? v : base

/** a digit's width where nothing measures the font (no canvas: a server, a test): Calibri 11 pt has 7 px of its 14.7 */
const DIGIT = 0.48

/** a number as the General format writes it: plain digits, a point, an exponent */
const PLAIN = /^-?(?:\d+\.?\d*|\.\d+)(?:E[+-]?\d+)?$/i

let ctx: CanvasRenderingContext2D | null | undefined
/** widths of the characters of numbers, by font (a CSS font) */
const widths = new Map<string, Map<string, number>>()

/** a font arrived: the widths measured before it are the fallback's */
export const forgetWidths = () => widths.clear()

/**
 * Width in px of a number in `font`: the sum of its characters' (digits and signs are not kerned), each measured once.
 * Undefined where there is no canvas.
 */
function measured(text: string, font: string): number | undefined {
  if (ctx === undefined) ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  if (!ctx) return undefined
  let table = widths.get(font)
  if (!table) {
    if (widths.size > 200) widths.clear()
    widths.set(font, (table = new Map()))
  }
  let w = 0
  for (const ch of text) {
    let x = table.get(ch)
    if (x === undefined) {
      ctx.font = font
      table.set(ch, (x = ctx.measureText(ch).width))
    }
    w += x
  }
  return w
}

/**
 * Excel-like: a General number gives up decimals to fit the column, then goes scientific when its integer part does
 * not fit, and shows ### only when not even that fits. A formatted number (1,234.50 / 12%) cannot change: ###.
 *
 * With `font` (the CSS font the cell is drawn in) the text is measured: the font a browser has for a sheet's is not
 * always as narrow as Calibri, and a number wider than its cell would be shown without its first digits. Without
 * it, or where nothing measures, a digit counts for the width Calibri gives it.
 */
export function fitNumber(text: string, width: number, px: number, font?: string): string {
  const size = (s: string) => (font ? measured(s, font) : undefined) ?? s.length * px * DIGIT
  const fits = (s: string) => size(s) <= width + 1e-6
  if (fits(text)) return text
  const hashes = () => '#'.repeat(Math.max(1, Math.floor(width / size('#') + 1e-9)))
  if (!PLAIN.test(text)) return hashes()
  // fewer characters until it fits: the decimals go first, then the plain form for the scientific one
  const v = Number(text)
  for (let room = Math.min(text.length - 1, 21); room >= 1; room--) {
    const s = formatGeneral(v, room)
    if (s[0] === '#') break
    if (fits(s)) return s
  }
  return hashes()
}
