/** Excel number-format subset: General, fixed/grouped/percent/scientific/fraction, dates & times, sections & colors. */
import { dict } from '../dict'

/** Round a nonnegative value's 15 significant decimal digits without returning to binary. */
export function fixedDecimal(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return String(v)
  const [mantissa, exponent] = v.toExponential(14).split('e')
  let coefficient = BigInt(mantissa.replace('.', ''))
  const shift = Number(exponent) - 14 + decimals
  let digits: string
  if (shift >= 0) digits = coefficient.toString() + '0'.repeat(shift)
  else {
    const divisor = 10n ** BigInt(-shift)
    coefficient = (coefficient + divisor / 2n) / divisor
    digits = coefficient.toString()
  }
  digits = digits.padStart(decimals + 1, '0')
  return decimals ? digits.slice(0, -decimals) + '.' + digits.slice(-decimals) : digits
}

/**
 * Index of the format section Excel applies to n: the second for negatives, the third for zero, otherwise the
 * first. When the section is empty (`;;;`, `0;;"z"`) the value shows nothing, which is returned as null.
 */
export function pickSection(n: number, count: number, isEmpty: (i: number) => boolean): number | null {
  const idx = n < 0 && count > 1 ? 1 : n === 0 && count > 2 ? 2 : 0
  return count > 1 && isEmpty(idx) ? null : idx
}

export const BUILTIN_FORMATS: Record<number, string> = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00',
  12: '# ?/?', 13: '# ??/??', 14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yyyy h:mm', 37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss',
  46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
  // common locale-dependent ids
  27: 'yyyy"年"m"月"', 30: 'm/d/yy', 31: 'yyyy"年"m"月"d"日"', 50: 'yyyy"年"m"月"', 57: 'yyyy"年"m"月"', 58: 'm"月"d"日"',
}

type Tok =
  | { k: 'lit'; v: string }
  | { k: 'digit'; v: '0' | '#' | '?' }
  | { k: 'dot' }
  | { k: 'comma' }
  | { k: 'pct' }
  | { k: 'exp'; sign: boolean }
  | { k: 'slash' }
  | { k: 'date'; v: string }
  | { k: 'text' }
  | { k: 'elapsed'; v: 'h' | 'm' | 's'; n: number }

interface Section {
  toks: Tok[]
  color?: string
  isDate: boolean
  cond?: { op: string; v: number }
  /** language of `[$-LCID]` */
  lcid?: number
  /** the section is `General` */
  general: boolean
  hasDigits: boolean
}

const COLORS: Record<string, string> = dict({
  black: '#000000', red: '#ff0000', green: '#00a000', blue: '#0000ff', yellow: '#c0c000', magenta: '#ff00ff',
  cyan: '#00c0c0', white: '#ffffff',
})

interface Names {
  months: string[]
  monthsShort: string[]
  days: string[]
  daysShort: string[]
}

const words = (s: string) => s.split(',')

const EN: Names = {
  months: words('January,February,March,April,May,June,July,August,September,October,November,December'),
  monthsShort: words('Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec'),
  days: words('Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday'),
  daysShort: words('Sun,Mon,Tue,Wed,Thu,Fri,Sat'),
}

