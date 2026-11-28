/** Text functions. */
import { A, INF, lift, opt, S, visit, type Ev, type FnDef } from './fn'
import { fixedDecimal, formatText, roundHalf } from './format'
import { regexTooCostly } from './regex-guard'
import { ERR, FormulaError, type Value } from './types'
import { ArrayV, bool, num, parseNumberText, RangeV, str, wildcardRe, type Val } from './values'

const MAX_TEXT = 32767

/** what the Windows-1252 code page has at 128-159 (Excel's CHAR / CODE); the five it leaves empty are the control codes */
const CP1252 = [...'€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ']

function len(n: number): number {
  const k = Math.trunc(n)
  if (k < 0) throw ERR.VALUE
  return k
}

function proper(s: string): string {
  let out = ''
  let prevLetter = false
  for (const ch of s) {
    const isLetter = ch.toLowerCase() !== ch.toUpperCase()
    out += isLetter ? (prevLetter ? ch.toLowerCase() : ch.toUpperCase()) : ch
    prevLetter = isLetter
  }
  return out
}

function find(needle: string, hay: string, start: number, ci: boolean): number {
  if (start < 1 || start > hay.length + 1) throw ERR.VALUE
  if (needle === '') return start
  if (!ci) {
    const i = hay.indexOf(needle, start - 1)
    if (i < 0) throw ERR.VALUE
    return i + 1
  }
  const re = wildcardRe(needle, false)
  const m = re.exec(hay.slice(start - 1))
  if (!m) throw ERR.VALUE
  return m.index + start
}

