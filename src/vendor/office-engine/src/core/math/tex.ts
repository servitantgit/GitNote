/**
 * TeX math → MathML: what people write between `$…$` / `$$…$$` in Markdown, as a tree the views draw with the
 * browser's own MathML (and as a string for web pages). No DOM, no dependency.
 *
 * Nothing throws out of here. A command it does not know shows as its source in an `merror`, the rest is drawn; input
 * it cannot make sense of (an unclosed brace, `\left` without `\right`, an unknown environment, too long or nested too
 * deeply) gives the whole source in an `merror`. The TeX always travels along, in an `annotation`.
 */
import { dict } from '../dict'
import { ACCENT, BIG, BIG_CHARS, DELIM, DELIM_CHARS, FUNC, FUNC_LIMITS, funcText, INTEGRAL, NEGATED, OP, OP_CHAR, ORD, SPACE, styled, UPRIGHT, type Font } from './symbols'

/** a MathML element (`x`: the text of a token element) */
export interface MNode {
  t: string
  a?: Record<string, string>
  k?: MNode[]
  x?: string
  /** what the OMML writer needs to know and MathML does not say: never written out */
  n?: MNote
}

export interface MNote {
  /** a big operator: limits under / over in display style ('display'), always ('limits'), or beside ('side') */
  op?: 'display' | 'limits' | 'side'
  /** a function name (sin, lim…): followed by an invisible function application */
  fn?: boolean
  /** an mrow between \left and \right: the two delimiters ('' for none) */
  fence?: [string, string]
  /** a \middle delimiter inside such an mrow */
  sep?: boolean
}

/** the source is longer: shown as it is */
export const MAX_TEX = 20_000
/** groups inside one another, at most */
const MAX_DEPTH = 40
/** elements made, at most */
const MAX_NODES = 50_000

class TexError extends Error {}

const el = (t: string, k?: MNode[], a?: Record<string, string>, n?: MNote): MNode => ({ t, ...(k ? { k } : {}), ...(a ? { a } : {}), ...(n ? { n } : {}) })
const tok = (t: string, x: string, a?: Record<string, string>, n?: MNote): MNode => ({ t, x, ...(a ? { a } : {}), ...(n ? { n } : {}) })
const mo = (x: string, a?: Record<string, string>, n?: MNote) => tok('mo', x, a, n)
/** text: a space at either end would be dropped, it is a no-break space */
const mtext = (x: string, a?: Record<string, string>) => tok('mtext', x.replace(/^\s|\s$/g, '\u00a0'), a)
/** several nodes as one (one alone is itself) */
const row = (k: MNode[]): MNode => (k.length === 1 ? k[0] : el('mrow', k))
const space = (em: number) => el('mspace', undefined, { width: `${+em.toFixed(4)}em` })
/** the invisible function application after sin, lim… */
const FN_APPLY = '\u2061'