/** names of the languages a `[$-LCID]` code can ask for, by primary language id (the low 10 bits of the LCID) */
const LOCALES: Record<number, Names> = {
  0x2a: {
    months: words('Tháng Một,Tháng Hai,Tháng Ba,Tháng Tư,Tháng Năm,Tháng Sáu,Tháng Bảy,Tháng Tám,Tháng Chín,Tháng Mười,Tháng Mười Một,Tháng Mười Hai'),
    monthsShort: words('Thg1,Thg2,Thg3,Thg4,Thg5,Thg6,Thg7,Thg8,Thg9,Thg10,Thg11,Thg12'),
    days: words('Chủ Nhật,Thứ Hai,Thứ Ba,Thứ Tư,Thứ Năm,Thứ Sáu,Thứ Bảy'),
    daysShort: words('CN,Th 2,Th 3,Th 4,Th 5,Th 6,Th 7'),
  },
  0x0c: {
    months: words('janvier,février,mars,avril,mai,juin,juillet,août,septembre,octobre,novembre,décembre'),
    monthsShort: words('janv.,févr.,mars,avr.,mai,juin,juil.,août,sept.,oct.,nov.,déc.'),
    days: words('dimanche,lundi,mardi,mercredi,jeudi,vendredi,samedi'),
    daysShort: words('dim.,lun.,mar.,mer.,jeu.,ven.,sam.'),
  },
  0x07: {
    months: words('Januar,Februar,März,April,Mai,Juni,Juli,August,September,Oktober,November,Dezember'),
    monthsShort: words('Jan,Feb,Mrz,Apr,Mai,Jun,Jul,Aug,Sep,Okt,Nov,Dez'),
    days: words('Sonntag,Montag,Dienstag,Mittwoch,Donnerstag,Freitag,Samstag'),
    daysShort: words('So,Mo,Di,Mi,Do,Fr,Sa'),
  },
  0x0a: {
    months: words('enero,febrero,marzo,abril,mayo,junio,julio,agosto,septiembre,octubre,noviembre,diciembre'),
    monthsShort: words('ene,feb,mar,abr,may,jun,jul,ago,sep,oct,nov,dic'),
    days: words('domingo,lunes,martes,miércoles,jueves,viernes,sábado'),
    daysShort: words('dom,lun,mar,mié,jue,vie,sáb'),
  },
}

const namesOf = (lcid: number | undefined): Names => (lcid === undefined ? EN : (LOCALES[lcid & 0x3ff] ?? EN))

function splitSections(fmt: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  let br = false
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i]
    if (c === '\\' && !q) {
      cur += c + (fmt[i + 1] ?? '')
      i++
      continue
    }
    if (c === '"') q = !q
    else if (!q && c === '[') br = true
    else if (!q && c === ']') br = false
    if (c === ';' && !q && !br) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

function parseSection(src: string): Section {
  const toks: Tok[] = []
  let color: string | undefined
  let cond: Section['cond']
  let lcid: number | undefined
  let isDate = false
  let i = 0
  const lit = (v: string) => {
    const last = toks[toks.length - 1]
    if (last?.k === 'lit') last.v += v
    else toks.push({ k: 'lit', v })
  }
  const lower = src.toLowerCase()
  while (i < src.length) {
    const c = src[i]
    const lc = lower[i]
    if (c === '"') {
      const e = src.indexOf('"', i + 1)
      lit(src.slice(i + 1, e < 0 ? undefined : e))
      i = e < 0 ? src.length : e + 1
    } else if (c === '\\') {
      lit(src[i + 1] ?? '')
      i += 2
    } else if (c === '_') {
      lit(' ')
      i += 2
    } else if (c === '*') {
      i += 2
    } else if (c === '[') {
      const e = src.indexOf(']', i)
      const body = src.slice(i + 1, e < 0 ? undefined : e)
      const bl = body.toLowerCase()
      if (COLORS[bl]) color = COLORS[bl]
      else if (/^color\s*\d+$/.test(bl)) color = undefined
      else if (/^(h+|m+|s+)$/.test(bl)) {
        toks.push({ k: 'elapsed', v: bl[0] as 'h' | 'm' | 's', n: bl.length })
        isDate = true
      } else if (body.startsWith('$')) {
        // [$symbol-LCID]: the symbol shows, the language gives the names of the days and months
        const dash = body.indexOf('-')
        const sym = dash < 0 ? body.slice(1) : body.slice(1, dash)
        if (sym) lit(sym)
        const code = dash < 0 ? '' : body.slice(dash + 1)
        if (/^[0-9a-f]{1,8}$/i.test(code)) lcid = parseInt(code, 16)
      } else {
        const m = /^(<=|>=|<>|<|>|=)\s*(-?[\d.]+)$/.exec(body)
        if (m) cond = { op: m[1], v: Number(m[2]) }
      }
      i = e < 0 ? src.length : e + 1
    } else if (c === '0' || c === '#' || c === '?') {
      toks.push({ k: 'digit', v: c })
      i++
    } else if (c === '.') {
      // ".0" after seconds = fractional seconds; treat as date token
      if (isDate && src[i + 1] === '0') {
        let j = i + 1
        while (src[j] === '0') j++
        toks.push({ k: 'date', v: src.slice(i, j) })
        i = j
      } else {
        toks.push({ k: 'dot' })
        i++
      }
    } else if (c === ',') {
      toks.push({ k: 'comma' })
      i++
    } else if (c === '%') {
      toks.push({ k: 'pct' })
      i++
    } else if ((lc === 'e') && (src[i + 1] === '+' || src[i + 1] === '-')) {
      toks.push({ k: 'exp', sign: src[i + 1] === '+' })
      i += 2
    } else if (c === '/' && toks.some((t) => t.k === 'digit')) {
      toks.push({ k: 'slash' })
      i++
    } else if (c === '@') {
      toks.push({ k: 'text' })
      i++
    } else if (lower.startsWith('am/pm', i)) {
      // the marker keeps the code's case: "am/pm" shows "pm"
      toks.push({ k: 'date', v: src[i] === 'a' ? 'am/pm' : 'AM/PM' })
      isDate = true
      i += 5
    } else if (lower.startsWith('a/p', i)) {
      toks.push({ k: 'date', v: src[i] === 'a' ? 'a/p' : 'A/P' })
      isDate = true
      i += 3
    } else if ('ymdhs'.includes(lc) || (lc === 'g' && lower.startsWith('ge', i)) || lc === 'b') {
      let j = i
      while (lower[j] === lc) j++
      if (lc === 'b' || lc === 'g') lit('')
      else {
        toks.push({ k: 'date', v: lower.slice(i, j) })
        isDate = true
      }
      i = j
    } else {
      lit(c)
      i++
    }
  }
  return { toks, color, isDate, cond, lcid, general: /^\s*general\s*$/i.test(src), hasDigits: toks.some((t) => t.k === 'digit') }
}