export const TEXT: Record<string, FnDef> = {
  CONCATENATE: S(1, INF, (a) => a.map(str).join('')),
  CONCAT: A(1, INF, (a, ev) => {
    let s = ''
    const add = (v: Value) => (s += str(v))
    for (const x of a) visit(x, ev, add, add)
    if (s.length > MAX_TEXT) throw ERR.VALUE
    return s
  }),
  TEXTJOIN: A(3, INF, (a, ev) => {
    const delim = str(ev.scalar(a[0]))
    const skipEmpty = bool(ev.scalar(a[1]))
    const parts: string[] = []
    const add = (v: Value) => {
      const s = str(v)
      if (!skipEmpty || s !== '') parts.push(s)
    }
    for (const x of a.slice(2)) visit(x, ev, add, add)
    const s = parts.join(delim)
    if (s.length > MAX_TEXT) throw ERR.VALUE
    return s
  }),
  LEFT: S(1, 2, (a) => str(a[0]).slice(0, len(opt(a, 1, 1)))),
  RIGHT: S(1, 2, (a) => {
    const s = str(a[0])
    return s.slice(Math.max(0, s.length - len(opt(a, 1, 1))))
  }),
  MID: S(3, 3, ([t, st, n]) => {
    // all three read first: an error in an argument is the result, ahead of what is wrong with another
    const s = str(t)
    const start = Math.trunc(num(st))
    const k = num(n)
    if (start < 1) throw ERR.VALUE
    return s.substr(start - 1, len(k))
  }),
  LEN: S(1, 1, ([x]) => str(x).length),
  UPPER: S(1, 1, ([x]) => str(x).toUpperCase()),
  LOWER: S(1, 1, ([x]) => str(x).toLowerCase()),
  PROPER: S(1, 1, ([x]) => proper(str(x))),
  TRIM: S(1, 1, ([x]) => str(x).replace(/ {2,}/g, ' ').replace(/^ | $/g, '')),
  SUBSTITUTE: S(3, 4, (a) => {
    const s = str(a[0])
    const from = str(a[1])
    const to = str(a[2])
    if (from === '') return s
    if (a.length < 4) return s.split(from).join(to)
    const nth = Math.trunc(num(a[3]))
    if (nth < 1) throw ERR.VALUE
    let idx = -1
    for (let k = 0; k < nth; k++) {
      idx = s.indexOf(from, idx + (k ? from.length : 1))
      if (idx < 0) return s
    }
    return s.slice(0, idx) + to + s.slice(idx + from.length)
  }),
  REPLACE: S(4, 4, ([t, st, n, nw]) => {
    const s = str(t)
    const start = Math.trunc(num(st))
    const count = num(n)
    const by = str(nw)
    if (start < 1) throw ERR.VALUE
    const k = len(count)
    return s.slice(0, start - 1) + by + s.slice(start - 1 + k)
  }),
  REPT: S(2, 2, ([t, n]) => {
    const s = str(t)
    const k = len(num(n))
    if (s.length * k > MAX_TEXT) throw ERR.VALUE
    return s.repeat(k)
  }),
  FIND: S(2, 3, (a) => find(str(a[0]), str(a[1]), Math.trunc(opt(a, 2, 1)), false)),
  SEARCH: S(2, 3, (a) => find(str(a[0]), str(a[1]), Math.trunc(opt(a, 2, 1)), true)),
  EXACT: S(2, 2, ([x, y]) => str(x) === str(y)),
  // the link itself is not followed: the cell shows the friendly name, else the address
  HYPERLINK: S(1, 2, (a) => (a.length > 1 && a[1] !== null ? a[1] : str(a[0]))),
  VALUE: S(1, 1, ([x]) => {
    if (typeof x === 'number') return x
    if (x === null) return 0
    if (typeof x !== 'string') throw x instanceof FormulaError ? x : ERR.VALUE
    const n = parseNumberText(x)
    if (n === null) throw ERR.VALUE
    return n
  }),
  TEXT: S(2, 2, ([v, f]) => formatText(v, str(f))),
  CHAR: S(1, 1, ([x]) => {
    const n = Math.trunc(num(x))
    if (n < 1 || n > 255) throw ERR.VALUE
    return n >= 128 && n < 160 ? CP1252[n - 128] : String.fromCharCode(n)
  }),
  CODE: S(1, 1, ([x]) => {
    const s = str(x)
    if (!s) throw ERR.VALUE
    const c = s.charCodeAt(0)
    const k = c >= 128 ? CP1252.indexOf(s[0]) : -1
    return k >= 0 ? 128 + k : c
  }),
  UNICHAR: S(1, 1, ([x]) => {
    const n = Math.trunc(num(x))
    if (n < 1 || n > 0x10ffff) throw ERR.VALUE
    // half of a surrogate pair is no character
    if (n >= 0xd800 && n <= 0xdfff) throw ERR.NA
    return String.fromCodePoint(n)
  }),
  UNICODE: S(1, 1, ([x]) => {
    const c = str(x).codePointAt(0)
    if (c === undefined) throw ERR.VALUE
    return c
  }),
  CLEAN: S(1, 1, ([x]) => str(x).replace(/[\u0000-\u001f]/g, '')),
  FIXED: S(1, 3, (a) => {
    const d = Math.trunc(opt(a, 1, 2))
    if (d > 127) throw ERR.VALUE
    const n = roundHalf(num(a[0]), d)
    return grouped(n, d, !(a.length > 2 && bool(a[2])))
  }),
  DOLLAR: S(1, 2, (a) => {
    const d = Math.trunc(opt(a, 1, 2))
    if (d > 127) throw ERR.VALUE
    const n = roundHalf(num(a[0]), d)
    const t = '$' + grouped(Math.abs(n), d, true)
    return n < 0 ? `(${t})` : t
  }),
  NUMBERVALUE: S(1, 3, (a) => numberValue(str(a[0]), a.length > 1 ? str(a[1]) : '.', a.length > 2 ? str(a[2]) : ',')),
  VALUETOTEXT: S(1, 2, (a) => valueText(a[0], strict(opt(a, 1, 0)))),
  ARRAYTOTEXT: A(1, 2, (a, ev) => {
    const quoted = strict(a.length > 1 ? num(ev.scalar(a[1])) : 0)
    const d = ev.toArray(a[0])
    const s = quoted ? `{${d.map((row) => row.map((v) => valueText(v, true)).join(',')).join(';')}}` : d.map((row) => row.map((v) => valueText(v, false)).join(', ')).join(', ')
    if (s.length > MAX_TEXT) throw ERR.VALUE
    return s
  }),
  BAHTTEXT: S(1, 1, ([x]) => bahtText(num(x))),
  // without a double-byte language set, the byte functions count characters
  LENB: S(1, 1, ([x]) => str(x).length),
  LEFTB: S(1, 2, (a) => str(a[0]).slice(0, len(opt(a, 1, 1)))),
  RIGHTB: S(1, 2, (a) => {
    const s = str(a[0])
    return s.slice(Math.max(0, s.length - len(opt(a, 1, 1))))
  }),
  MIDB: S(3, 3, ([t, st, n]) => {
    const s = str(t)
    const start = Math.trunc(num(st))
    const k = num(n)
    if (start < 1) throw ERR.VALUE
    return s.substr(start - 1, len(k))
  }),
  REPLACEB: S(4, 4, ([t, st, n, nw]) => {
    const s = str(t)
    const start = Math.trunc(num(st))
    const count = num(n)
    const by = str(nw)
    if (start < 1) throw ERR.VALUE
    return s.slice(0, start - 1) + by + s.slice(start - 1 + len(count))
  }),
  FINDB: S(2, 3, (a) => find(str(a[0]), str(a[1]), Math.trunc(opt(a, 2, 1)), false)),
  SEARCHB: S(2, 3, (a) => find(str(a[0]), str(a[1]), Math.trunc(opt(a, 2, 1)), true)),
  ASC: S(1, 1, ([x]) => toHalfWidth(str(x))),
  DBCS: S(1, 1, ([x]) => toFullWidth(str(x))),
  JIS: S(1, 1, ([x]) => toFullWidth(str(x))),
  // the reading of a text is kept by the file for Japanese only: any other text reads as itself
  PHONETIC: A(1, 1, ([v], ev) => {
    if (!(v instanceof RangeV)) throw ERR.NA
    return str(ev.cell(v.sheet, v.r0, v.c0))
  }),

  REGEXTEST: S(2, 3, (a) => regex(str(a[1]), opt(a, 2, 0) !== 0, false, str(a[0])).test(str(a[0]))),
  REGEXMATCH: S(2, 2, (a) => regex(str(a[1]), false, false, str(a[0])).test(str(a[0]))),
  REGEXREPLACE: S(3, 5, (a) => {
    const text = str(a[0])
    const re = regex(str(a[1]), opt(a, 4, 0) !== 0, true, text)
    const by = str(a[2])
    const nth = Math.trunc(opt(a, 3, 0))
    if (nth === 0) return text.replace(re, by)
    const all = [...text.matchAll(re)]
    const m = all[nth > 0 ? nth - 1 : all.length + nth]
    if (!m) return text
    return replaceAt(text, new RegExp(re.source, re.flags.replace('g', '') + 'y'), m.index, by)
  }),
  REGEXEXTRACT: A(2, 4, (a, ev) => {
    const text = str(ev.scalar(a[0]))
    const mode = a.length > 2 ? Math.trunc(num(ev.scalar(a[2]))) : 0
    const re = regex(str(ev.scalar(a[1])), a.length > 3 && num(ev.scalar(a[3])) !== 0, true, text)
    if (mode < 0 || mode > 2) throw ERR.VALUE
    const all = [...text.matchAll(re)]
    if (!all.length) throw ERR.NA
    if (mode === 0) return all[0][0]
    // 1: every match, down a column; 2: the groups of the first match, along a row
    if (mode === 1) return new ArrayV(all.map((m) => [m[0]]))
    if (all[0].length < 2) throw ERR.NA
    return new ArrayV([all[0].slice(1).map((g) => g ?? '')])
  }),

  TEXTBEFORE: A(2, 6, lift((i) => i === 0, (a, ev) => around(a, ev, true))),
  TEXTAFTER: A(2, 6, lift((i) => i === 0, (a, ev) => around(a, ev, false))),
  TEXTSPLIT: A(2, 6, (a, ev) => {
    const text = str(ev.scalar(a[0]))
    const cols = delimiters(a[1], ev)
    const rows = a.length > 2 && a[2] !== null ? delimiters(a[2], ev) : []
    const skip = a.length > 3 && bool(ev.scalar(a[3]))
    const ci = a.length > 4 && num(ev.scalar(a[4])) !== 0
    const pad: Value = a.length > 5 ? ev.scalar(a[5]) : ERR.NA
    if (!cols.length && !rows.length) throw ERR.VALUE
    const cut = (s: string, ds: string[]) => {
      if (!ds.length) return [s]
      const parts = splitBy(s, ds, ci)
      return skip ? parts.filter((p) => p !== '') : parts
    }
    const grid = cut(text, rows).map((line) => cut(line, cols))
    const w = Math.max(1, ...grid.map((r) => r.length))
    if (!grid.length) return ''
    return new ArrayV(grid.map((r) => Array.from({ length: w }, (_, j): Value => (j < r.length ? r[j] : pad))))
  }),
  // Google Sheets: the text cut at any character of the delimiter (or at the whole of it), along a row
  SPLIT: A(2, 4, (a, ev) => {
    const text = str(ev.scalar(a[0]))
    const delim = str(ev.scalar(a[1]))
    const each = a.length > 2 ? bool(ev.scalar(a[2])) : true
    const dropEmpty = a.length > 3 ? bool(ev.scalar(a[3])) : true
    if (delim === '') throw ERR.VALUE
    let parts = splitBy(text, each ? [...delim] : [delim], false)
    if (dropEmpty) parts = parts.filter((p) => p !== '')
    if (!parts.length) return ''
    // what reads as a number is one, as when typed
    return new ArrayV([parts.map((p): Value => parseNumberText(p) ?? p)])
  }),
  JOIN: A(2, INF, (a, ev) => {
    const delim = str(ev.scalar(a[0]))
    const parts: string[] = []
    const add = (v: Value) => parts.push(str(v))
    for (const x of a.slice(1)) visit(x, ev, add, add)
    const s = parts.join(delim)
    if (s.length > MAX_TEXT) throw ERR.VALUE
    return s
  }),
  ENCODEURL: S(1, 1, ([x]) => encodeURIComponent(str(x)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)),
}

