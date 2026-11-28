import type { Theme } from '../theme'
import { kid, kids, num, type XEl } from '../xml'
import { readPPr, readRPr } from './styles'
import type { ParaStyle, RunStyle } from './types'
import { dict } from '../dict'

export interface Level {
  start: number
  fmt: string
  text: string
  ps: ParaStyle
  rs: RunStyle
  isLgl: boolean
  suff: string
  restart?: number
}

interface NumInstance {
  abstractId: string
  starts: Record<number, number>
  levels: Record<number, Level>
}

// Private-use bullet glyphs from Symbol/Wingdings fonts → Unicode
const BULLETS: Record<string, string> = dict({
  '\uF0B7': '•', '\uF0A7': '▪', '\uF0A8': '□', '\uF0FC': '✓', '\uF0D8': '➢', '\uF076': '❖', '\uF0E0': '➔',
  '\uF06E': '■', '\uF071': '□', '\uF072': '❑', '\uF075': '◆', '\uF0E8': '➔', '\uF0F0': '⇨', '\uF0AE': '→',
  '\uF02D': '–', '\u00B7': '•', '\uF0BE': '—', '\uF06F': '○', '\uF09F': '•', '\uF0FE': '☑', o: '◦',
})

// a start value comes straight from the file (up to 2^31): past these the marker is plain decimal, as markers beyond
// what the format can sensibly spell would be megabytes of text
const MAX_ROMAN = 3999
const MAX_LETTER = 26 * 100

function roman(n: number): string {
  if (!(n > 0 && n <= MAX_ROMAN)) return String(n)
  const map: [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ]
  let s = ''
  for (const [v, r] of map) while (n >= v) (s += r), (n -= v)
  return s
}

function letters(n: number): string {
  if (n <= 0) return ''
  if (n > MAX_LETTER) return String(n)
  const ch = String.fromCharCode(97 + ((n - 1) % 26))
  return ch.repeat(Math.floor((n - 1) / 26) + 1)
}

/** a sequence of letters / syllables that repeats as doubled marks (a, b … z, aa, bb …) */
function alphabetic(n: number, alpha: string): string {
  const chars = [...alpha]
  const times = Math.floor((n - 1) / chars.length) + 1
  if (n <= 0 || times > 100) return String(n)
  return chars[(n - 1) % chars.length].repeat(times)
}

/** the digits of n written with another set of ten digits */
const positional = (n: number, digits: string) => (n < 0 ? String(n) : String(n).replace(/\d/g, (d) => [...digits][Number(d)]))

/** a number as East Asian counting (十一, 一百零五, 二万…); past what is written out the number stays decimal */
function counting(n: number, d: string, u: string, big = '万'): string {
  if (!(n > 0 && n < 1e8)) return String(n)
  const digits = [...d]
  const units = [...u]
  const section = (v: number, top: boolean) => {
    let s = ''
    let zero = false
    for (let i = 3; i >= 0; i--) {
      const dg = Math.floor(v / 10 ** i) % 10
      if (dg === 0) {
        if (s) zero = true
        continue
      }
      if (zero) (s += digits[0]), (zero = false)
      s += (dg === 1 && i === 1 && s === '' && top ? '' : digits[dg]) + (i ? units[i - 1] : '')
    }
    return s
  }
  const hi = Math.floor(n / 10000)
  const lo = n % 10000
  if (!hi) return section(lo, true)
  return section(hi, false) + big + (lo ? (lo < 1000 ? digits[0] : '') + section(lo, false) : '')
}