const cache = new Map<string, Section[]>()

function compile(fmt: string): Section[] {
  let s = cache.get(fmt)
  if (!s) {
    s = splitSections(fmt).map(parseSection)
    if (cache.size > 2000) cache.clear()
    cache.set(fmt, s)
  }
  return s
}

export function isDateFormat(fmt: string): boolean {
  if (!fmt || fmt === 'General') return false
  return compile(fmt)[0].isDate
}

/**
 * The General format: what Excel shows of a number in `max` characters (11 at most): the decimals that fit, rounded,
 * and scientific notation when the integer part does not fit or the number is below 1E-4. `#` when not even that fits.
 */
export function formatGeneral(v: number, max = 11): string {
  if (!Number.isFinite(v)) return String(v)
  if (v === 0) return '0'
  const neg = v < 0 ? 1 : 0
  const a = Math.abs(v)
  // room for the digits; the sign only counts against the room it is given
  const room = Math.min(max, 11 + neg) - neg
  if (room < 1) return '#'.repeat(Math.max(1, max))
  const e = Number(a.toExponential(14).split('e')[1])
  if (e >= -4 && e < room) {
    const decimals = Math.min(15, room - (e >= 0 ? e + 1 : 1) - 1)
    let s = fixedDecimal(a, Math.max(0, decimals))
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
    // (rounding can add a digit: 99999.9 in 5 characters; or leave nothing: 0.00012 in 3)
    if (s !== '0' && s.split('.')[0].length <= room) return (neg ? '-' : '') + s
  }
  const sci = (digits: number) => {
    const [m, x] = a.toExponential(digits).split('e')
    const exp = Number(x)
    return { mant: m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m, exp }
  }
  const expLen = (exp: number) => (Math.abs(exp) >= 100 ? 5 : 4)
  let { mant, exp } = sci(Math.max(0, room - 2 - expLen(e)))
  let digits = room - 2 - expLen(e)
  while (digits > 0 && mant.length + expLen(exp) > room) {
    ;({ mant, exp } = sci(--digits))
  }
  if (mant.length + expLen(exp) > room) return '#'.repeat(Math.max(1, max))
  return (neg ? '-' : '') + mant + 'E' + (exp < 0 ? '-' : '+') + String(Math.abs(exp)).padStart(2, '0')
}