/** 1 asks for the strict form (text in quotes), 0 for the concise one */
function strict(n: number): boolean {
  const k = Math.trunc(n)
  if (k !== 0 && k !== 1) throw ERR.VALUE
  return k === 1
}

function valueText(v: Value, quoted: boolean): string {
  if (typeof v === 'string') return quoted ? `"${v.replace(/"/g, '""')}"` : v
  if (v instanceof FormulaError) return v.code
  return str(v)
}

/** a number with `d` decimals (a negative `d` rounds to the left of the point: the number was rounded so already) */
function grouped(n: number, d: number, commas: boolean): string {
  const neg = n < 0
  const [int, frac] = fixedDecimal(Math.abs(n), Math.max(0, d)).split('.')
  const whole = commas ? int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : int
  return (neg && Number(int + (frac ?? '')) !== 0 ? '-' : '') + whole + (frac ? `.${frac}` : '')
}

function numberValue(text: string, dec: string, grp: string): number {
  if (dec === '' || grp === '') throw ERR.VALUE
  const d = dec[0]
  const g = grp[0]
  if (d === g) throw ERR.VALUE
  let t = text.replace(/\s+/g, '')
  if (t === '') return 0
  let pct = 0
  while (t.endsWith('%')) {
    pct++
    t = t.slice(0, -1)
  }
  const at = t.indexOf(d)
  // a group separator after the decimal one, or a second decimal one, is not a number
  if (at >= 0 && (t.indexOf(d, at + 1) >= 0 || t.indexOf(g, at) >= 0)) throw ERR.VALUE
  t = t.split(g).join('')
  if (at >= 0) t = t.replace(d, '.')
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) throw ERR.VALUE
  const n = Number(t) / Math.pow(100, pct)
  if (!Number.isFinite(n)) throw ERR.VALUE
  return n
}