/** the mathcolor of a color name or #rgb / #rrggbb (also \color[HTML]{…} and [rgb]{r,g,b}), else undefined */
function colorOf(spec: string, model?: string): string | undefined {
  const v = spec.trim()
  if (model === 'HTML' && /^[0-9a-f]{6}$/i.test(v)) return '#' + v.toLowerCase()
  if (model === 'rgb' || model === 'RGB') {
    const parts = v.split(',').map((x) => Number(x.trim()))
    if (parts.length !== 3 || parts.some((x) => !Number.isFinite(x) || x < 0)) return undefined
    const k = model === 'rgb' ? 255 : 1
    return '#' + parts.map((x) => Math.min(255, Math.round(x * k)).toString(16).padStart(2, '0')).join('')
  }
  if (/^[a-z]{1,20}$/i.test(v)) return v.toLowerCase()
  if (/^#(?:[0-9a-f]{3}){1,2}$/i.test(v)) return v.toLowerCase()
  return undefined
}

/** a length (\hspace{1em}, \kern3mu) in em; undefined when it is not one */
function lengthEm(spec: string): number | undefined {
  const m = /^\s*(-?\d*\.?\d+)\s*(em|ex|mu|pt|px|pc|bp|cm|mm|in)?\s*$/.exec(spec)
  if (!m) return undefined
  const v = Number(m[1])
  const per: Record<string, number> = { em: 1, ex: 0.43, mu: 1 / 18, pt: 0.1, px: 1 / 16, pc: 1.2, bp: 0.1, cm: 2.85, mm: 0.285, in: 7.23 }
  return Math.max(-10, Math.min(100, v * (per[m[2] ?? 'em'] ?? 1)))
}

/** environments: delimiters around, column alignment (repeated), display style inside, columns as pairs (aligned) */
interface Env {
  open?: string
  close?: string
  align?: string[]
  display?: boolean
  pairs?: boolean
  small?: boolean
  /** a column spec as the first argument (array) */
  spec?: boolean
  /** a number as the first argument (alignat) */
  count?: boolean
}
const ENV: Record<string, Env> = dict({
  matrix: {}, pmatrix: { open: '(', close: ')' }, bmatrix: { open: '[', close: ']' }, Bmatrix: { open: '{', close: '}' },
  vmatrix: { open: '|', close: '|' }, Vmatrix: { open: '‖', close: '‖' }, smallmatrix: { small: true },
  'matrix*': {}, 'pmatrix*': { open: '(', close: ')' }, 'bmatrix*': { open: '[', close: ']' }, 'Bmatrix*': { open: '{', close: '}' },
  'vmatrix*': { open: '|', close: '|' }, 'Vmatrix*': { open: '‖', close: '‖' },
  cases: { open: '{', align: ['left'] }, dcases: { open: '{', align: ['left'], display: true }, rcases: { close: '}', align: ['left'] },
  aligned: { pairs: true, display: true }, align: { pairs: true, display: true }, 'align*': { pairs: true, display: true },
  alignat: { pairs: true, display: true, count: true }, 'alignat*': { pairs: true, display: true, count: true }, alignedat: { pairs: true, display: true, count: true },
  split: { pairs: true, display: true }, flalign: { pairs: true, display: true }, 'flalign*': { pairs: true, display: true },
  gathered: { display: true }, gather: { display: true }, 'gather*': { display: true }, multline: { display: true }, 'multline*': { display: true },
  equation: { display: true }, 'equation*': { display: true },
  eqnarray: { align: ['right', 'center', 'left'], display: true }, 'eqnarray*': { align: ['right', 'center', 'left'], display: true },
  array: { spec: true }, subarray: { spec: true, small: true },
})

const FONT_CMD: Record<string, Font> = dict({
  mathrm: 'normal', mathup: 'normal', mathbf: 'bold', mathit: 'italic', mathbb: 'double-struck', mathcal: 'script', mathscr: 'script',
  mathfrak: 'fraktur', mathsf: 'sans-serif', mathtt: 'monospace', boldsymbol: 'bold-italic', bm: 'bold-italic', mathbfit: 'bold-italic',
  mathsfit: 'sans-serif-italic', Bbb: 'double-struck', frak: 'fraktur',
})
const FONT_SWITCH: Record<string, Font> = dict({ rm: 'normal', bf: 'bold', it: 'italic', sf: 'sans-serif', tt: 'monospace', cal: 'script' })
const TEXT_CMD: Record<string, string | undefined> = dict({ text: undefined, textrm: undefined, textnormal: undefined, mbox: undefined, hbox: undefined, textup: undefined, textbf: 'bold', textit: 'italic', textsf: 'sans-serif', texttt: 'monospace', emph: 'italic' })
const STYLE_SWITCH: Record<string, Record<string, string>> = dict({
  displaystyle: { displaystyle: 'true', scriptlevel: '0' }, textstyle: { displaystyle: 'false', scriptlevel: '0' },
  scriptstyle: { displaystyle: 'false', scriptlevel: '1' }, scriptscriptstyle: { displaystyle: 'false', scriptlevel: '2' },
})
/** \big… delimiter sizes */
const BIG_SIZE: Record<string, string> = dict({ big: '1.2em', Big: '1.623em', bigg: '2.047em', Bigg: '2.470em' })
const ENCLOSE: Record<string, string> = dict({ boxed: 'box', fbox: 'box', cancel: 'updiagonalstrike', bcancel: 'downdiagonalstrike', xcancel: 'updiagonalstrike downdiagonalstrike' })
/** escapes that are their character */
const ESCAPED: Record<string, string> = dict({ '%': '%', $: '$', '#': '#', '&': '&', _: '_', '{': '{', '}': '}' })

const isLetter = (c: string) => /^\p{L}$/u.test(c)
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9'

class Parser {
  private i = 0
  private depth = 0
  private made = 0
  private font: Font | null = null
  /** display style where the parser is (limits of big operators go under / over) */
  private dstyle: boolean
  /** \tag{…} */
  tag?: string
  /** commands not known, for the error message */
  readonly unknown: string[] = []

  constructor(
    private s: string,
    display: boolean,
  ) {
    this.dstyle = display
  }

  private node<T extends MNode>(n: T): T {
    if (++this.made > MAX_NODES) throw new TexError('Too many elements')
    return n
  }

  // ---------------------------------------------------------------- tokens

  /** spaces and % comments */
  private ws() {
    const s = this.s
    while (this.i < s.length) {
      const c = s[this.i]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') this.i++
      else if (c === '%') while (this.i < s.length && s[this.i] !== '\n') this.i++
      else break
    }
  }

  /** the next token, not taken: a command with its backslash ("\frac", "\,", "\\"), or one character */
  peek(): string | null {
    this.ws()
    const s = this.s
    if (this.i >= s.length) return null
    if (s[this.i] === '\\') {
      let j = this.i + 1
      if (j >= s.length) throw new TexError('A backslash ends the text')
      if (/[a-zA-Z]/.test(s[j])) while (j < s.length && /[a-zA-Z]/.test(s[j])) j++
      else j += s.codePointAt(j)! > 0xffff ? 2 : 1
      return s.slice(this.i, j)
    }
    return String.fromCodePoint(s.codePointAt(this.i)!)
  }

  take(): string | null {
    const t = this.peek()
    if (t !== null) this.i += t.length
    return t
  }

  private expect(t: string) {
    const got = this.take()
    if (got !== t) throw new TexError(got === null ? `Missing ${t}` : `Expected ${t}, found ${got}`)
  }

  /** a `*` right after a command name (\operatorname*) */
  private star(): boolean {
    if (this.s[this.i] !== '*') return false
    this.i++
    return true
  }

  /** the text of a {…} argument as it is (braces inside kept), or of the next token */
  private raw(): string {
    this.ws()
    const s = this.s
    if (s[this.i] !== '{') {
      const t = this.take()
      if (t === null) throw new TexError('Missing argument')
      return t
    }
    let depth = 0
    const start = this.i + 1
    for (let j = this.i; j < s.length; j++) {
      const c = s[j]
      if (c === '\\') j++
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) {
        this.i = j + 1
        return s.slice(start, j)
      }
    }
    throw new TexError('Missing }')
  }

  /** an optional [...] argument as text */
  private rawOpt(): string | undefined {
    this.ws()
    if (this.s[this.i] !== '[') return undefined
    const e = this.s.indexOf(']', this.i)
    if (e < 0) throw new TexError('Missing ]')
    const v = this.s.slice(this.i + 1, e)
    this.i = e + 1
    return v
  }

  // ---------------------------------------------------------------- structure

  /** the whole formula: rows when it has \\ or & at the top */
  top(): MNode {
    const rows = this.rows(() => false)
    if (this.i < this.s.length) throw new TexError(`Unexpected ${this.peek()}`)
    let body: MNode
    if (rows.length === 1 && rows[0].length === 1) body = rows[0][0]
    else body = this.table(rows, { pairs: rows.some((r) => r.length > 1), display: this.dstyle })
    if (this.tag !== undefined) body = el('mrow', [body, space(2), mtext(this.tag)])
    return body
  }

  /** items up to `stop` (or the end of the group / text), the switches (\displaystyle, \color…) applied to what follows them */
  private expr(stop: (t: string) => boolean): MNode[] {
    const out: MNode[] = []
    for (;;) {
      const t = this.peek()
      if (t === null || stop(t)) return out
      switch (t) {
        case '}':
          throw new TexError('Unexpected }')
        case '&':
          throw new TexError('Misplaced &')
        case '\\\\':
        case '\\cr':
          throw new TexError('Misplaced \\\\')
        case '\\end':
          throw new TexError('\\end without \\begin')
        case '\\right':
          throw new TexError('\\right without \\left')
        case '\\over':
        case '\\atop':
        case '\\choose': {
          this.take()
          const den = this.expr(stop)
          const f = this.node(el('mfrac', [row(out), row(den)], t === '\\over' ? undefined : { linethickness: '0' }))
          return [t === '\\choose' ? el('mrow', [mo('('), f, mo(')')]) : f]
        }
      }
      const name = t.slice(1)
      if (t[0] === '\\' && STYLE_SWITCH[name]) {
        this.take()
        const saved = this.dstyle
        this.dstyle = name === 'displaystyle'
        const rest = this.expr(stop)
        this.dstyle = saved
        out.push(this.node(el('mstyle', rest, { ...STYLE_SWITCH[name] })))
        return out
      }
      if (t[0] === '\\' && FONT_SWITCH[name]) {
        this.take()
        const saved = this.font
        this.font = FONT_SWITCH[name]
        out.push(...this.expr(stop))
        this.font = saved
        return out
      }
      if (t === '\\color') {
        this.take()
        const model = this.rawOpt()
        const c = colorOf(this.raw(), model)
        const rest = this.expr(stop)
        out.push(c ? this.node(el('mstyle', rest, { mathcolor: c })) : row(rest))
        return out
      }
      const n = this.scripted()
      if (n) out.push(n)
    }
  }

  /** cells and rows (& and \\) up to `end` */
  private rows(end: (t: string) => boolean): MNode[][] {
    const rows: MNode[][] = []
    let cells: MNode[] = []
    for (;;) {
      while (this.peek() === '\\hline' || this.peek() === '\\hdashline') this.take()
      cells.push(row(this.expr((t) => t === '&' || t === '\\\\' || t === '\\cr' || end(t))))
      const t = this.peek()
      if (t === '&') {
        this.take()
        continue
      }
      if (t === '\\\\' || t === '\\cr') {
        this.take()
        this.rawOpt()
        rows.push(cells)
        cells = []
        continue
      }
      rows.push(cells)
      break
    }
    // a last \\ does not start a row
    const last = rows[rows.length - 1]
    if (rows.length > 1 && last.length === 1 && last[0].t === 'mrow' && !last[0].k?.length) rows.pop()
    return rows
  }

  private table(rows: MNode[][], env: Env, spec?: string[]): MNode {
    const cols = Math.max(...rows.map((r) => r.length))
    const alignOf = (c: number) => (spec ? spec[c] ?? 'center' : env.pairs ? (c % 2 ? 'left' : 'right') : env.align ? env.align[c % env.align.length] : 'center')
    const trs = rows.map((r) =>
      this.node(
        el(
          'mtr',
          Array.from({ length: cols }, (_, c) => {
            let cell = r[c] ?? el('mrow', [])
            // the right half of an aligned pair starts with a relation spaced as one (TeX puts {} there)
            if (env.pairs && c % 2 && r[c]) cell = el('mrow', [el('mi', []), ...(cell.t === 'mrow' && !cell.n ? cell.k ?? [] : [cell])])
            const align = alignOf(c)
            return this.node(el('mtd', [cell], align !== 'center' ? { columnalign: align } : undefined))
          }),
        ),
      ),
    )
    const a: Record<string, string> = {}
    if (env.display) a.displaystyle = 'true'
    if (env.small) a.scriptlevel = '1'
    const aligns = Array.from({ length: cols }, (_, c) => alignOf(c))
    if (aligns.some((x) => x !== 'center')) a.columnalign = aligns.join(' ')
    if (env.pairs) a.columnspacing = '0em 2em'
    else if (env.align?.[0] === 'left' && cols > 1) a.columnspacing = '1em'
    if (env.small) a.rowspacing = '0.1em'
    return this.node(el('mtable', trs, Object.keys(a).length ? a : undefined))
  }

  // ---------------------------------------------------------------- atoms

  /** an atom with its scripts, limits and primes */
  private scripted(): MNode | null {
    const t = this.peek()
    const base = t === '^' || t === '_' || t === "'" ? null : this.atom()
    let sub: MNode | undefined
    let sup: MNode | undefined
    let primes = 0
    let limits: boolean | undefined
    for (;;) {
      const s = this.peek()
      if (s === '\\limits' || s === '\\nolimits') {
        this.take()
        limits = s === '\\limits'
      } else if (s === "'") {
        this.take()
        primes++
      } else if (s === '^' || s === '_') {
        this.take()
        if ((s === '^' ? sup : sub) !== undefined) throw new TexError(s === '^' ? 'Double superscript' : 'Double subscript')
        const saved = this.dstyle
        this.dstyle = false
        const a = this.arg()
        this.dstyle = saved
        if (s === '^') sup = a
        else sub = a
      } else break
    }
    if (primes) {
      const p = mo(primes <= 4 ? ['′', '″', '‴', '⁗'][primes - 1] : '′'.repeat(primes))
      sup = sup ? el('mrow', [p, sup]) : p
    }
    if (!sub && !sup) return base && base.n?.fn ? this.apply(base) : base
    const b = base ?? el('mrow', [])
    const op = b.n?.op
    const under = op === 'limits' || (op !== undefined && limits !== false && (limits === true || (op === 'display' && this.dstyle)))
    if (under && limits && b.t === 'mo') b.a = { ...b.a, movablelimits: 'false' }
    let n: MNode
    if (under) n = sub && sup ? el('munderover', [b, sub, sup]) : sub ? el('munder', [b, sub]) : el('mover', [b, sup!])
    else n = sub && sup ? el('msubsup', [b, sub, sup]) : sub ? el('msub', [b, sub]) : el('msup', [b, sup!])
    this.node(n)
    return b.n?.fn ? this.apply(n) : n
  }

  /** a function name and the invisible function application after it, spaced as TeX spaces it from what follows (not from a bracket) */
  private apply(fn: MNode): MNode {
    const next = this.peek()
    const tight = next === null || next === '(' || next === '[' || next === '|' || next === '\\left' || next === '}' || next === '&' || next === '\\\\' || next === '\\{' || next === '\\langle'
    return el('mrow', [fn, mo(FN_APPLY, tight ? undefined : { rspace: '0.1667em' })])
  }

  /** an argument: a {group} or one token */
  private arg(): MNode {
    const t = this.peek()
    if (t === null || t === '}' || t === '&' || t === '^' || t === '_' || t === '\\\\' || t === '\\end' || t === '\\right') throw new TexError('Missing argument')
    // one digit is one token: \frac12, x^23 (the 3 is not in the script)
    if (isDigit(t)) {
      this.take()
      const f = this.font
      return this.node(tok('mn', f && f !== 'normal' && f !== 'italic' ? styled(t, f) : t))
    }
    return this.atom() ?? el('mrow', [])
  }

  private atom(): MNode | null {
    if (++this.depth > MAX_DEPTH) throw new TexError('Nested too deeply')
    try {
      const t = this.take()!
      if (t === '{') {
        const k = this.expr((x) => x === '}')
        this.expect('}')
        return this.node(k.length === 1 ? k[0] : el('mrow', k))
      }
      if (t[0] === '\\' && t.length > 1) return this.command(t.slice(1))
      return this.char(t)
    } finally {
      this.depth--
    }
  }

  /** a letter in the current font */
  private letter(c: string, upright = false): MNode {
    const f = this.font
    if (f === 'normal' || (!f && upright)) return this.node(tok('mi', c, { mathvariant: 'normal' }))
    return this.node(tok('mi', f ? styled(c, f) : c))
  }

  private char(c: string): MNode {
    const s = this.s
    if (isDigit(c) || (c === '.' && isDigit(s[this.i]))) {
      let num = c
      while (this.i < s.length && (isDigit(s[this.i]) || (s[this.i] === '.' && isDigit(s[this.i + 1])))) num += s[this.i++]
      const f = this.font
      return this.node(tok('mn', f && f !== 'normal' && f !== 'italic' ? [...num].map((d) => styled(d, f)).join('') : num))
    }
    if (isLetter(c)) {
      // \mathrm{max}: one word
      if (this.font === 'normal') {
        let word = c
        while (this.i < s.length && /[a-zA-Z]/.test(s[this.i])) word += s[this.i++]
        if (word.length > 1) return this.node(tok('mi', word))
      }
      return this.letter(c)
    }
    switch (c) {
      case '~':
        return this.node(mtext('\u00a0'))
      case '#':
      case '$':
        throw new TexError(`Unexpected ${c}`)
      case '(':
      case ')':
      case '[':
      case ']':
      case '|':
        return this.node(mo(c, { stretchy: 'false' }))
    }
    if (BIG_CHARS.has(c)) return this.node(mo(c, undefined, { op: INTEGRAL.has(c) ? 'side' : 'display' }))
    return this.node(mo(OP_CHAR[c] ?? c))
  }

  /** a delimiter after \left, \right, \big… ('' for `.`) */
  private delim(): string {
    const t = this.take()
    if (t === null) throw new TexError('Missing delimiter')
    if (t === '.') return ''
    if (t[0] === '\\' && t.length > 1) {
      const d = DELIM[t.slice(1)]
      if (d !== undefined) return d
    } else if (DELIM_CHARS.has(t)) return t === '<' ? '⟨' : t === '>' ? '⟩' : t
    throw new TexError(`Not a delimiter: ${t}`)
  }

  private command(name: string): MNode | null {
    const ord = ORD[name]
    if (ord !== undefined) return this.letter(ord)
    const up = UPRIGHT[name]
    if (up !== undefined) return this.letter(up, true)
    if (/^var[A-Z]/.test(name) && UPRIGHT[name.slice(3)] !== undefined) return this.node(tok('mi', styled(UPRIGHT[name.slice(3)], 'italic')))
    const op = OP[name]
    if (op !== undefined) return this.node(mo(op))
    const big = BIG[name]
    if (big !== undefined) return this.node(mo(big, undefined, { op: INTEGRAL.has(big) ? 'side' : 'display' }))
    if (FUNC.has(name) || FUNC_LIMITS.has(name)) return this.node(tok('mi', funcText(name), undefined, { fn: true, ...(FUNC_LIMITS.has(name) ? { op: 'display' } : {}) }))
    const sp = SPACE[name]
    if (sp !== undefined) return this.node(space(sp))
    if (ESCAPED[name] !== undefined) return this.node(name === '_' || name === '#' || name === '%' || name === '&' ? tok('mi', ESCAPED[name]) : mo(ESCAPED[name], { stretchy: 'false' }))
    const d = DELIM[name]
    if (d !== undefined) return this.node(mo(d, { stretchy: 'false' }))
    const acc = ACCENT[name]
    if (acc) {
      const body = this.arg()
      const mark = mo(acc.c, acc.wide ? { stretchy: 'true' } : { stretchy: 'false' })
      const n = acc.under ? el('munder', [body, mark], acc.accent ? { accentunder: 'true' } : undefined) : el('mover', [body, mark], acc.accent ? { accent: 'true' } : undefined)
      // a brace takes its label as a limit: \overbrace{x}^{n}
      if (name === 'overbrace' || name === 'underbrace' || name === 'overgroup' || name === 'undergroup') n.n = { op: 'limits' }
      return this.node(n)
    }
    const font = FONT_CMD[name]
    if (font) {
      const saved = this.font
      this.font = font
      try {
        return this.arg()
      } finally {
        this.font = saved
      }
    }
    if (name in TEXT_CMD) return this.text(this.raw(), TEXT_CMD[name])
    const size = BIG_SIZE[name.replace(/[lrm]$/, '')]
    if (size) {
      const c = this.delim()
      return this.node(mo(c || '\u200b', { minsize: size, maxsize: size, stretchy: 'true', symmetric: 'true' }))
    }
    switch (name) {
      case 'frac':
      case 'dfrac':
      case 'tfrac':
      case 'cfrac':
      case 'binom':
      case 'dbinom':
      case 'tbinom': {
        const saved = this.dstyle
        this.dstyle = false
        const num = this.arg()
        const den = this.arg()
        this.dstyle = saved
        const binom = name.endsWith('binom')
        let f: MNode = this.node(el('mfrac', [num, den], binom ? { linethickness: '0' } : undefined))
        if (binom) f = el('mrow', [mo('('), f, mo(')')])
        if (name[0] === 'd' || name === 'cfrac') return this.node(el('mstyle', [f], { displaystyle: 'true', scriptlevel: '0' }))
        if (name[0] === 't') return this.node(el('mstyle', [f], { displaystyle: 'false', scriptlevel: '0' }))
        return f
      }
      case 'sqrt': {
        this.ws()
        let index: MNode | undefined
        if (this.s[this.i] === '[') {
          this.i++
          index = row(this.expr((t) => t === ']'))
          this.expect(']')
        }
        const body = this.arg()
        return this.node(index ? el('mroot', [body, index]) : el('msqrt', [body]))
      }
      case 'left': {
        const open = this.delim()
        const body = this.expr((t) => t === '\\right')
        this.expect('\\right')
        const close = this.delim()
        const fence = (c: string) => mo(c, { fence: 'true', stretchy: 'true', symmetric: 'true' })
        return this.node(el('mrow', [...(open ? [fence(open)] : []), ...body, ...(close ? [fence(close)] : [])], undefined, { fence: [open, close] }))
      }
      case 'middle':
        return this.node(mo(this.delim() || '\u200b', { stretchy: 'true', symmetric: 'true' }, { sep: true }))
      case 'operatorname':
      case 'operatornamewithlimits': {
        const limits = this.star() || name === 'operatornamewithlimits'
        const saved = this.font
        this.font = 'normal'
        const body = this.arg()
        this.font = saved
        const text = textOf(body)
        const n = /^[\p{L}\p{N} ]+$/u.test(text) ? tok('mi', text, text.length === 1 ? { mathvariant: 'normal' } : undefined) : body
        n.n = { fn: true, ...(limits ? { op: 'display' } : {}) }
        return this.node(n)
      }
      case 'mathop': {
        const body = this.arg()
        const n = body.t === 'mo' || body.t === 'mi' ? { ...body } : el('mrow', [body])
        n.n = { ...n.n, op: 'display' }
        return this.node(n)
      }
      case 'mathbin':
      case 'mathrel':
      case 'mathord':
      case 'mathpunct':
      case 'mathopen':
      case 'mathclose':
      case 'mathinner':
        return this.arg()
      case 'begin':
        return this.env()
      case 'textcolor': {
        const model = this.rawOpt()
        const c = colorOf(this.raw(), model)
        const body = this.arg()
        return c ? this.node(el('mstyle', [body], { mathcolor: c })) : body
      }
      case 'colorbox':
      case 'fcolorbox': {
        if (name === 'fcolorbox') this.raw()
        this.raw()
        return this.text(this.raw())
      }
      case 'not': {
        const next = this.peek()
        if (next === null || next === '}') return this.node(mo('/'))
        const n = this.atom()
        if (n && (n.t === 'mo' || n.t === 'mi') && n.x) {
          const neg = NEGATED[n.x]
          return this.node({ ...n, t: 'mo', x: neg ?? n.x + '\u0338' })
        }
        return n
      }
      case 'bmod':
      case 'mod':
        return this.node(el('mrow', [space(name === 'mod' ? 0.6667 : 0.2222), tok('mi', 'mod'), space(name === 'mod' ? 0.3333 : 0.2222)]))
      case 'pmod':
      case 'pod': {
        const body = this.arg()
        return this.node(el('mrow', [space(0.6667), mo('('), ...(name === 'pmod' ? [tok('mi', 'mod'), space(0.3333)] : []), body, mo(')')]))
      }
      case 'phantom':
        return this.node(el('mphantom', [this.arg()]))
      case 'hphantom':
        return this.node(el('mpadded', [el('mphantom', [this.arg()])], { height: '0', depth: '0' }))
      case 'vphantom':
        return this.node(el('mpadded', [el('mphantom', [this.arg()])], { width: '0' }))
      case 'smash':
        this.rawOpt()
        return this.node(el('mpadded', [this.arg()], { height: '0', depth: '0' }))
      case 'overset':
      case 'underset':
      case 'stackrel': {
        const saved = this.dstyle
        this.dstyle = false
        const over = this.arg()
        this.dstyle = saved
        const body = this.arg()
        return this.node(el(name === 'underset' ? 'munder' : 'mover', [body, over]))
      }
      case 'xrightarrow':
      case 'xleftarrow':
      case 'xLeftarrow':
      case 'xRightarrow':
      case 'xleftrightarrow':
      case 'xLeftrightarrow':
      case 'xmapsto': {
        this.ws()
        let below: MNode | undefined
        if (this.s[this.i] === '[') {
          this.i++
          below = row(this.expr((t) => t === ']'))
          this.expect(']')
        }
        const above = this.arg()
        const arrow = mo({ xrightarrow: '→', xleftarrow: '←', xLeftarrow: '⇐', xRightarrow: '⇒', xleftrightarrow: '↔', xLeftrightarrow: '⇔', xmapsto: '↦' }[name]!, { stretchy: 'true', minsize: '2em' })
        return this.node(below ? el('munderover', [arrow, below, above]) : el('mover', [arrow, above]))
      }
      case 'substack': {
        this.ws()
        if (this.s[this.i] !== '{') throw new TexError('Missing argument')
        this.i++
        const rows = this.rows((t) => t === '}')
        this.expect('}')
        return this.table(rows, { small: true })
      }
      case 'tag': {
        const star = this.star()
        const v = this.raw()
        this.tag = star ? v : `(${v})`
        return null
      }
      case 'label':
        this.raw()
        return null
      case 'nonumber':
      case 'notag':
      case 'limits':
      case 'nolimits':
      case 'relax':
      case 'strut':
      case 'mathstrut':
        return null
      case 'hspace':
      case 'mspace':
      case 'hskip':
      case 'kern':
      case 'mkern':
      case 'mskip': {
        this.star()
        this.ws()
        let spec: string
        if (this.s[this.i] === '{') spec = this.raw()
        else {
          const m = /^\s*-?\d*\.?\d+\s*[a-z]{2}/.exec(this.s.slice(this.i, this.i + 40))
          if (!m) throw new TexError(`Missing length after \\${name}`)
          spec = m[0]
          this.i += m[0].length
        }
        const em = lengthEm(spec)
        if (em === undefined) throw new TexError(`Not a length: ${spec}`)
        return this.node(space(em))
      }
    }
    const enc = ENCLOSE[name]
    if (enc) return this.node(el('menclose', [this.arg()], { notation: enc }))
    // not known: shown as written, the rest goes on
    this.unknown.push('\\' + name)
    return this.node(el('merror', [mtext('\\' + name)]))
  }

  /** \text{…}: words, with $…$ math inside */
  private text(src: string, variant?: string): MNode {
    const parts: MNode[] = []
    let buf = ''
    const flush = () => {
      if (buf) parts.push(this.node(mtext(buf, variant ? { mathvariant: variant } : undefined)))
      buf = ''
    }
    for (let j = 0; j < src.length; j++) {
      const c = src[j]
      if (c === '\\') {
        const m = /^\\([a-zA-Z]+|.)/s.exec(src.slice(j, j + 40))
        const cmd = m?.[1] ?? ''
        j += cmd.length
        if (ESCAPED[cmd] !== undefined) buf += ESCAPED[cmd]
        else if (cmd === ' ' || cmd === ',' || cmd === ';' || cmd === ':') buf += cmd === ' ' ? ' ' : '\u2009'
        else if (cmd === 'quad' || cmd === 'qquad') buf += cmd === 'quad' ? '\u2003' : '\u2003\u2003'
        else if (cmd === 'textbackslash') buf += '\\'
        else if (cmd === '\\') buf += ' '
        // \textbf{…} and the like inside: their text
      } else if (c === '$') {
        const e = src.indexOf('$', j + 1)
        if (e < 0) throw new TexError('Unclosed $ in \\text')
        flush()
        const inner = new Parser(src.slice(j + 1, e), false)
        inner.depth = this.depth + 1
        if (inner.depth > MAX_DEPTH) throw new TexError('Nested too deeply')
        parts.push(inner.top())
        this.made += inner.made
        j = e
      } else if (c === '~') buf += '\u00a0'
      else if (c !== '{' && c !== '}') buf += c
    }
    flush()
    return parts.length === 1 ? parts[0] : this.node(el('mrow', parts))
  }

  private env(): MNode {
    const name = this.raw().trim()
    const env = ENV[name]
    if (!env) throw new TexError(`Unknown environment ${name}`)
    let spec: string[] | undefined
    if (env.spec) {
      spec = []
      const src = this.raw().replace(/@\{[^}]*\}|\*\{[^}]*\}\{[^}]*\}|[|:]/g, '')
      for (const c of src.replace(/[pmb]\{[^}]*\}/g, 'l')) if (c === 'l' || c === 'c' || c === 'r') spec.push(c === 'l' ? 'left' : c === 'r' ? 'right' : 'center')
    } else if (env.count) this.raw()
    else if (name.endsWith('matrix*')) this.rawOpt()
    const saved = this.dstyle
    this.dstyle = !!env.display
    const rows = this.rows((t) => t === '\\end')
    this.dstyle = saved
    this.expect('\\end')
    const end = this.raw().trim()
    if (end !== name) throw new TexError(`\\begin{${name}} ended by \\end{${end}}`)
    const t = this.table(rows, env, spec)
    if (!env.open && !env.close) return t
    const fence = (c: string) => mo(c, { fence: 'true', stretchy: 'true', symmetric: 'true' })
    return this.node(el('mrow', [...(env.open ? [fence(env.open)] : []), t, ...(env.close ? [fence(env.close)] : [])], undefined, { fence: [env.open ?? '', env.close ?? ''] }))
  }
}

