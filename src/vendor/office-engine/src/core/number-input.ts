/**
 * Numbers typed by a person, read in a locale: into a cell of a sheet, the font size, a margin. The separators, the
 * minus and percent signs and the digits are the locale's, as `Intl.NumberFormat(locale).formatToParts` gives them;
 * without a locale (or with a tag that is not one) a number has a decimal point and commas grouping by thousands, and
 * nothing else is read. The whole text is one number or none: a prefix is never read ("12,5" in English is not 12),
 * and a separator that is neither the locale's decimal one nor a grouping in its place makes it none ("1.5" in German,
 * "1,5" in English). What is read is a number, the same in every locale: the file never holds a separator.
 *
 * Grouping: the locale's own character, between groups of the size it writes (3 digits; 3 then 2 in India:
 * 12,34,567), the same character throughout the number; a locale grouping with a space reads U+0020, U+00A0, U+202F
 * and U+2009 alike, one grouping with an apostrophe both ' and ’ (Swiss German). Digits: ASCII ones in every locale,
 * and the locale's own when it writes others (Arabic-Indic, Devanagari…), one kind or the other in a number.
 */

/** the currency signs a typed amount may carry, before or after it */
export const MONEY = '$€£¥₫₩₹₽₱฿'

export interface NumberSyntax {
  /** canonical BCP 47 tag; undefined: no locale */
  locale?: string
  decimal: string
  /** the characters read as grouping */
  group: string[]
  /** digits in the group next to the decimal separator, and in the ones before it */
  primary: number
  secondary: number
  /** the minus signs read: '-', and the locale's own (U+2212 in Swedish) */
  minus: string[]
  /** the percent signs read: '%', and the locale's own (U+066A in Arabic) */
  percent: string[]
  /** a space may stand before the percent sign: the locale writes one (50 % in German) */
  percentSpace: boolean
  /** the locale's digits zero to nine, when they are not ASCII ones */
  digits?: string[]
}

const SPACES = [' ', '\u00a0', '\u202f', '\u2009']
const APOSTROPHES = ["'", '\u2019']
/** the direction marks Intl writes around signs (Arabic, Persian, Hebrew): not typed as part of a number */
const MARKS = /[\u061c\u200e\u200f]/g

const NONE: NumberSyntax = { decimal: '.', group: [','], primary: 3, secondary: 3, minus: ['-'], percent: ['%'], percentSpace: false }

/**
 * The canonical form of a BCP 47 tag; undefined for none, for what is not one (`de_DE`) and for a locale Intl has no
 * data for (it would fall back to the browser's own: never what numbers are read in).
 */
export function inputLocale(tag: string | null | undefined): string | undefined {
  if (!tag) return undefined
  try {
    const canon = Intl.getCanonicalLocales(tag)[0]
    return canon && Intl.NumberFormat.supportedLocalesOf([canon]).length ? canon : undefined
  } catch {
    return undefined
  }
}

const syntaxes = new Map<string, NumberSyntax>()

/** the separators, signs and digits numbers are read with in `locale` */
export function numberSyntax(locale?: string | null): NumberSyntax {
  const tag = inputLocale(locale)
  if (!tag) return NONE
  let s = syntaxes.get(tag)
  if (!s) syntaxes.set(tag, (s = syntaxOf(tag)))
  return s
}

function syntaxOf(tag: string): NumberSyntax {
  const unmarked = (s: string | undefined) => s?.replace(MARKS, '') ?? ''
  const parts = new Intl.NumberFormat(tag).formatToParts(-1234567.5)
  const part = (type: string) => unmarked(parts.find((p) => p.type === type)?.value)
  const decimal = part('decimal') || '.'
  const g = part('group')
  const ints = parts.filter((p) => p.type === 'integer').map((p) => p.value)
  const primary = ints.length > 1 ? ints[ints.length - 1].length : 3
  const secondary = ints.length > 2 ? ints[ints.length - 2].length : primary
  const group = !g ? [] : SPACES.includes(g) ? SPACES : APOSTROPHES.includes(g) ? APOSTROPHES : [g]
  const pct = new Intl.NumberFormat(tag, { style: 'percent' }).formatToParts(0.5)
  const at = pct.findIndex((p) => p.type === 'percentSign')
  const percent = unmarked(pct[at]?.value) || '%'
  const before = pct[at - 1]
  const minus = part('minusSign') || '-'
  const digits = [...unmarked(new Intl.NumberFormat(tag, { useGrouping: false }).format(9876543210))].reverse()
  return {
    locale: tag,
    decimal,
    group: group.filter((c) => c !== decimal),
    primary,
    secondary,
    minus: minus === '-' ? ['-'] : ['-', minus],
    percent: percent === '%' ? ['%'] : ['%', percent],
    percentSpace: before?.type === 'literal' && /^\s$/.test(unmarked(before.value)),
    digits: digits.length === 10 && digits.join('') !== '0123456789' ? digits : undefined,
  }
}

const esc = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&')

interface Grammar {
  plain: RegExp
  percent: RegExp
  amount: RegExp
}

const grammars = new WeakMap<NumberSyntax, Grammar>()