function group(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Digits to the placeholders they fill from the right: the ones left over show 0, a space (`?`) or nothing (`#`). */
function padPlaces(digits: string, places: { v: string }[]): string {
  let pre = ''
  for (let k = 0; k < places.length - digits.length; k++) pre += places[k].v === '0' ? '0' : places[k].v === '?' ? ' ' : ''
  return pre + digits
}

/** |val| as `mantissa` (with `decs` decimals) and exponent; a step of `intPlaces` digits when there are several (##0.0E+0). */
function scientific(val: number, intPlaces: number, decs: number): { fixed: string; exp: number } {
  if (val === 0) return { fixed: fixedDecimal(0, decs), exp: 0 }
  const [m, e] = val.toExponential(14).split('e')
  const digits = BigInt(m.replace('.', ''))
  const E = Number(e)
  const step = Math.max(1, intPlaces)
  let exp = step > 1 ? Math.floor(E / step) * step : E
  for (;;) {
    // val / 10^exp * 10^decs, from the 15 digits of val
    const shift = E - 14 - exp + decs
    let n: bigint
    if (shift >= 0) n = digits * 10n ** BigInt(shift)
    else {
      const d = 10n ** BigInt(-shift)
      n = (digits + d / 2n) / d
    }
    const s = n.toString().padStart(decs + 1, '0')
    // rounded up to the next power of ten (999.96 as 1000.0): the mantissa starts over a step higher
    if (s.length - decs > step) {
      exp += step
      continue
    }
    return { fixed: decs ? s.slice(0, -decs) + '.' + s.slice(-decs) : s, exp }
  }
}

function formatNumber(v: number, sec: Section): string {
  const toks = sec.toks
  let val = Math.abs(v)
  const pctCount = toks.filter((t) => t.k === 'pct').length
  val *= Math.pow(100, pctCount)
  const dotIdx = toks.findIndex((t) => t.k === 'dot')
  const expIdx = toks.findIndex((t) => t.k === 'exp')
  const slashIdx = toks.findIndex((t) => t.k === 'slash')
  const firstDigit = toks.findIndex((t) => t.k === 'digit')
  let lastDigit = -1
  toks.forEach((t, i) => t.k === 'digit' && (lastDigit = i))

  // trailing commas after last digit placeholder scale by 1000
  let scale = 0
  for (let i = lastDigit + 1; i < toks.length && toks[i].k === 'comma'; i++) scale++
  val /= Math.pow(1000, scale)
  const grouping = toks.some((t, i) => t.k === 'comma' && i > firstDigit && i < lastDigit)

  if (slashIdx >= 0) return formatFraction(val, sec)

  const intEnd = dotIdx >= 0 ? dotIdx : expIdx >= 0 ? expIdx : lastDigit + 1
  const decToks = dotIdx >= 0 ? toks.slice(dotIdx + 1, expIdx >= 0 ? expIdx : undefined).filter((t) => t.k === 'digit') : []
  const decCount = decToks.length

  // Keep the rounded decimal digits: converting back to a double can add spurious digits
  // at large magnitudes, and toFixed switches to exponential notation at 1e21.
  let exp = 0
  let fixed: string
  if (expIdx >= 0) {
    const sci = scientific(val, toks.slice(0, intEnd).filter((t) => t.k === 'digit').length, decCount)
    fixed = sci.fixed
    exp = sci.exp
  } else fixed = fixedDecimal(val, decCount)
  let [intPart, decPart = ''] = fixed.split('.')
  // decimals: # trims trailing zeros, ? pads with spaces
  if (decCount) {
    const chars = decPart.split('')
    for (let i = decCount - 1; i >= 0; i--) {
      if (chars[i] !== '0') break
      const ph = (decToks[i] as { v: string }).v
      if (ph === '#') chars[i] = ''
      else if (ph === '?') chars[i] = ' '
      else break
    }
    decPart = chars.join('')
  }

  const intToks = toks.slice(0, intEnd)
  const intDigitToks = intToks.filter((t) => t.k === 'digit') as { k: 'digit'; v: string }[]
  const minInt = intDigitToks.filter((t) => t.v === '0').length
  if (intPart === '0' && minInt === 0) intPart = ''
  intPart = padPlaces(intPart, intDigitToks)
  const hasInnerLit = intToks.some((t, i) => t.k === 'lit' && i > firstDigit && i < intEnd)

  let out = ''
  if (!hasInnerLit) {
    let placed = false
    const body = grouping ? group(intPart) : intPart
    for (let i = 0; i < intEnd; i++) {
      const t = toks[i]
      if (t.k === 'digit') {
        if (!placed) {
          out += body
          placed = true
        }
      } else if (t.k === 'lit') out += t.v
      else if (t.k === 'pct') out += '%'
    }
    if (!placed) out += body
  } else {
    // right-to-left fill (phone-number style patterns)
    let digits = intPart
    let res = ''
    for (let i = intEnd - 1; i >= 0; i--) {
      const t = toks[i]
      if (t.k === 'digit') {
        if (digits.length) {
          res = digits[digits.length - 1] + res
          digits = digits.slice(0, -1)
        } else if (t.v === '0') res = '0' + res
        else if (t.v === '?') res = ' ' + res
        if (i === firstDigit && digits.length) {
          res = digits + res
          digits = ''
        }
      } else if (t.k === 'lit') res = t.v + res
      else if (t.k === 'pct') res = '%' + res
    }
    out = res
  }
  if (dotIdx >= 0) {
    out += decPart.length || decToks.some((t) => (t as { v: string }).v === '0') ? '.' + decPart : decCount ? '.' : ''
  }
  const tailStart = expIdx >= 0 ? expIdx : dotIdx >= 0 ? dotIdx + 1 : intEnd
  for (let i = tailStart; i < toks.length; i++) {
    const t = toks[i]
    if (t.k === 'exp') {
      const expDigits = toks.slice(i + 1).filter((x) => x.k === 'digit').length || 1
      out += 'E' + (exp < 0 ? '-' : t.sign ? '+' : '') + String(Math.abs(exp)).padStart(expDigits, '0')
      // skip exponent digit tokens
      while (i + 1 < toks.length && toks[i + 1].k === 'digit') i++
    } else if (t.k === 'lit') out += t.v
    else if (t.k === 'pct') out += '%'
  }
  return out
}

/** Formats |val| as a fraction (`# ?/?`, `?/8`, `# ??/??`); the sign is added by formatValue. */
function formatFraction(val: number, sec: Section): string {
  const toks = sec.toks
  const slash = toks.findIndex((t) => t.k === 'slash')
  type Place = Extract<Tok, { k: 'digit' }>
  const isDigit = (t: Tok): t is Place => t.k === 'digit'
  // numerator: the placeholders right before the slash; whole part: those before them
  let ns = slash
  while (ns > 0 && toks[ns - 1].k === 'digit') ns--
  const numPh = toks.slice(ns, slash).filter(isDigit)
  const wholePh = toks.slice(0, ns).filter(isDigit)
  const hasWhole = wholePh.length > 0
  // denominator: a number written in the format (?/8, ?/16, ?/10), else placeholders
  const after = toks.slice(slash + 1)
  const first = after[0]
  let fixedDen: number | undefined
  let fixedRest = ''
  let denTaken = 0
  let denPh: Place[] = []
  if (first?.k === 'lit' && /^[1-9]/.test(first.v)) {
    const m = /^\d+/.exec(first.v)!
    let digits = m[0]
    fixedRest = first.v.slice(digits.length)
    denTaken = 1
    // a 0 after it is a placeholder token of the number (?/10)
    while (!fixedRest && after[denTaken]?.k === 'digit' && (after[denTaken] as Place).v === '0') {
      digits += '0'
      denTaken++
    }
    fixedDen = Number(digits)
  } else {
    while (after[denPh.length]?.k === 'digit') denPh.push(after[denPh.length] as Place)
    denTaken = denPh.length
  }
  const maxDen = fixedDen ?? Math.pow(10, denPh.length || 1) - 1
  let whole = hasWhole ? Math.floor(val) : 0
  const frac = val - whole
  let n = 0
  let d = 1
  if (fixedDen) {
    d = fixedDen
    n = Math.round(frac * d)
  } else {
    let err = Infinity
    for (let k = 1; k <= maxDen && err > 1e-15; k++) {
      const m = Math.round(frac * k)
      const e = Math.abs(frac - m / k)
      if (e < err - 1e-12) {
        err = e
        n = m
        d = k
      }
    }
  }
  if (n === d && hasWhole) {
    whole++
    n = 0
  }
  const blank = hasWhole && n === 0
  const wholeText = hasWhole ? padPlaces(whole === 0 && n > 0 ? '' : String(whole), wholePh) : ''
  const numText = padPlaces(String(n), numPh)
  let denText = String(d)
  if (!fixedDen) {
    const zeros = denPh.filter((p) => p.v === '0').length
    denText = denText.padStart(zeros, '0')
    denText += ' '.repeat(Math.max(0, denPh.filter((p) => p.v === '?').length - Math.max(0, denText.length - zeros)))
  }
  let out = ''
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (i < ns && t.k === 'digit') {
      if (i === toks.findIndex(isDigit)) out += wholeText
    } else if (i === ns) {
      out += blank ? ' '.repeat(numText.length) : numText
      i = slash - 1
    } else if (i === slash) {
      out += blank ? ' ' : '/'
      out += blank ? ' '.repeat(fixedDen ? String(fixedDen).length : denText.length) : denText
      i += denTaken
      if (fixedRest) out += fixedRest
    } else if (t.k === 'lit') out += t.v
    else if (t.k === 'pct') out += '%'
  }
  return out
}