/** the text of a node's tokens */
export function textOf(n: MNode): string {
  return n.x ?? (n.k ?? []).map(textOf).join('')
}

export interface TexMathml {
  /** the `math` element */
  node: MNode
  /** why the formula is not drawn (the source is shown), or the commands not known (shown as written) */
  error?: string
}

/**
 * MathML of a TeX formula: a `math` element (block for display math) whose `semantics` holds the drawing and the TeX as
 * an `application/x-tex` annotation. Never throws.
 */
export function texToMathml(tex: string, display: boolean): TexMathml {
  const ann = tok('annotation', tex, { encoding: 'application/x-tex' })
  const wrap = (body: MNode) => el('math', [el('semantics', [body, ann])], display ? { display: 'block' } : undefined)
  const fail = (why: string): TexMathml => ({ node: wrap(el('merror', [tok('mtext', tex.trim() || ' ')])), error: why })
  if (tex.length > MAX_TEX) return fail(`Longer than ${MAX_TEX.toLocaleString('en-US')} characters`)
  try {
    const p = new Parser(tex, display)
    const body = p.top()
    return { node: wrap(body), ...(p.unknown.length ? { error: `Not supported: ${[...new Set(p.unknown)].join(', ')}` } : {}) }
  } catch (e) {
    // a TexError, or anything else (a stack overflow): the source, whole
    return fail(e instanceof TexError ? e.message : 'Cannot be read')
  }
}

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;')

/** a MathML tree as markup; `ns`: the root says its namespace (a standalone page, the clipboard) */
export function mathmlString(n: MNode, ns = false): string {
  let a = ns && n.t === 'math' ? ' xmlns="http://www.w3.org/1998/Math/MathML"' : ''
  for (const [k, v] of Object.entries(n.a ?? {})) a += ` ${k}="${escAttr(v)}"`
  if (n.x !== undefined) return `<${n.t}${a}>${escText(n.x)}</${n.t}>`
  if (n.t === 'mspace' || n.t === 'none') return `<${n.t}${a}/>`
  return `<${n.t}${a}>${(n.k ?? []).map((k) => mathmlString(k)).join('')}</${n.t}>`
}

/** the MathML markup of a TeX formula (see texToMathml) */
export const texMathml = (tex: string, display: boolean, ns = true) => mathmlString(texToMathml(tex, display).node, ns)