const ENCLOSED_CIRCLE = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
const ENCLOSED_PAREN = '⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽⑾⑿⒀⒁⒂⒃⒄⒅⒆⒇'
const ENCLOSED_STOP = '⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑⒒⒓⒔⒕⒖⒗⒘⒙⒚⒛'
const ALPHABETS: Record<string, string> = dict({
  ideographTraditional: '甲乙丙丁戊己庚辛壬癸',
  ideographZodiac: '子丑寅卯辰巳午未申酉戌亥',
  aiueo: 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ',
  aiueoFullWidth: 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン',
  iroha: 'ｲﾛﾊﾆﾎﾍﾄﾁﾘﾇﾙｦﾜｶﾖﾀﾚｿﾂﾈﾅﾗﾑｳヰﾉｵｸﾔﾏｹﾌｺｴﾃｱｻｷﾕﾒﾐｼヱﾋﾓｾｽ',
  irohaFullWidth: 'イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセス',
  ganada: '가나다라마바사아자차카타파하',
  chosung: 'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ',
  hebrew2: 'אבגדהוזחטיכלמנסעפצקרשת',
  arabicAlpha: 'أبتثجحخدذرزسشصضطظعغفقكلمنهوي',
  arabicAbjad: 'أبجدهوزحطيكلمنسعفصقرشتثخذضظغ',
  thaiLetters: 'กขคงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮ',
  russianLower: 'абвгдежзиклмнопрстуфхцчшщэюя',
  russianUpper: 'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ',
  hindiVowels: 'अआइईउऊऋएऐओऔ',
  hindiConsonants: 'कखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसह',
})

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
const ORD: Record<string, string> = dict({ one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' })

/** English words for 1…999999 (undefined past it), as separate words and hyphenated tens */
function words(n: number): string[] | undefined {
  if (!(n > 0 && n <= 999999)) return undefined
  const below1000 = (v: number): string[] => {
    const out: string[] = []
    if (v >= 100) out.push(ONES[Math.floor(v / 100)], 'hundred')
    const r = v % 100
    if (r) out.push(r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? '-' + ONES[r % 10] : ''))
    return out
  }
  const th = Math.floor(n / 1000)
  return [...(th ? [...below1000(th), 'thousand'] : []), ...below1000(n % 1000)]
}
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function ordinalWords(w: string[]): string {
  const last = w[w.length - 1]
  const dash = last.lastIndexOf('-')
  const base = last.slice(dash + 1)
  const o = ORD[base] ?? (base.endsWith('y') ? base.slice(0, -1) + 'ieth' : base + 'th')
  return [...w.slice(0, -1), last.slice(0, dash + 1) + o].join(' ')
}

const VI_ONES = ['', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín']
function vietnamese(n: number): string {
  if (!(n > 0 && n < 100)) return String(n)
  const t = Math.floor(n / 10)
  const u = n % 10
  const s = t === 0 ? VI_ONES[u] : (t === 1 ? 'mười' : VI_ONES[t] + ' mươi') + (u === 0 ? '' : ' ' + (u === 5 ? 'lăm' : u === 1 && t > 1 ? 'mốt' : VI_ONES[u]))
  return capital(s)
}

/** Hebrew numerals (gematria): 15 and 16 are written טו / טז */
function hebrew(n: number): string {
  if (!(n > 0 && n < 1000)) return String(n)
  let s = ''
  let v = n
  while (v >= 400) (s += 'ת'), (v -= 400)
  s += ['', 'ק', 'ר', 'ש'][Math.floor(v / 100)]
  v %= 100
  if (v === 15) return s + 'טו'
  if (v === 16) return s + 'טז'
  return s + ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'][Math.floor(v / 10)] + ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'][v % 10]
}

export function formatNumber(n: number, fmt: string): string {
  switch (fmt) {
    case 'decimalZero': return n < 10 ? '0' + n : String(n)
    case 'upperRoman': return roman(n).toUpperCase()
    case 'lowerRoman': return roman(n)
    case 'upperLetter': return letters(n).toUpperCase()
    case 'lowerLetter': return letters(n)
    case 'ordinal': {
      const s = ['th', 'st', 'nd', 'rd']
      const v = n % 100
      return n + (s[(v - 20) % 10] || s[v] || s[0])
    }
    case 'cardinalText': {
      const w = words(n)
      return w ? capital(w.join(' ')) : String(n)
    }
    case 'ordinalText': {
      const w = words(n)
      return w ? capital(ordinalWords(w)) : String(n)
    }
    case 'chineseCounting': case 'chineseCountingThousand': case 'japaneseCounting': case 'taiwaneseCounting': case 'taiwaneseCountingThousand':
      return counting(n, '零一二三四五六七八九', '十百千')
    case 'chineseLegalSimplified': return counting(n, '零壹贰叁肆伍陆柒捌玖', '拾佰仟')
    case 'ideographLegalTraditional': case 'japaneseLegal': return counting(n, '零壹貳參肆伍陸柒捌玖', '拾佰仟')
    case 'koreanCounting': return counting(n, '영일이삼사오육칠팔구', '십백천', '만')
    case 'koreanLegal': return counting(n, '영일이삼사오육칠팔구', '십백천', '만')
    case 'ideographDigital': case 'taiwaneseDigital': case 'japaneseDigitalTenThousand': return positional(n, '〇一二三四五六七八九')
    case 'koreanDigital': case 'koreanDigital2': return positional(n, '영일이삼사오육칠팔구')
    case 'thaiNumbers': return positional(n, '๐๑๒๓๔๕๖๗๘๙')
    case 'hindiNumbers': return positional(n, '०१२३४५६७८९')
    case 'decimalFullWidth': case 'decimalFullWidth2': return positional(n, '０１２３４５６７８９')
    case 'decimalEnclosedCircle': case 'decimalEnclosedCircleChinese': return n >= 1 && n <= 20 ? ENCLOSED_CIRCLE[n - 1] : String(n)
    case 'decimalEnclosedParen': return n >= 1 && n <= 20 ? ENCLOSED_PAREN[n - 1] : String(n)
    case 'decimalEnclosedFullstop': return n >= 1 && n <= 20 ? ENCLOSED_STOP[n - 1] : String(n)
    case 'hebrew1': return hebrew(n)
    case 'hex': return n >= 0 ? n.toString(16).toUpperCase() : String(n)
    case 'numberInDash': return `-${n}-`
    case 'vietnameseCounting': return vietnamese(n)
    case 'none': return ''
    case 'bullet': return ''
    default: {
      const alpha = ALPHABETS[fmt]
      return alpha ? alphabetic(n, alpha) : String(n)
    }
  }
}

export class Numbering {
  private abstracts = new Map<string, Record<number, Level>>()
  private nums = new Map<string, NumInstance>()
  private counters = new Map<string, number[]>()
  /** abstract list → the one it takes its levels from (numStyleLink → styleLink) */
  private linked = new Map<string, string>()

  constructor(root: XEl | undefined, theme: Theme) {
    if (!root) return
    const readLevels = (el: XEl) => {
      const out: Record<number, Level> = {}
      for (const l of kids(el, 'lvl')) {
        const ilvl = num(l.a.ilvl, 0)!
        out[ilvl] = {
          start: num(kid(l, 'start')?.a.val, 1)!,
          fmt: kid(l, 'numFmt')?.a.val ?? 'decimal',
          text: kid(l, 'lvlText')?.a.val ?? '',
          ps: readPPr(kid(l, 'pPr')).ps,
          rs: readRPr(kid(l, 'rPr'), theme),
          isLgl: !!kid(l, 'isLgl'),
          suff: kid(l, 'suff')?.a.val ?? 'tab',
          restart: num(kid(l, 'lvlRestart')?.a.val),
        }
      }
      return out
    }
    const styleLinks = new Map<string, string>()
    for (const a of kids(root, 'abstractNum')) {
      this.abstracts.set(a.a.abstractNumId, readLevels(a))
      const link = kid(a, 'styleLink')?.a.val
      if (link && !styleLinks.has(link)) styleLinks.set(link, a.a.abstractNumId)
    }
    // a list that takes its levels from a list style: the abstract list that defines the style (its counters are shared)
    for (const a of kids(root, 'abstractNum')) {
      const target = styleLinks.get(kid(a, 'numStyleLink')?.a.val ?? '')
      if (target === undefined || target === a.a.abstractNumId || Object.keys(this.abstracts.get(a.a.abstractNumId) ?? {}).length) continue
      this.linked.set(a.a.abstractNumId, target)
      this.abstracts.set(a.a.abstractNumId, this.abstracts.get(target) ?? {})
    }
    for (const n of kids(root, 'num')) {
      const inst: NumInstance = { abstractId: kid(n, 'abstractNumId')?.a.val ?? '', starts: {}, levels: {} }
      for (const o of kids(n, 'lvlOverride')) {
        const ilvl = num(o.a.ilvl, 0)!
        const so = num(kid(o, 'startOverride')?.a.val)
        if (so !== undefined) inst.starts[ilvl] = so
        const lvl = kid(o, 'lvl')
        if (lvl) Object.assign(inst.levels, readLevels({ n: 'x', a: {}, c: [{ ...lvl, a: { ...lvl.a, ilvl: String(ilvl) } }], t: '' }))
      }
      this.nums.set(n.a.numId, inst)
    }
  }

  reset() {
    this.counters.clear()
  }

  /** First list instance whose level 0 is a bullet / a number, without overrides. */
  findList(kind: 'bullet' | 'number'): string | undefined {
    for (const [id, inst] of this.nums) {
      if (Object.keys(inst.starts).length) continue
      const l0 = this.abstracts.get(inst.abstractId)?.[0]
      if (!l0) continue
      if (kind === 'bullet' ? l0.fmt === 'bullet' : l0.fmt === 'decimal') return id
    }
    return undefined
  }

  ids(): { abstract: number; num: number } {
    const a = [...this.abstracts.keys()].map(Number).filter(Number.isFinite)
    const n = [...this.nums.keys()].map(Number).filter(Number.isFinite)
    return { abstract: a.length ? Math.max(...a) + 1 : 0, num: n.length ? Math.max(...n) + 1 : 1 }
  }

  level(numId: string, ilvl: number): Level | undefined {
    const inst = this.nums.get(numId)
    if (!inst) return undefined
    return inst.levels[ilvl] ?? this.abstracts.get(inst.abstractId)?.[ilvl]
  }

  /** the abstract list that holds the levels of a list (the one a list style defines, for a list that follows a style) */
  abstractOf(numId: string): string | undefined {
    const inst = this.nums.get(numId)
    return inst && (this.linked.get(inst.abstractId) ?? inst.abstractId)
  }

  /** Advances the counter for (numId, ilvl) and returns the marker text. */
  next(numId: string, ilvl: number): { text: string; level: Level } | undefined {
    const inst = this.nums.get(numId)
    const level = this.level(numId, ilvl)
    if (!inst || !level) return undefined
    const hasOverride = Object.keys(inst.starts).length > 0
    const key = hasOverride ? 'n' + numId : 'a' + (this.linked.get(inst.abstractId) ?? inst.abstractId)
    let c = this.counters.get(key)
    if (!c) {
      c = []
      this.counters.set(key, c)
    }
    const startOf = (l: number) => inst.starts[l] ?? this.level(numId, l)?.start ?? 1
    c[ilvl] = c[ilvl] === undefined ? startOf(ilvl) : c[ilvl] + 1
    for (let d = ilvl + 1; d < 9; d++) c[d] = undefined as unknown as number
    for (let d = 0; d < ilvl; d++) if (c[d] === undefined) c[d] = startOf(d)
    if (level.fmt === 'bullet') {
      const t = level.text
      return { text: BULLETS[t] ?? (t || '•'), level }
    }
    const text = level.text.replace(/%(\d)/g, (_, d: string) => {
      const l = Number(d) - 1
      const lv = this.level(numId, l)
      const v = c![l] ?? startOf(l)
      // legal numbering: every number of the level, its own included, is Arabic
      return formatNumber(v, level.isLgl && lv?.fmt !== 'none' ? 'decimal' : lv?.fmt ?? 'decimal')
    })
    return { text, level }
  }
}