export function serialToDate(serial: number, date1904 = false): Date {
  let days = Math.floor(serial)
  const ms = Math.round((serial - days) * 86400000)
  let base: number
  if (date1904) base = Date.UTC(1904, 0, 1)
  else if (days < 60) base = Date.UTC(1899, 11, 31)
  else {
    base = Date.UTC(1899, 11, 30)
    if (days === 60) days = 61
  }
  return new Date(base + days * 86400000 + ms)
}

/** Year, month (0-based), day and weekday (0 = Sunday) of a serial: Excel's calendar, with 1900-01-00, the 29 Feb 1900 and a Sunday for 1/1/1900. */
function civil(n: number, date1904: boolean): { Y: number; M: number; D: number; dow: number } {
  if (date1904) {
    const d = new Date(Date.UTC(1904, 0, 1) + n * 86400000)
    return { Y: d.getUTCFullYear(), M: d.getUTCMonth(), D: d.getUTCDate(), dow: (((n + 5) % 7) + 7) % 7 }
  }
  const dow = (((n - 1) % 7) + 7) % 7
  if (n === 0) return { Y: 1900, M: 0, D: 0, dow }
  if (n === 60) return { Y: 1900, M: 1, D: 29, dow }
  const d = new Date(Date.UTC(1899, 11, 30) + (n < 60 ? n + 1 : n) * 86400000)
  return { Y: d.getUTCFullYear(), M: d.getUTCMonth(), D: d.getUTCDate(), dow }
}