/**
 * The forms a number is typed in (with ASCII digits, '-' and '%' by then), as a cell reads them: a number with an
 * exponent but no grouping (-1.5, .5, 5., 1.5e3); a percentage (12.5%); an amount, grouped or with a currency sign
 * before or after it (1,234.50, $50, -$3.75, 50 ₫). The locale's decimal and grouping separators in place of the
 * point and the comma.
 */
function grammarOf(s: NumberSyntax): Grammar {
  let g = grammars.get(s)
  if (g) return g
  const D = esc(s.decimal)
  const num = `(?:\\d+${D}?\\d*|${D}\\d+)`
  const G = `[${s.group.map(esc).join('')}]`
  const grouped = s.group.length ? `\\d{1,${s.secondary}}(?:${G}\\d{${s.secondary}})*${G}\\d{${s.primary}}|` : ''
  g = {
    plain: new RegExp(`^[-+]?${num}(?:e[-+]?\\d+)?$`, 'i'),
    percent: new RegExp(`^[-+]?${num}${s.percentSpace ? '\\s?' : ''}%$`),
    amount: new RegExp(`^([-+]?)\\s*([${MONEY}]?)\\s*(${grouped}\\d+)(${D}\\d+)?\\s*([${MONEY}]?)$`),
  }
  grammars.set(s, g)
  return g
}

/** `text` with the locale's digits, minus and percent signs as ASCII ones and its direction marks dropped; null when it mixes two kinds of digits */
function ascii(text: string, s: NumberSyntax): string | null {
  if (!s.locale) return text
  let t = text.replace(MARKS, '')
  for (const m of s.minus) if (m !== '-') t = t.split(m).join('-')
  for (const p of s.percent) if (p !== '%') t = t.split(p).join('%')
  const own = s.digits
  if (own && own.some((d) => t.includes(d))) {
    if (/\d/.test(t)) return null
    t = [...t].map((ch) => {
      const i = own.indexOf(ch)
      return i < 0 ? ch : String(i)
    }).join('')
  }
  return t
}

export interface TypedNumber {
  /** the number (a percentage as typed: 50 for 50%) */
  value: number
  kind: 'plain' | 'percent' | 'amount'
  /** the number as JavaScript writes it: ASCII digits, a decimal point, no grouping ('-1234.5', '1.5e3') */
  canon: string
  /** digits typed after the decimal separator */
  decimals: number
  grouped: boolean
  /** the currency sign typed, and whether it came after the number */
  currency?: string
  after?: boolean
}

/**
 * What a cell reads `text` as when it is a number typed in `locale` (the forms of `grammarOf`); null when the whole
 * of it is not one. A number too large to be one (1e999) is none.
 */
export function readTyped(text: string, locale?: string | null): TypedNumber | null {
  const s = numberSyntax(locale)
  const t = ascii(text.trim(), s)
  if (!t) return null
  const g = grammarOf(s)
  const canon = (x: string) => (s.decimal === '.' ? x : x.replace(s.decimal, '.'))
  const decimals = (x: string) => {
    const i = x.indexOf(s.decimal)
    return i < 0 ? 0 : x.length - i - 1
  }
  if (g.plain.test(t)) {
    const value = Number(canon(t))
    if (!Number.isFinite(value)) return null
    return { value, kind: 'plain', canon: canon(t), decimals: decimals(t.replace(/e.*$/i, '')), grouped: false }
  }
  if (g.percent.test(t)) {
    const body = t.slice(0, -1).trimEnd()
    const value = Number(canon(body))
    if (!Number.isFinite(value)) return null
    return { value, kind: 'percent', canon: canon(body), decimals: decimals(body), grouped: false }
  }
  const m = g.amount.exec(t)
  if (!m || (m[2] && m[5])) return null
  const grouped = /\D/.test(m[3])
  // (a plain number without a currency was read before; grouped by one character throughout, not "1 234.567")
  if ((!m[2] && !m[5] && !grouped) || new Set(m[3].replace(/\d/g, '')).size > 1) return null
  const c = (m[1] === '-' ? '-' : '') + m[3].replace(/\D/g, '') + (m[4] ? '.' + m[4].slice(1) : '')
  const value = Number(c)
  if (!Number.isFinite(value)) return null
  return { value, kind: 'amount', canon: c, decimals: m[4] ? m[4].length - 1 : 0, grouped, ...(m[2] || m[5] ? { currency: m[2] || m[5], after: !!m[5] } : {}) }
}

/**
 * The number typed into a field (a size, a margin) in `locale`: the whole text, with a sign, grouped or not, with
 * decimals or an exponent. Null when it is not one; a percentage or an amount of money is not.
 */
export function parseNumber(text: string, locale?: string | null): number | null {
  const n = readTyped(text, locale)
  return n && n.kind !== 'percent' && n.currency === undefined ? n.value : null
}

/** `n` as it is typed in `locale` and read back the same: its shortest digits (ASCII), the locale's decimal separator, no grouping */
export function numberText(n: number, locale?: string | null): string {
  const s = numberSyntax(locale)
  return s.decimal === '.' ? String(n) : String(n).replace('.', s.decimal)
}