/** a pattern as a RegExp: with the Unicode classes when it reads so, without when only so (`\-` outside a class) */
function regex(pattern: string, ignoreCase: boolean, global: boolean, text: string): RegExp {
  const flags = (global ? 'g' : '') + (ignoreCase ? 'i' : '')
  let re: RegExp
  try {
    re = new RegExp(pattern, flags + 'u')
  } catch {
    try {
      re = new RegExp(pattern, flags)
    } catch {
      throw ERR.VALUE
    }
  }
  // a pattern that would backtrack without end on this text is an error: the worker cannot interrupt a running RegExp
  if (regexTooCostly(re, text, global)) throw ERR.VALUE
  return re
}

/** `text` with the match of `re` that starts at `at` replaced by `by` (`$1`… are its groups) */
function replaceAt(text: string, re: RegExp, at: number, by: string): string {
  re.lastIndex = at
  const m = re.exec(text)
  if (!m) return text
  const sub = m[0].replace(new RegExp(re.source, re.flags.replace('y', '')), by)
  return text.slice(0, at) + sub + text.slice(at + m[0].length)
}

/** the delimiters an argument gives (one, or each value of an array), longest first */
function delimiters(v: Val, ev: Ev): string[] {
  const out: string[] = []
  const add = (x: Value) => {
    const s = str(x)
    if (s !== '') out.push(s)
  }
  visit(v, ev, add, add)
  return out.sort((x, y) => y.length - x.length)
}