function formatDate(v: number, sec: Section, date1904: boolean): string {
  const toks = sec.toks
  const hasAmPm = toks.some((t) => t.k === 'date' && /^(am\/pm|a\/p)$/i.test(t.v ?? ''))
  // Excel rounds to seconds (also for date-only formats), or the digits of ".0", before
  // splitting into fields, so 23:59:59.6 carries into the next day even with m/d/yyyy.
  const fracDigits = Math.min(3, Math.max(0, ...toks.map((t) => (t.k === 'date' && t.v[0] === '.' ? t.v.length - 1 : 0))))
  const unit = Math.pow(10, fracDigits)
  let day = Math.floor(v)
  let ticks = Math.round((v - day) * 86400 * unit)
  if (ticks >= 86400 * unit) {
    day++
    ticks -= 86400 * unit
  }
  const totalTicks = day * 86400 * unit + ticks
  const { Y, M, D, dow } = civil(day, date1904)
  const names = namesOf(sec.lcid)
  const secOfDay = Math.floor(ticks / unit)
  const H = Math.floor(secOfDay / 3600)
  const Mi = Math.floor((secOfDay % 3600) / 60)
  const S = secOfDay % 60
  const frac = ticks % unit
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  let out = ''
  // decide month vs minute for 'm'/'mm'
  const isMinute = (idx: number) => {
    for (let j = idx - 1; j >= 0; j--) {
      const t = toks[j]
      if (t.k === 'date') return t.v[0] === 'h'
      if (t.k === 'elapsed') return t.v === 'h'
    }
    for (let j = idx + 1; j < toks.length; j++) {
      const t = toks[j]
      if (t.k === 'date') return t.v[0] === 's'
      if (t.k === 'elapsed') return t.v === 's'
    }
    return false
  }
  toks.forEach((t, idx) => {
    if (t.k === 'lit') return (out += t.v)
    if (t.k === 'elapsed') {
      const secs = t.v === 'h' ? 3600 : t.v === 'm' ? 60 : 1
      out += pad(Math.floor(totalTicks / (secs * unit)), t.n)
      return
    }
    if (t.k !== 'date') {
      if (t.k === 'digit') out += t.v === '0' ? '0' : ''
      else if (t.k === 'dot') out += '.'
      else if (t.k === 'comma') out += ','
      else if (t.k === 'pct') out += '%'
      else if (t.k === 'slash') out += '/'
      return
    }
    const tv = t.v
    switch (tv[0] === 'a' ? 'A' : tv[0]) {
      case 'y':
        out += tv.length <= 2 ? pad(Y % 100) : String(Y)
        break
      case 'm':
        if (tv.length <= 2 && isMinute(idx)) out += tv.length === 2 ? pad(Mi) : String(Mi)
        else if (tv.length === 1) out += M + 1
        else if (tv.length === 2) out += pad(M + 1)
        else if (tv.length === 3) out += names.monthsShort[M]
        else if (tv.length === 5) out += [...names.months[M]][0]
        else out += names.months[M]
        break
      case 'd':
        if (tv.length === 1) out += D
        else if (tv.length === 2) out += pad(D)
        else if (tv.length === 3) out += names.daysShort[dow]
        else out += names.days[dow]
        break
      case 'h': {
        let h = H
        if (hasAmPm) h = h % 12 || 12
        out += tv.length >= 2 ? pad(h) : String(h)
        break
      }
      case 's':
        out += tv.length >= 2 ? pad(S) : String(S)
        break
      case '.':
        out += '.' + pad(Math.floor(frac / Math.pow(10, fracDigits - (tv.length - 1))), tv.length - 1)
        break
      case 'A':
        {
          const m = tv.length > 3 ? (H < 12 ? 'AM' : 'PM') : H < 12 ? 'A' : 'P'
          out += tv[0] === 'a' ? m.toLowerCase() : m
        }
        break
    }
  })
  return out
}