/** where the delimiters are in the text, left to right, none over another */
function findAll(text: string, ds: string[], ci: boolean): { at: number; len: number }[] {
  const hay = ci ? text.toLowerCase() : text
  const needles = ci ? ds.map((d) => d.toLowerCase()) : ds
  const out: { at: number; len: number }[] = []
  for (let i = 0; i < hay.length; ) {
    const d = needles.find((n) => hay.startsWith(n, i))
    if (d === undefined) i++
    else {
      out.push({ at: i, len: d.length })
      i += d.length
    }
  }
  return out
}

function splitBy(text: string, ds: string[], ci: boolean): string[] {
  const out: string[] = []
  let from = 0
  for (const m of findAll(text, ds, ci)) {
    out.push(text.slice(from, m.at))
    from = m.at + m.len
  }
  out.push(text.slice(from))
  return out
}

/** TEXTBEFORE / TEXTAFTER(text, delimiter, [instance], [match_mode], [match_end], [if_not_found]) */
function around(a: Val[], ev: Ev, before: boolean): Value {
  const text = str(ev.scalar(a[0]))
  const ds = delimiters(a[1], ev)
  const inst = a.length > 2 && a[2] !== null ? Math.trunc(num(ev.scalar(a[2]))) : 1
  const ci = a.length > 3 && a[3] !== null && num(ev.scalar(a[3])) !== 0
  const toEnd = a.length > 4 && a[4] !== null && num(ev.scalar(a[4])) !== 0
  if (inst === 0 || Math.abs(inst) > Math.max(1, text.length)) throw ERR.VALUE
  // an empty delimiter is found at once: at the start (counting from it), or at the end
  if (!ds.length) return (inst > 0) === before ? '' : text
  const found = findAll(text, ds, ci)
  // the end of the text counts as a delimiter too (its start, counting from the end)
  if (toEnd) {
    if (inst > 0) found.push({ at: text.length, len: 0 })
    else found.unshift({ at: 0, len: 0 })
  }
  const m = found[inst > 0 ? inst - 1 : found.length + inst]
  if (!m) {
    if (a.length > 5) return ev.scalar(a[5])
    throw ERR.NA
  }
  return before ? text.slice(0, m.at) : text.slice(m.at + m.len)
}

const THAI_DIGITS = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า']
const THAI_PLACES = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน']

/** a whole number below a million in Thai words */
function thaiGroup(n: number): string {
  let out = ''
  const digits = String(n)
  for (let i = 0; i < digits.length; i++) {
    const d = Number(digits[i])
    const place = digits.length - 1 - i
    if (d === 0) continue
    if (place === 1 && d === 1) out += THAI_PLACES[1]
    else if (place === 1 && d === 2) out += 'ยี่' + THAI_PLACES[1]
    // a final one after anything else is "et"
    else if (place === 0 && d === 1 && digits.length > 1) out += 'เอ็ด'
    else out += THAI_DIGITS[d] + THAI_PLACES[place]
  }
  return out
}

function thaiNumber(n: number): string {
  if (n === 0) return ''
  const high = Math.floor(n / 1e6)
  return (high ? thaiNumber(high) + 'ล้าน' : '') + thaiGroup(n % 1e6)
}

function bahtText(x: number): string {
  const neg = x < 0
  const total = Math.round(Math.abs(x) * 100)
  if (!Number.isSafeInteger(total)) throw ERR.NUM
  const baht = Math.floor(total / 100)
  const satang = total % 100
  let out = ''
  if (baht || !satang) out += (baht ? thaiNumber(baht) : THAI_DIGITS[0]) + 'บาท'
  out += satang ? thaiGroup(satang) + 'สตางค์' : 'ถ้วน'
  return (neg && total ? 'ลบ' : '') + out
}

// half-width katakana (U+FF61…FF9F) and what each is at full width
const HALF_KANA = '｡｢｣､･ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝﾞﾟ'
const FULL_KANA = '。「」、・ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン゛゜'
// those that take a voiced / half-voiced mark as one character at full width
const VOICED: Record<string, string> = Object.fromEntries([...'カキクケコサシスセソタチツテトハヒフヘホウ'].map((k, i) => [k, 'ガギグゲゴザジズゼゾダヂヅデドバビブベボヴ'[i]]))
const SEMI: Record<string, string> = Object.fromEntries([...'ハヒフヘホ'].map((k, i) => [k, 'パピプペポ'[i]]))
const UNVOICED = Object.fromEntries(Object.entries(VOICED).map(([k, v]) => [v, k]))
const UNSEMI = Object.fromEntries(Object.entries(SEMI).map(([k, v]) => [v, k]))

function toFullWidth(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    const c = ch.charCodeAt(0)
    if (c === 0x20) out += '\u3000'
    else if (c === 0x5c) out += '￥'
    else if (c >= 0x21 && c <= 0x7e) out += String.fromCharCode(c + 0xfee0)
    else {
      const k = HALF_KANA.indexOf(ch)
      if (k < 0) out += ch
      else {
        const full = FULL_KANA[k]
        const next = s[i + 1]
        if (next === 'ﾞ' && VOICED[full]) {
          out += VOICED[full]
          i++
        } else if (next === 'ﾟ' && SEMI[full]) {
          out += SEMI[full]
          i++
        } else out += full
      }
    }
  }
  return out
}

function toHalfWidth(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.charCodeAt(0)
    if (c === 0x3000) out += ' '
    else if (ch === '￥') out += '\\'
    else if (c >= 0xff01 && c <= 0xff5e) out += String.fromCharCode(c - 0xfee0)
    else if (UNVOICED[ch]) out += HALF_KANA[FULL_KANA.indexOf(UNVOICED[ch])] + 'ﾞ'
    else if (UNSEMI[ch]) out += HALF_KANA[FULL_KANA.indexOf(UNSEMI[ch])] + 'ﾟ'
    else {
      const k = FULL_KANA.indexOf(ch)
      out += k >= 0 ? HALF_KANA[k] : ch
    }
  }
  return out
}