export interface Formatted {
  text: string
  color?: string
  /** a date outside the serials Excel has (TEXT() gives #VALUE!; a cell shows ########) */
  invalid?: boolean
}

/**
 * A number as a cell with the format `fmt` shows it. `forText`: as TEXT() has it, which does not put a minus sign
 * on what shows as zero (-0.004 as 0.00), and tells a date out of range.
 */
export function formatValue(v: number, fmt: string | undefined, date1904 = false, forText = false): Formatted {
  if (!fmt || /^\s*general\s*$/i.test(fmt)) return { text: formatGeneral(v) }
  const secs = compile(fmt)
  let sec = secs[0]
  let val = v
  const hasCond = secs.some((s) => s.cond)
  if (hasCond) {
    const test = (s: Section) => {
      if (!s.cond) return false
      const { op, v: c } = s.cond
      return op === '<' ? v < c : op === '<=' ? v <= c : op === '>' ? v > c : op === '>=' ? v >= c : op === '=' ? v === c : v !== c
    }
    sec = secs.find(test) ?? secs.find((s) => !s.cond) ?? secs[0]
    if (secs.length > 1 && !sec.toks.length && !sec.general) return { text: '' }
  } else {
    const idx = pickSection(v, secs.length, (i) => !secs[i].toks.length && !secs[i].general)
    if (idx === null) return { text: '' }
    sec = secs[idx]
    if (idx === 1) val = -v
  }
  if (sec.isDate) {
    if (v < 0 || v > 2958465) return { text: '#'.repeat(8), invalid: true }
    return { text: formatDate(v, sec, date1904), color: sec.color }
  }
  if (!sec.hasDigits) {
    // pure literal / text section ("-" for zero etc.)
    const lit = sec.toks.map((t) => (t.k === 'lit' ? t.v : t.k === 'pct' ? '%' : t.k === 'text' ? formatGeneral(val) : '')).join('')
    if (sec.toks.some((t) => t.k === 'text') || lit) return { text: lit, color: sec.color }
    return { text: formatGeneral(v), color: sec.color }
  }
  const neg = val < 0
  let text = formatNumber(val, sec)
  if (neg && (!forText || /[1-9]/.test(text))) text = '-' + text
  return { text, color: sec.color }
}

export function formatText(s: string, fmt: string | undefined): string {
  if (!fmt || !fmt.includes('@')) return s
  const secs = compile(fmt)
  const sec = secs.length >= 4 ? secs[3] : secs.find((x) => x.toks.some((t) => t.k === 'text'))
  if (!sec) return s
  return sec.toks.map((t) => (t.k === 'lit' ? t.v : t.k === 'text' ? s : '')).join('')
}
