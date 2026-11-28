/**
 * Syntax colors for source code: one tokenizer for the source pane, the whole-file code view, the code blocks of
 * Markdown documents and @p10node/markdown. A text is read line by line, carrying to the next line only what spans
 * lines (a block comment, a multi-line string, a template literal, a JSX element, a Markdown code block, a script in a
 * web page), as a short state string. DOM-free.
 *
 * Bounded: every scanner moves forward on each step and looks no further than the end of its line, so the work is
 * linear in the text; a text over `HIGHLIGHT_MAX` characters, or a line over `LINE_MAX`, is plain.
 */
import { dict } from './dict'

/**
 * [class, text]; class '' is plain text. Classes: c comment, k keyword, s string, n number / constant, o operator,
 * a attribute / property / variable, t tag, m meta (decorator, directive, annotation), f function, y type,
 * h heading, b bold, i italic. The texts of a line's tokens put together are the line.
 */
export type Token = [string, string]

/** a longer text is plain */
export const HIGHLIGHT_MAX = 300_000
/** a longer line (minified code) is plain; what spans lines is carried over it as it was */
const LINE_MAX = 10_000
/** template literals / JSX elements / comments inside one another, at most */
const DEPTH_MAX = 32

/** the tokens of one line, from the state at its start ('' : nothing open); returns the state at its end */
type Lexer = (line: string, st: string, out: Token[]) => string

/** frame separators of the states: code frames, a web page's script / style, a Markdown code block */
const S1 = '\u0001'
const S2 = '\u0002'
const S3 = '\u0003'

function put(out: Token[], c: string, t: string) {
  if (!t) return
  const last = out[out.length - 1]
  if (last && last[0] === c) last[1] += t
  else out.push([c, t])
}

const cc = (s: string, i: number) => s.charCodeAt(i)
const isDigit = (c: number) => c >= 48 && c <= 57
const isHex = (c: number) => isDigit(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)
const isAlpha = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || (c > 127 && c !== 0xa0)
const isWord = (c: number) => isAlpha(c) || isDigit(c)
const isSpace = (c: number) => c === 32 || c === 9 || c === 11 || c === 12 || c === 0xa0
const isUpper = (c: number) => c >= 65 && c <= 90
const words = (s: string) => new Set(s.split(' '))

function wordEnd(s: string, i: number, dollar = false): number {
  let j = i
  while (j < s.length && (isWord(cc(s, j)) || (dollar && cc(s, j) === 36))) j++
  return j
}

function spaceEnd(s: string, i: number): number {
  let j = i
  while (j < s.length && isSpace(cc(s, j))) j++
  return j
}

/** the end of a number literal starting at `i` (a digit, or "." and a digit): 0x / 0b / 0o, _ separators, exponent, suffix */
function numberEnd(s: string, i: number): number {
  const n = s.length
  let j = i
  if (cc(s, j) === 48 && 'xXbBoO'.includes(s[j + 1] || ' ') && isHex(cc(s, j + 2))) {
    j += 2
    while (j < n && (isHex(cc(s, j)) || s[j] === '_')) j++
  } else {
    while (j < n && (isDigit(cc(s, j)) || s[j] === '_')) j++
    if (s[j] === '.' && isDigit(cc(s, j + 1))) {
      j++
      while (j < n && (isDigit(cc(s, j)) || s[j] === '_')) j++
    }
    if ((s[j] === 'e' || s[j] === 'E') && (isDigit(cc(s, j + 1)) || ((s[j + 1] === '+' || s[j + 1] === '-') && isDigit(cc(s, j + 2))))) {
      j += 2
      while (j < n && isDigit(cc(s, j))) j++
    }
  }
  // suffixes: 10n, 1L, 2u, 1.5f, 8i32, 3j
  while (j < n && isWord(cc(s, j))) j++
  return j
}

/** past the closing quote of a string whose text starts at `i`; -1 when the line ends first */
function quoteEnd(s: string, i: number, q: string, esc = true, doubled = false): number {
  for (let j = i; j < s.length; j++) {
    const c = s[j]
    if (esc && c === '\\') j++
    else if (c === q) {
      if (doubled && s[j + 1] === q) j++
      else return j + 1
    }
  }
  return -1
}

/** whether a "(" follows (spaces between): the name before it is called or defined */
function callAt(s: string, j: number): boolean {
  return s[spaceEnd(s, j)] === '('
}

/** a name in capitals (two characters or more): a constant */
function allCaps(w: string): boolean {
  if (w.length < 2) return false
  let letter = false
  for (let k = 0; k < w.length; k++) {
    const c = cc(w, k)
    if (c >= 97 && c <= 122) return false
    if (isUpper(c)) letter = true
  }
  return letter
}

// ---------------------------------------------------------------- C-like languages (JS / TS, Python, Go, Rust, Java, C, C++, C#, SQL)

interface CLike {
  kw: Set<string>
  consts?: Set<string>
  types?: Set<string>
  /** line comment openers */
  line?: string[]
  /** slash-star block comments; nested (Rust) */
  block?: boolean
  nested?: boolean
  /** quotes of strings */
  quotes: string
  /** quotes whose strings go on past the end of the line */
  multi?: string
  /** quotes that open triple-quoted strings */
  triple?: string
  /** a quote doubled escapes it, a backslash does not (SQL) */
  doubled?: boolean
  /** quotes of names, not strings (SQL "col", `col`) */
  names?: string
  /** template literals, regular expression literals, JSX, $ in names (JavaScript) */
  tmpl?: boolean
  regex?: boolean
  jsx?: boolean
  dollar?: boolean
  /** raw / verbatim strings: Go `…`, Rust r#"…"#, C++ R"x(…)x", C# @"…" */
  raw?: 'go' | 'rust' | 'cpp' | 'cs'
  /** names written right before a quote that are part of the string (Python r"", f"") */
  prefixes?: RegExp
  /** @decorators / @annotations: at the start of a line only, or anywhere */
  deco?: 'line' | 'any'
  /** Rust #[attributes] */
  attrs?: boolean
  /** # directives (C, C++, C#) */
  pre?: boolean
  /** Rust 'lifetimes */
  lifetimes?: boolean
  /** Rust name! macros */
  macros?: boolean
  /** Capitalized names are types */
  caps?: boolean
  /** NAMES_IN_CAPITALS are constants (default true) */
  constCaps?: boolean
  /** keywords in any case (SQL) */
  ci?: boolean
  /** characters that open variables (SQL @name, $1) */
  vars?: string
  /** the name after these is a function / a type */
  fnKw?: Set<string>
  typeKw?: Set<string>
}

function clike(L: CLike): Lexer {
  return (line, st, out) => {
    const stack = st ? st.split(S1) : []
    const n = line.length
    const push = (f: string) => stack.length < DEPTH_MAX && stack.push(f) > 0
    const setTop = (f: string) => (stack[stack.length - 1] = f)
    let i = 0
    /** the last token was a value: "/" divides and "<" compares (else they open a regular expression / a JSX element) */
    let value = false
    /** a regular expression not closed on this line: no other is looked for on it */
    let regexOk = !!L.regex
    /** the class of the next name ("function f", "class C") */
    let pending = ''
    /** the last token was ".": a member name follows (not a keyword) */
    let dot = false
    /** nothing but spaces so far */
    let lead = true
    // a directive: #include <x>, #define, #region
    if (L.pre && !stack.length) {
      const m = /^([ \t]*)(#[ \t]*[A-Za-z]+)/.exec(line)
      if (m) {
        put(out, '', m[1])
        put(out, 'm', m[2])
        i = m[0].length
        const inc = /^([ \t]*)(<[^<>]*>)/.exec(line.slice(i, i + 300))
        if (inc && /include|import/.test(m[2])) {
          put(out, '', inc[1])
          put(out, 's', inc[2])
          i += inc[0].length
        }
      }
    }
    while (i < n) {
      const top = stack.length ? stack[stack.length - 1] : ''
      const k = top[0]
      const ch = line[i]
      const c = cc(line, i)
      // ---------------- what spans lines
      if (k === 'C') {
        if (!L.nested) {
          const e = line.indexOf('*/', i)
          if (e < 0) {
            put(out, 'c', line.slice(i))
            break
          }
          put(out, 'c', line.slice(i, e + 2))
          stack.pop()
          i = e + 2
          continue
        }
        let d = Number(top.slice(1)) || 1
        let j = i
        for (; j < n; j++) {
          if (line[j] === '/' && line[j + 1] === '*') d = Math.min(d + 1, 999), j++
          else if (line[j] === '*' && line[j + 1] === '/') {
            d--
            j++
            if (!d) break
          }
        }
        if (!d) {
          put(out, 'c', line.slice(i, j + 1))
          stack.pop()
          i = j + 1
          continue
        }
        put(out, 'c', line.slice(i))
        setTop('C' + d)
        break
      }
      if (k === 'S') {
        const q = top[1]
        const e = quoteEnd(line, i, q, !L.doubled, !!L.doubled)
        const cls = L.names?.includes(q) ? 'a' : 's'
        if (e < 0) {
          put(out, cls, line.slice(i))
          break
        }
        put(out, cls, line.slice(i, e))
        stack.pop()
        i = e
        value = true
        continue
      }
      if (k === 'T') {
        const q3 = top[1].repeat(3)
        let j = i
        while (j < n && !line.startsWith(q3, j)) j += line[j] === '\\' ? 2 : 1
        if (j >= n) {
          put(out, 's', line.slice(i))
          break
        }
        put(out, 's', line.slice(i, j + 3))
        stack.pop()
        i = j + 3
        value = true
        continue
      }
      if (k === 'B' || k === 'R' || k === 'Q') {
        // Go `raw`, Rust r##"raw"##, C++ R"x(raw)x"
        const close = k === 'B' ? '`' : k === 'R' ? '"' + '#'.repeat(Number(top.slice(1)) || 0) : ')' + top.slice(1) + '"'
        const e = line.indexOf(close, i)
        if (e < 0) {
          put(out, 's', line.slice(i))
          break
        }
        put(out, 's', line.slice(i, e + close.length))
        stack.pop()
        i = e + close.length
        value = true
        continue
      }
      if (k === 'V') {
        // C# @"verbatim": "" is a quote
        let j = i
        while (j < n && !(line[j] === '"' && line[j + 1] !== '"')) j += line[j] === '"' ? 2 : 1
        if (j >= n) {
          put(out, 's', line.slice(i))
          break
        }
        put(out, 's', line.slice(i, j + 1))
        stack.pop()
        i = j + 1
        value = true
        continue
      }
      if (k === 't') {
        // template literal text, up to its end or a ${ expression
        let j = i
        while (j < n && line[j] !== '`' && !(line[j] === '$' && line[j + 1] === '{')) j += line[j] === '\\' ? 2 : 1
        if (j >= n) {
          put(out, 's', line.slice(i))
          break
        }
        if (line[j] === '`') {
          put(out, 's', line.slice(i, j + 1))
          stack.pop()
          i = j + 1
          value = true
          continue
        }
        put(out, 's', line.slice(i, j))
        put(out, push('e0') ? 'o' : 's', '${')
        i = j + 2
        value = false
        continue
      }
      if (k === 'x') {
        // JSX children: text, {expressions}, elements
        let j = i
        while (j < n && line[j] !== '<' && line[j] !== '{') j++
        put(out, '', line.slice(i, j))
        i = j
        if (i >= n) break
        if (line[i] === '{') {
          put(out, '', '{')
          push('j0')
          i++
          value = false
        } else if (line[i + 1] === '/') {
          put(out, 't', '</')
          if (!push('g1')) stack.pop()
          i += 2
        } else {
          put(out, 't', '<')
          push('g0')
          i++
        }
        continue
      }
      if (k === 'g') {
        // a JSX tag: its name, then attributes
        const closing = top[1] === '1'
        const named = top.length > 2
        if (isSpace(c)) {
          const j = spaceEnd(line, i)
          put(out, '', line.slice(i, j))
          i = j
          continue
        }
        if (ch === '/' && line[i + 1] === '>') {
          put(out, 't', '/>')
          stack.pop()
          i += 2
          value = true
          continue
        }
        if (ch === '>') {
          put(out, 't', '>')
          stack.pop()
          i++
          if (closing) {
            if (stack[stack.length - 1] === 'x') stack.pop()
          } else if (line[spaceEnd(line, i)] !== '(') push('x')
          // (a generic's "<T>(": not an element)
          value = true
          continue
        }
        if (ch === '{') {
          put(out, '', '{')
          push('j0')
          i++
          continue
        }
        if (ch === '"' || ch === "'") {
          const e = quoteEnd(line, i + 1, ch, false)
          put(out, 's', line.slice(i, e < 0 ? n : e))
          i = e < 0 ? n : e
          continue
        }
        if (isAlpha(c) || c === 36) {
          let j = i
          while (j < n && (isWord(cc(line, j)) || '$-:.'.includes(line[j]))) j++
          put(out, named ? 'a' : 't', line.slice(i, j))
          if (!named) setTop(top + 'n')
          i = j
          continue
        }
        if (ch === '=') {
          put(out, '', ch)
          i++
          continue
        }
        // "<T," "<a;": a comparison or a generic, not an element
        stack.pop()
        continue
      }
      // ---------------- code
      if (isSpace(c)) {
        const j = spaceEnd(line, i)
        put(out, '', line.slice(i, j))
        i = j
        continue
      }
      const wasLead = lead
      lead = false
      if (L.line && lineComment(L.line, line, i)) {
        put(out, 'c', line.slice(i))
        break
      }
      if (L.block && ch === '/' && line[i + 1] === '*' && push('C1')) {
        put(out, 'c', '/*')
        i += 2
        continue
      }
      if (L.tmpl && ch === '`' && push('t')) {
        put(out, 's', '`')
        i++
        continue
      }
      if (L.raw === 'go' && ch === '`') {
        put(out, 's', '`')
        push('B')
        i++
        continue
      }
      if (L.triple?.includes(ch) && line.startsWith(ch + ch + ch, i) && push('T' + ch)) {
        put(out, 's', ch + ch + ch)
        i += 3
        continue
      }
      if (L.raw === 'cs' && (ch === '@' || ch === '$')) {
        const m = /^(?:@\$?|\$@?)"/.exec(line.slice(i, i + 3))
        if (m) {
          put(out, 's', m[0])
          i += m[0].length
          if (m[0].includes('@')) push('V')
          else {
            const e = quoteEnd(line, i, '"')
            put(out, 's', line.slice(i, e < 0 ? n : e))
            i = e < 0 ? n : e
          }
          value = true
          continue
        }
      }
      if (L.lifetimes && ch === "'" && isAlpha(cc(line, i + 1)) && line[i + 2] !== "'") {
        const j = wordEnd(line, i + 1)
        put(out, 'k', line.slice(i, j))
        i = j
        continue
      }
      if (L.quotes.includes(ch)) {
        const e = quoteEnd(line, i + 1, ch, !L.doubled, !!L.doubled)
        const cls = L.names?.includes(ch) ? 'a' : 's'
        value = true
        if (e >= 0) {
          put(out, cls, line.slice(i, e))
          i = e
          continue
        }
        put(out, cls, line.slice(i))
        if (L.multi?.includes(ch)) push('S' + ch)
        break
      }
      if (L.regex && ch === '/' && !value && regexOk) {
        let j = i + 1
        let set = false
        for (; j < n; j++) {
          const d = line[j]
          if (d === '\\') j++
          else if (d === '[') set = true
          else if (d === ']') set = false
          else if (d === '/' && !set) break
        }
        if (j < n) {
          j++
          while (j < n && isAlpha(cc(line, j))) j++
          put(out, 's', line.slice(i, j))
          i = j
          value = true
          continue
        }
        regexOk = false
      }
      if (L.jsx && ch === '<' && !value && (isAlpha(cc(line, i + 1)) || line[i + 1] === '>') && push('g0')) {
        put(out, 't', '<')
        i++
        continue
      }
      if (L.deco && ch === '@' && isAlpha(cc(line, i + 1)) && (L.deco === 'any' || wasLead)) {
        let j = wordEnd(line, i + 1)
        while (line[j] === '.' && isAlpha(cc(line, j + 1))) j = wordEnd(line, j + 1)
        put(out, 'm', line.slice(i, j))
        i = j
        continue
      }
      if (L.attrs && ch === '#' && (line[i + 1] === '[' || (line[i + 1] === '!' && line[i + 2] === '['))) {
        let j = line.indexOf('[', i)
        let d = 0
        for (; j < n; j++) {
          if (line[j] === '[') d++
          else if (line[j] === ']' && !--d) break
        }
        put(out, 'm', line.slice(i, Math.min(n, j + 1)))
        i = Math.min(n, j + 1)
        continue
      }
      if (L.vars?.includes(ch) && isWord(cc(line, i + 1))) {
        const j = wordEnd(line, i + 1)
        put(out, 'a', line.slice(i, j))
        i = j
        value = true
        continue
      }
      if (isDigit(c) || (ch === '.' && isDigit(cc(line, i + 1)))) {
        const j = numberEnd(line, i)
        put(out, 'n', line.slice(i, j))
        i = j
        value = true
        dot = false
        pending = ''
        continue
      }
      if (isAlpha(c) || (L.dollar && c === 36)) {
        const j = wordEnd(line, i, L.dollar)
        const w = line.slice(i, j)
        const q = line[j]
        // a string with a prefix: Python r"…" f'…', Rust b"…" r#"…"#, C++ R"x(…)x" u8"…"
        if (q === '"' || q === "'" || (L.raw === 'rust' && q === '#')) {
          const end = prefixed(L, line, i, j, w, stack, out)
          if (end >= 0) {
            i = end
            value = true
            continue
          }
        }
        const key = L.ci ? w.toLowerCase() : w
        let cls = ''
        if (!dot && L.kw.has(key)) cls = 'k'
        else if (!dot && L.consts?.has(key)) cls = 'n'
        else if (pending) cls = pending
        else if (!dot && L.types?.has(key)) cls = 'y'
        else if (L.macros && q === '!' && line[j + 1] !== '=') cls = 'f'
        else if (callAt(line, j)) cls = 'f'
        else if (L.constCaps !== false && allCaps(w)) cls = 'n'
        else if (L.caps && isUpper(c)) cls = 'y'
        put(out, cls, w)
        pending = cls === 'k' ? (L.fnKw?.has(key) ? 'f' : L.typeKw?.has(key) ? 'y' : '') : ''
        value = cls !== 'k' || w === 'this' || w === 'super' || w === 'self'
        dot = false
        i = j
        continue
      }
      // punctuation; the braces of ${…} and JSX {…}
      if ((k === 'e' || k === 'j') && (ch === '{' || ch === '}')) {
        const d = Number(top.slice(1)) || 0
        if (ch === '{') setTop(k + (d + 1))
        else if (d > 0) setTop(k + (d - 1))
        else {
          stack.pop()
          put(out, k === 'e' ? 'o' : '', '}')
          i++
          value = true
          continue
        }
      }
      put(out, '', ch)
      i++
      value = ch === ')' || ch === ']'
      dot = ch === '.'
      pending = ''
    }
    return stack.join(S1)
  }
}

function lineComment(openers: string[], line: string, i: number): boolean {
  for (const m of openers) if (line.charCodeAt(i) === m.charCodeAt(0) && line.startsWith(m, i)) return true
  return false
}

/** a string written with a prefix name (`w`, from `i` to `j`); returns where it ends, or -1 when it is not one */
function prefixed(L: CLike, line: string, i: number, j: number, w: string, stack: string[], out: Token[]): number {
  const n = line.length
  const q = line[j]
  if (L.raw === 'rust' && (w === 'r' || w === 'br')) {
    let h = j
    while (line[h] === '#') h++
    if (line[h] !== '"') return -1
    const close = '"' + '#'.repeat(h - j)
    const e = line.indexOf(close, h + 1)
    if (e >= 0) {
      put(out, 's', line.slice(i, e + close.length))
      return e + close.length
    }
    put(out, 's', line.slice(i))
    if (stack.length < DEPTH_MAX) stack.push('R' + (h - j))
    return n
  }
  if (L.raw === 'cpp' && q === '"' && /^(?:u8|[uUL])?R$/.test(w)) {
    // R"delim( : a delimiter of 16 characters at most
    let open = j + 1
    while (open < n && open <= j + 17 && line[open] !== '(') open++
    if (line[open] !== '(') return -1
    const delim = line.slice(j + 1, open)
    if (/[\s\\)]/.test(delim)) return -1
    const close = ')' + delim + '"'
    const e = line.indexOf(close, open + 1)
    if (e >= 0) {
      put(out, 's', line.slice(i, e + close.length))
      return e + close.length
    }
    put(out, 's', line.slice(i))
    if (stack.length < DEPTH_MAX) stack.push('Q' + delim)
    return n
  }
  const ok = L.prefixes ? L.prefixes.test(w) : (L.raw === 'rust' && w === 'b') || (L.raw === 'cpp' && /^(?:u8|[uUL])$/.test(w))
  if (!ok || q === '#') return -1
  if (L.triple?.includes(q) && line.startsWith(q + q + q, j)) {
    put(out, 's', line.slice(i, j + 3))
    if (stack.length < DEPTH_MAX) stack.push('T' + q)
    return j + 3
  }
  // raw strings keep their backslashes, but a backslash still escapes the quote (Python)
  const e = quoteEnd(line, j + 1, q)
  if (e >= 0) {
    put(out, 's', line.slice(i, e))
    return e
  }
  put(out, 's', line.slice(i))
  if (L.multi?.includes(q) && stack.length < DEPTH_MAX) stack.push('S' + q)
  return n
}

const JS_KW = 'break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield async await of static get set from as'
const JS_CONST = words('true false null undefined NaN Infinity')
const FN_JS = words('function')
const TYPE_JS = words('class interface type enum extends implements namespace')

const javascript = clike({
  kw: words(JS_KW), consts: JS_CONST, line: ['//'], block: true, quotes: `"'`, tmpl: true, regex: true, jsx: true, dollar: true, deco: 'any', caps: true, fnKw: FN_JS, typeKw: TYPE_JS,
})
const TS = {
  kw: words(JS_KW + ' type interface enum namespace module declare abstract implements readonly private protected public override keyof infer is asserts satisfies unique global'),
  consts: JS_CONST, types: words('string number boolean any unknown never object symbol bigint'), line: ['//'], block: true, quotes: `"'`, tmpl: true, regex: true, dollar: true, deco: 'any' as const, caps: true, fnKw: FN_JS, typeKw: TYPE_JS,
}
const typescript = clike(TS)
const tsx = clike({ ...TS, jsx: true })

const python = clike({
  kw: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'),
  consts: words('True False None NotImplemented Ellipsis __debug__'),
  types: words('int float complex str bytes bytearray bool list dict set frozenset tuple object type range memoryview'),
  line: ['#'], quotes: `"'`, triple: `"'`, prefixes: /^(?:[rbuf]|rb|br|fr|rf)$/i, deco: 'line', caps: true, fnKw: words('def'), typeKw: words('class'),
})

const go = clike({
  kw: words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'),
  consts: words('true false nil iota'),
  types: words('bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any comparable'),
  line: ['//'], block: true, quotes: `"'`, raw: 'go', fnKw: words('func'), typeKw: words('type'),
})

const rust = clike({
  kw: words('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self static struct super trait type union unsafe use where while yield'),
  consts: words('true false'),
  types: words('bool char str i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 Self'),
  line: ['//'], block: true, nested: true, quotes: `"'`, multi: '"', raw: 'rust', attrs: true, lifetimes: true, macros: true, caps: true,
  fnKw: words('fn'), typeKw: words('struct enum trait type union'),
})

const java = clike({
  kw: words('abstract assert break case catch class continue default do else enum extends final finally for if implements import instanceof interface native new package permits private protected public record return sealed static strictfp super switch synchronized this throw throws transient try var volatile while yield'),
  consts: words('true false null'),
  types: words('boolean byte char double float int long short void'),
  line: ['//'], block: true, quotes: `"'`, triple: '"', deco: 'any', caps: true, typeKw: words('class interface enum record'),
})

const C_KW = 'auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while _Alignas _Alignof _Atomic _Generic _Noreturn _Static_assert _Thread_local'
const C_TYPES = 'char double float int long short signed unsigned void bool _Bool size_t ssize_t ptrdiff_t intptr_t uintptr_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t wchar_t FILE'
const c = clike({
  kw: words(C_KW), consts: words('NULL true false'), types: words(C_TYPES), line: ['//'], block: true, quotes: `"'`, raw: 'cpp', pre: true, typeKw: words('struct union enum'),
})
const cpp = clike({
  kw: words(
    C_KW +
      ' alignas alignof and and_eq asm bitand bitor catch class compl concept consteval constexpr constinit const_cast co_await co_return co_yield decltype delete dynamic_cast explicit export friend mutable namespace new noexcept not not_eq operator or or_eq private protected public reinterpret_cast requires static_assert static_cast template this thread_local throw try typeid typename using virtual xor xor_eq override final',
  ),
  consts: words('NULL true false nullptr'), types: words(C_TYPES + ' char8_t char16_t char32_t'), line: ['//'], block: true, quotes: `"'`, raw: 'cpp', pre: true, caps: true,
  typeKw: words('class struct union enum namespace'),
})
const csharp = clike({
  kw: words(
    'abstract as base break case catch checked class const continue default delegate do else enum event explicit extern finally fixed for foreach goto if implicit in interface internal is lock namespace new operator out override params private protected public readonly ref return sealed sizeof stackalloc static struct switch this throw try typeof unchecked unsafe using virtual volatile while async await var dynamic get set init record required yield when where partial global nameof with',
  ),
  consts: words('true false null'),
  types: words('bool byte char decimal double float int long object sbyte short string uint ulong ushort void nint nuint'),
  line: ['//'], block: true, quotes: `"'`, triple: '"', raw: 'cs', pre: true, caps: true, typeKw: words('class struct interface enum record namespace'),
})

const sql = clike({
  kw: words(
    'select from where and or not insert into values update set delete create alter drop table view index trigger procedure function database schema if exists primary key foreign references unique check default constraint join inner left right full outer cross on using group by order asc desc having limit offset union intersect except all distinct as case when then else end is like ilike in between returning with recursive begin commit rollback transaction grant revoke truncate replace declare cursor fetch over partition window rows range current row lateral natural top merge matched cascade restrict add column rename to temporary temp materialized do return returns language',
  ),
  consts: words('true false null'),
  types: words('int integer smallint bigint tinyint serial bigserial decimal numeric real float double precision char varchar nvarchar nchar text clob blob bytea boolean bool date time timestamp timestamptz interval json jsonb uuid xml money bit varbinary binary'),
  line: ['--'], block: true, quotes: `'"\``, multi: `'`, names: '"`', doubled: true, ci: true, vars: '@$', constCaps: false,
})

// ---------------------------------------------------------------- JSON

const json: Lexer = (line, st, out) => {
  const n = line.length
  let i = 0
  if (st === 'C') {
    const e = line.indexOf('*/')
    if (e < 0) {
      put(out, 'c', line)
      return 'C'
    }
    put(out, 'c', line.slice(0, e + 2))
    i = e + 2
  }
  while (i < n) {
    const ch = line[i]
    const c = cc(line, i)
    if (ch === '"' || ch === "'") {
      let e = quoteEnd(line, i + 1, ch)
      if (e < 0) e = n
      // a key, when a colon follows
      put(out, line[spaceEnd(line, e)] === ':' ? 'a' : 's', line.slice(i, e))
      i = e
      continue
    }
    if (ch === '/' && line[i + 1] === '/') {
      put(out, 'c', line.slice(i))
      break
    }
    if (ch === '/' && line[i + 1] === '*') {
      const e = line.indexOf('*/', i + 2)
      if (e < 0) {
        put(out, 'c', line.slice(i))
        return 'C'
      }
      put(out, 'c', line.slice(i, e + 2))
      i = e + 2
      continue
    }
    const sign = (ch === '-' || ch === '+') && (isDigit(cc(line, i + 1)) || line[i + 1] === '.')
    if (isDigit(c) || sign || (ch === '.' && isDigit(cc(line, i + 1)))) {
      const j = numberEnd(line, sign ? i + 1 : i)
      put(out, 'n', line.slice(i, j))
      i = j
      continue
    }
    if (isAlpha(c) || c === 36) {
      const j = wordEnd(line, i, true)
      const w = line.slice(i, j)
      put(out, /^(?:true|false|null|NaN|Infinity)$/.test(w) ? 'n' : line[spaceEnd(line, j)] === ':' ? 'a' : '', w)
      i = j
      continue
    }
    put(out, '', ch)
    i++
  }
  return ''
}

// ---------------------------------------------------------------- CSS, SCSS / Less

function css(scss: boolean): Lexer {
  return (line, st, out) => {
    const n = line.length
    let depth = parseInt(st, 10) || 0
    let inC = st.includes('C')
    /** in a value (after "prop:"), or the prelude of an @rule */
    let val = st.includes('V')
    let at = false
    /** the end of a nested rule's selector found ahead (a "{" before any ";") */
    let selEnd = -1
    let i = 0
    while (i < n) {
      const ch = line[i]
      const c = cc(line, i)
      if (inC) {
        const e = line.indexOf('*/', i)
        if (e < 0) {
          put(out, 'c', line.slice(i))
          break
        }
        put(out, 'c', line.slice(i, e + 2))
        i = e + 2
        inC = false
        continue
      }
      if (ch === '/' && line[i + 1] === '*') {
        put(out, 'c', '/*')
        inC = true
        i += 2
        continue
      }
      if (scss && ch === '/' && line[i + 1] === '/' && line[i - 1] !== ':') {
        put(out, 'c', line.slice(i))
        break
      }
      if (isSpace(c)) {
        const j = spaceEnd(line, i)
        put(out, '', line.slice(i, j))
        i = j
        continue
      }
      if (ch === '"' || ch === "'") {
        const e = quoteEnd(line, i + 1, ch)
        put(out, 's', line.slice(i, e < 0 ? n : e))
        i = e < 0 ? n : e
        continue
      }
      if (ch === '{' || ch === '}' || ch === ';') {
        if (ch === '{') depth = Math.min(depth + 1, 99)
        else if (ch === '}') depth = Math.max(0, depth - 1)
        val = at = false
        selEnd = -1
        put(out, '', ch)
        i++
        continue
      }
      if (ch === '@' && isAlpha(cc(line, i + 1))) {
        let j = i + 1
        while (j < n && (isWord(cc(line, j)) || line[j] === '-')) j++
        put(out, 'k', line.slice(i, j))
        // Less variables (@x: 1) take a value
        if (line[spaceEnd(line, j)] === ':') val = true
        else at = true
        i = j
        continue
      }
      if (ch === '$' && scss && isAlpha(cc(line, i + 1))) {
        let j = i + 1
        while (j < n && (isWord(cc(line, j)) || line[j] === '-')) j++
        put(out, 'a', line.slice(i, j))
        if (line[spaceEnd(line, j)] === ':') val = true
        i = j
        continue
      }
      const ident = isAlpha(c) || (ch === '-' && (isAlpha(cc(line, i + 1)) || line[i + 1] === '-'))
      if (val || at) {
        const sign = (ch === '-' || ch === '+') && (isDigit(cc(line, i + 1)) || (line[i + 1] === '.' && isDigit(cc(line, i + 2))))
        if ((isDigit(c) || sign || (ch === '.' && isDigit(cc(line, i + 1)))) && !isWord(cc(line, i - 1))) {
          let j = i + 1
          while (j < n && (isDigit(cc(line, j)) || line[j] === '.')) j++
          while (j < n && (isAlpha(cc(line, j)) || line[j] === '%')) j++
          put(out, 'n', line.slice(i, j))
          i = j
          continue
        }
        if (ch === '#' && isHex(cc(line, i + 1))) {
          const j = wordEnd(line, i + 1)
          put(out, 'n', line.slice(i, j))
          i = j
          continue
        }
        if (ch === '!' && isAlpha(cc(line, i + 1))) {
          const j = wordEnd(line, i + 1)
          put(out, 'k', line.slice(i, j))
          i = j
          continue
        }
        if (ident) {
          let j = i
          while (j < n && (isWord(cc(line, j)) || line[j] === '-')) j++
          const w = line.slice(i, j)
          put(out, line[j] === '(' ? 'f' : w.startsWith('--') || (at && line[spaceEnd(line, j)] === ':') ? 'a' : '', w)
          i = j
          continue
        }
        put(out, '', ch)
        i++
        continue
      }
      // in a rule: a property, unless a "{" comes before the next ";" or "}" (a nested rule: a:hover { … })
      if (depth > 0 && i > selEnd && ident) {
        let j = i
        while (j < n && (isWord(cc(line, j)) || line[j] === '-')) j++
        const colon = spaceEnd(line, j)
        if (line[colon] === ':') {
          let e = colon
          while (e < n && line[e] !== ';' && line[e] !== '{' && line[e] !== '}') e++
          if (line[e] !== '{') {
            put(out, 'a', line.slice(i, j))
            put(out, '', line.slice(j, colon + 1))
            i = colon + 1
            val = true
            continue
          }
          selEnd = e
        }
      }
      // selectors
      if ((ch === '.' || ch === '#') && (isAlpha(cc(line, i + 1)) || line[i + 1] === '-')) {
        let j = i + 1
        while (j < n && (isWord(cc(line, j)) || line[j] === '-')) j++
        put(out, 'a', line.slice(i, j))
        i = j
        continue
      }
      if (ch === ':' && (isAlpha(cc(line, i + 1)) || line[i + 1] === ':' || line[i + 1] === '-')) {
        let j = i + 1
        if (line[j] === ':') j++
        while (j < n && (isWord(cc(line, j)) || line[j] === '-')) j++
        put(out, 'k', line.slice(i, j))
        i = j
        continue
      }
      if (ch === '[') {
        const e = line.indexOf(']', i)
        put(out, 'a', line.slice(i, e < 0 ? n : e + 1))
        i = e < 0 ? n : e + 1
        continue
      }
      if (ident || ch === '&' || ch === '*') {
        let j = i + 1
        while (j < n && (isWord(cc(line, j)) || line[j] === '-')) j++
        put(out, ch === '&' ? 'k' : 't', line.slice(i, j))
        i = j
        continue
      }
      put(out, '', ch)
      i++
    }
    return `${depth || ''}${inC ? 'C' : ''}${val ? 'V' : ''}`
  }
}

// ---------------------------------------------------------------- HTML, XML (and SVG)

const END_SCRIPT = /<\/script\b/gi
const END_STYLE = /<\/style\b/gi
const ENTITY = /&(?:#\d{1,7}|#x[0-9a-fA-F]{1,6}|\w{1,32});/y

/** the tokens of web page / XML text; `<script>` and `<style>` content in JavaScript and CSS */
const html: Lexer = (line, st, out) => {
  const n = line.length
  let mode = st ? st[0] : ''
  let inner = mode === 'J' || mode === 'Y' ? st.slice(2) : ''
  let tag = mode === 'T' ? st.slice(1) : ''
  let i = 0
  while (i < n) {
    if (mode === 'c' || mode === 'd') {
      const close = mode === 'c' ? '-->' : ']]>'
      const e = line.indexOf(close, i)
      if (e < 0) {
        put(out, 'c', line.slice(i))
        break
      }
      put(out, 'c', line.slice(i, e + 3))
      i = e + 3
      mode = ''
      continue
    }
    if (mode === 'J' || mode === 'Y') {
      const re = mode === 'J' ? END_SCRIPT : END_STYLE
      re.lastIndex = i
      const m = re.exec(line)
      const e = m ? m.index : n
      if (e > i) inner = (mode === 'J' ? javascript : CSS)(line.slice(i, e), inner, out)
      if (!m) break
      mode = inner = ''
      i = e
      continue
    }
    const ch = line[i]
    if (mode === 'T') {
      // inside a tag: attributes up to its end
      const c = cc(line, i)
      if (isSpace(c)) {
        const j = spaceEnd(line, i)
        put(out, '', line.slice(i, j))
        i = j
        continue
      }
      if (ch === '>' || (ch === '/' && line[i + 1] === '>') || (ch === '?' && line[i + 1] === '>')) {
        const end = ch === '>' ? '>' : ch + '>'
        put(out, 't', end)
        i += end.length
        mode = end === '>' && tag === 'script' ? 'J' : end === '>' && tag === 'style' ? 'Y' : ''
        continue
      }
      if (ch === '"' || ch === "'") {
        const e = quoteEnd(line, i + 1, ch, false)
        put(out, 's', line.slice(i, e < 0 ? n : e))
        i = e < 0 ? n : e
        continue
      }
      if (ch === '=') {
        put(out, '', ch)
        i++
        // an unquoted value
        const j0 = spaceEnd(line, i)
        if (j0 < n && line[j0] !== '"' && line[j0] !== "'" && line[j0] !== '>') {
          let j = j0
          while (j < n && !isSpace(cc(line, j)) && line[j] !== '>') j++
          put(out, '', line.slice(i, j0))
          put(out, 's', line.slice(j0, j))
          i = j
        }
        continue
      }
      let j = i
      while (j < n && !isSpace(cc(line, j)) && !'=>"\''.includes(line[j]) && !(line[j] === '/' && line[j + 1] === '>')) j++
      put(out, 'a', line.slice(i, Math.max(j, i + 1)))
      i = Math.max(j, i + 1)
      continue
    }
    // text, up to a tag or an entity
    let j = i
    while (j < n && line[j] !== '<' && line[j] !== '&') j++
    if (j > i) {
      put(out, '', line.slice(i, j))
      i = j
      continue
    }
    if (ch === '&') {
      ENTITY.lastIndex = i
      const m = ENTITY.exec(line)
      put(out, m ? 'n' : '', m ? m[0] : '&')
      i += m ? m[0].length : 1
      continue
    }
    if (line.startsWith('<!--', i)) {
      put(out, 'c', '<!--')
      mode = 'c'
      i += 4
      continue
    }
    if (line.startsWith('<![CDATA[', i)) {
      put(out, 'c', '<![CDATA[')
      mode = 'd'
      i += 9
      continue
    }
    if (line[i + 1] === '!' || line[i + 1] === '?') {
      // <!doctype …>, <?xml …?>
      const close = line[i + 1] === '?' ? '?>' : '>'
      const e = line.indexOf(close, i + 2)
      const end = e < 0 ? n : e + close.length
      put(out, line[i + 1] === '?' ? 'm' : 'k', line.slice(i, end))
      i = end
      continue
    }
    const closing = line[i + 1] === '/'
    const at = i + (closing ? 2 : 1)
    if (!isAlpha(cc(line, at))) {
      put(out, '', ch)
      i++
      continue
    }
    let e = at
    while (e < n && (isWord(cc(line, e)) || ':-.'.includes(line[e]))) e++
    put(out, 't', line.slice(i, e))
    tag = closing ? '/' : line.slice(at, e).toLowerCase()
    mode = 'T'
    i = e
  }
  return mode === 'J' || mode === 'Y' ? mode + S2 + inner : mode === 'T' ? 'T' + tag : mode
}

const CSS = css(false)

// ---------------------------------------------------------------- YAML

const YAML_CONST = /^(?:true|false|yes|no|on|off|null|~|[-+]?\.inf|\.nan)$/i
const YAML_NUM = /^[-+]?(?:\d[\d_]*(?:\.\d*)?(?:[eE][-+]?\d+)?|\.\d+|0x[0-9a-fA-F_]+|0o[0-7_]+)$/

const yaml: Lexer = (line, st, out) => {
  const n = line.length
  const ind = spaceEnd(line, 0)
  // a block scalar (| or >): the lines indented more than its key, and blank lines
  if (st) {
    const base = Number(st.slice(1))
    if (ind >= n || ind > base) {
      put(out, 's', line)
      return st
    }
  }
  let i = ind
  put(out, '', line.slice(0, i))
  if (i === 0 && /^(?:---|\.\.\.)(?:\s|$)/.test(line)) {
    put(out, 'k', line.slice(0, 3))
    i = 3
  }
  let block = ''
  // "- " items
  while (line[i] === '-' && (i + 1 >= n || isSpace(cc(line, i + 1)))) {
    const j = spaceEnd(line, i + 1)
    put(out, 'o', '-')
    put(out, '', line.slice(i + 1, j))
    i = j
  }
  // a key: a quoted or plain scalar followed by ": " (or ":" at the end)
  if (line[i] === '"' || line[i] === "'") {
    const e = quoteEnd(line, i + 1, line[i], line[i] === '"', line[i] === "'")
    const k = e < 0 ? -1 : spaceEnd(line, e)
    if (k >= 0 && line[k] === ':' && (k + 1 >= n || isSpace(cc(line, k + 1)))) {
      put(out, 'a', line.slice(i, e))
      put(out, '', line.slice(e, k + 1))
      i = k + 1
    }
  } else if (i < n && line[i] !== '#' && !'[{&*!|>%@`'.includes(line[i])) {
    let j = i
    while (j < n && !(line[j] === ':' && (j + 1 >= n || isSpace(cc(line, j + 1)))) && !(line[j] === '#' && isSpace(cc(line, j - 1)))) j++
    if (line[j] === ':') {
      put(out, 'a', line.slice(i, j))
      put(out, '', ':')
      i = j + 1
    }
  }
  // the value
  while (i < n) {
    const ch = line[i]
    const c = cc(line, i)
    if (isSpace(c)) {
      const j = spaceEnd(line, i)
      put(out, '', line.slice(i, j))
      i = j
      continue
    }
    if (ch === '#' && (i === 0 || isSpace(cc(line, i - 1)))) {
      put(out, 'c', line.slice(i))
      break
    }
    if (ch === '"' || ch === "'") {
      const e = quoteEnd(line, i + 1, ch, ch === '"', ch === "'")
      put(out, 's', line.slice(i, e < 0 ? n : e))
      i = e < 0 ? n : e
      continue
    }
    if ((ch === '&' || ch === '*' || ch === '!') && i + 1 < n && !isSpace(cc(line, i + 1))) {
      let j = i + 1
      while (j < n && !isSpace(cc(line, j)) && !',[]{}'.includes(line[j])) j++
      put(out, 'm', line.slice(i, j))
      i = j
      continue
    }
    if ((ch === '|' || ch === '>') && /^[|>][-+0-9]*\s*(?:#.*)?$/.test(line.slice(i, i + 200))) {
      const m = /^[|>][-+0-9]*/.exec(line.slice(i))!
      put(out, 'o', m[0])
      i += m[0].length
      block = 'B' + ind
      continue
    }
    if (',[]{}'.includes(ch)) {
      put(out, '', ch)
      i++
      continue
    }
    // a plain scalar, up to a comment or (in a flow collection) a separator
    let j = i
    while (j < n && !(line[j] === '#' && isSpace(cc(line, j - 1))) && !',[]{}'.includes(line[j])) j++
    let e = j
    while (e > i && isSpace(cc(line, e - 1))) e--
    const v = line.slice(i, e)
    put(out, YAML_CONST.test(v) || YAML_NUM.test(v) ? 'n' : 's', v)
    put(out, '', line.slice(e, j))
    i = j
  }
  return block
}

// ---------------------------------------------------------------- shell

const SH_KW = words('if then else elif fi for while until do done case esac in function select time coproc return break continue export local declare readonly typeset unset shift source alias set trap exit eval exec let')
/** after these a command name comes */
const SH_CMD = words('then do else elif if while until time ! { (')
const HEREDOC = /^<<(-?)[ \t]*(['"]?)([\w.-]+)\2/

const shell: Lexer = (line, st, out) => {
  const n = line.length
  let i = 0
  let next = ''
  // a here-document: its lines up to the delimiter
  if (st[0] === 'H') {
    const strip = st[1] === '-'
    const delim = st.slice(2)
    if ((strip ? line.replace(/^\t+/, '') : line) === delim) {
      put(out, 'k', line)
      return ''
    }
    put(out, 's', line)
    return st
  }
  let quote = st === 'q' ? "'" : st === 'Q' ? '"' : ''
  let cmd = !quote
  while (i < n) {
    if (quote) {
      // a string that goes on: "…$var…" or '…'
      let j = i
      while (j < n && line[j] !== quote && !(quote === '"' && line[j] === '$')) j += quote === '"' && line[j] === '\\' ? 2 : 1
      put(out, 's', line.slice(i, Math.min(j, n)))
      i = j
      if (i >= n) break
      if (line[i] === '$') {
        i = shVar(line, i, out)
        continue
      }
      put(out, 's', quote)
      quote = ''
      i++
      continue
    }
    const ch = line[i]
    const c = cc(line, i)
    if (isSpace(c)) {
      const j = spaceEnd(line, i)
      put(out, '', line.slice(i, j))
      i = j
      continue
    }
    if (ch === '#' && (i === 0 || isSpace(cc(line, i - 1)) || ';|&('.includes(line[i - 1]))) {
      put(out, i === 0 && line[1] === '!' ? 'm' : 'c', line.slice(i))
      break
    }
    if (ch === "'" || ch === '"') {
      put(out, 's', ch)
      quote = ch
      i++
      cmd = false
      continue
    }
    if (ch === '$') {
      i = shVar(line, i, out)
      cmd = false
      continue
    }
    if (ch === '`') {
      const e = line.indexOf('`', i + 1)
      put(out, 's', line.slice(i, e < 0 ? n : e + 1))
      i = e < 0 ? n : e + 1
      continue
    }
    if (ch === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
      const m = HEREDOC.exec(line.slice(i, i + 200))
      if (m) {
        put(out, 'o', m[0])
        next = 'H' + (m[1] ? '-' : '+') + m[3]
        i += m[0].length
        continue
      }
    }
    if ('|&;<>()'.includes(ch)) {
      let j = i + 1
      while (j < n && j < i + 3 && '|&;<>'.includes(line[j])) j++
      put(out, ch === '(' || ch === ')' ? '' : 'o', line.slice(i, j))
      cmd = ch !== ')' && ch !== '>' && ch !== '<'
      i = j
      continue
    }
    // a word: up to a space, a quote, $ or an operator
    let j = i
    while (j < n && !isSpace(cc(line, j)) && !'\'"$`|&;<>()'.includes(line[j])) j++
    const w = line.slice(i, j)
    const eq = w.indexOf('=')
    if (cmd && eq > 0 && /^[A-Za-z_]\w*(?:\[[^\]]*\])?$/.test(w.slice(0, eq))) {
      // NAME=value
      put(out, 'a', w.slice(0, eq))
      put(out, '', '=')
      put(out, /^-?\d+$/.test(w.slice(eq + 1)) ? 'n' : '', w.slice(eq + 1))
    } else if (SH_KW.has(w)) {
      put(out, 'k', w)
      cmd = SH_CMD.has(w)
      i = j
      continue
    } else if (cmd && w !== '{' && w !== '}') {
      put(out, 'f', w)
      cmd = false
    } else put(out, /^-?\d+$/.test(w) ? 'n' : '', w)
    i = j
  }
  return next || (quote === "'" ? 'q' : quote === '"' ? 'Q' : '')
}

/** $name, ${…}, $( / $(( , $1, $@ */
function shVar(line: string, i: number, out: Token[]): number {
  const n = line.length
  const d = line[i + 1]
  if (d === '{') {
    const e = line.indexOf('}', i + 2)
    put(out, 'a', line.slice(i, e < 0 ? n : e + 1))
    return e < 0 ? n : e + 1
  }
  if (d === '(') {
    const two = line[i + 2] === '('
    put(out, 'o', two ? '$((' : '$(')
    return i + (two ? 3 : 2)
  }
  if (d !== undefined && isAlpha(cc(line, i + 1))) {
    const e = wordEnd(line, i + 1)
    put(out, 'a', line.slice(i, e))
    return e
  }
  if (d !== undefined && /[0-9@*#?$!-]/.test(d)) {
    put(out, 'a', line.slice(i, i + 2))
    return i + 2
  }
  put(out, '', '$')
  return i + 1
}

// ---------------------------------------------------------------- diff, TOML / INI

const diff: Lexer = (line, _st, out) => {
  const cls = /^(?:\+\+\+|---)(?:\s|$)|^(?:diff|index|similarity|rename|new file|deleted file) /.test(line) ? 'k' : line.startsWith('@@') ? 'm' : line[0] === '+' ? 's' : line[0] === '-' ? 't' : line[0] === '!' ? 'o' : ''
  put(out, cls, line)
  return ''
}

const ini: Lexer = (line, st, out) => {
  const n = line.length
  let i = 0
  // TOML multi-line strings
  if (st) {
    const q3 = st.slice(1)
    const e = line.indexOf(q3)
    if (e < 0) {
      put(out, 's', line)
      return st
    }
    put(out, 's', line.slice(0, e + 3))
    i = e + 3
  } else {
    i = spaceEnd(line, 0)
    put(out, '', line.slice(0, i))
    if (line[i] === '#' || line[i] === ';') {
      put(out, 'c', line.slice(i))
      return ''
    }
    if (line[i] === '[') {
      const e = line.lastIndexOf(']')
      put(out, 'y', line.slice(i, e > i ? e + 1 : n))
      i = e > i ? e + 1 : n
    } else {
      // key = value (key: value)
      let j = i
      while (j < n && line[j] !== '=' && line[j] !== ':' && line[j] !== '"' && line[j] !== "'") j++
      if (line[j] === '=' || line[j] === ':') {
        put(out, 'a', line.slice(i, j))
        put(out, '', line[j])
        i = j + 1
      }
    }
  }
  while (i < n) {
    const ch = line[i]
    const c = cc(line, i)
    if (isSpace(c) || ',[]{}='.includes(ch)) {
      put(out, '', ch)
      i++
      continue
    }
    if (ch === '#') {
      put(out, 'c', line.slice(i))
      break
    }
    if (ch === '"' || ch === "'") {
      if (line.startsWith(ch + ch + ch, i)) {
        const e = line.indexOf(ch + ch + ch, i + 3)
        if (e < 0) {
          put(out, 's', line.slice(i))
          return 'T' + ch + ch + ch
        }
        put(out, 's', line.slice(i, e + 3))
        i = e + 3
        continue
      }
      const e = quoteEnd(line, i + 1, ch, ch === '"')
      put(out, 's', line.slice(i, e < 0 ? n : e))
      i = e < 0 ? n : e
      continue
    }
    let j = i
    while (j < n && !isSpace(cc(line, j)) && !',[]{}#'.includes(line[j])) j++
    const w = line.slice(i, j)
    put(out, /^(?:true|false|[-+]?(?:\d[\d_:.+-]*(?:[eEtTzZ][\d:.+-]*)*|inf|nan|0x[0-9a-fA-F_]+))$/i.test(w) ? 'n' : '', w)
    i = j
  }
  return ''
}

// ---------------------------------------------------------------- rule-based: Mermaid, PlantUML, Graphviz DOT, Markdown text

type Rule = [RegExp, string]

const sticky = (rules: [RegExp, string][]): Rule[] => rules.map(([re, c]) => [new RegExp(re.source, 'y' + re.flags.replace(/[gy]/g, '')), c])

/** tries each rule at each position (every rule's work is bounded, see the {0,n} quantifiers); a word with no rule goes whole */
function scan(line: string, rules: Rule[], out: Token[]) {
  let i = 0
  while (i < line.length) {
    let hit = false
    for (const [re, c] of rules) {
      re.lastIndex = i
      const m = re.exec(line)
      if (m && m[0].length) {
        put(out, c, m[0])
        i += m[0].length
        hit = true
        break
      }
    }
    if (!hit) {
      // keywords match at word starts only
      const j = isWord(cc(line, i)) ? wordEnd(line, i) : i + 1
      put(out, '', line.slice(i, j))
      i = j
    }
  }
}

const MERMAID_KW =
  'graph|flowchart|subgraph|end|direction|classDef|class|style|linkStyle|click|sequenceDiagram|participant|actor|loop|alt|else|opt|par|and|critical|option|break|rect|[Nn]ote|over|left of|right of|activate|deactivate|autonumber|title|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|state|erDiagram|pie|showData|gantt|dateFormat|axisFormat|excludes|section|mindmap|namespace|TB|TD|BT|RL|LR|as|box|create|destroy|done|active|crit|milestone|after'

const RULES = {
  mermaid: sticky([
    [/%%.*/, 'c'],
    [/"[^"]{0,500}"/, 's'],
    [/\|[^|\n]{0,200}\|(?=\s*[\w"([{])/, 's'],
    [new RegExp(`\\b(?:${MERMAID_KW})\\b`), 'k'],
    [/<<-->>|<<->>|-->>|->>|--[x)]|-[x)]|<?-\.{1,20}->?|<?={2,}>?|<?-{2,}[>ox]?|->|~~~|<\|--|--\|>|\*--|--\*|o--|--o|\.\.>|\.\.\|>|<\.\.|\.\.|[|}][|o]--[|o][|{]|[|}][|o]\.\.[|o][|{]|:::|&/, 'o'],
    [/\b\d+(?:\.\d+)?\b/, 'n'],
    [/#[0-9a-fA-F]{3,8}\b/, 'n'],
  ]),
  plantuml: sticky([
    [/@(?:start|end)\w*/, 'k'],
    [/![a-z]+\b.*/, 'k'],
    [/"[^"]{0,500}"/, 's'],
    [/^\s*:[^;\n]*[;|<>/\]}]?/, 's'],
    [
      /\b(?:participant|actor|boundary|control|entity|database|collections|queue|class|interface|abstract|enum|annotation|package|namespace|node|component|usecase|rectangle|cloud|folder|frame|artifact|storage|card|file|object|state|start|stop|end|if|then|else|elseif|endif|while|endwhile|repeat|fork|again|merge|note|of|left|right|top|bottom|over|alt|opt|loop|par|break|critical|group|return|activate|deactivate|destroy|create|autonumber|title|skinparam|as|is|not|detach|kill|partition|split|switch|case|endswitch|hide|show|footbox|direction|to)\b/,
      'k',
    ],
    [/<<[^>\n]{0,100}>>/, 'a'],
    [/[<*o#x}|^+]{0,2}(?:-{1,10}|\.{2,10}|={1,10})(?:\[[^\]\n]{0,80}\])?(?:up|down|left|right)?(?:-{1,10}|\.{1,10}|={1,10})?(?:\|>|>>?|[*o#x{|^+\\/]{1,2})|<\|?(?:-{1,10}|\.{1,10})|-{2,}|\.{2,}|\+\+|\*\*|!!/, 'o'],
    [/#[0-9a-zA-Z]{3,8}\b/, 'n'],
    [/\b\d+\b/, 'n'],
  ]),
  graphviz: sticky([
    [/\/\/.*/, 'c'],
    [/"(?:\\.|[^"\\]){0,500}"/, 's'],
    [/<(?:[^<>]|<[^<>]{0,200}>){0,500}>/, 's'],
    [/\b(?:strict|graph|digraph|subgraph|node|edge)\b/i, 'k'],
    [/[\w.]{1,64}(?=\s*=)/, 'a'],
    [/->|--/, 'o'],
    [/-?\b\d+(?:\.\d+)?\b/, 'n'],
  ]),
  markdown: sticky([
    [/`[^`\n]{1,500}`/, 'm'],
    [/!?\[[^\]\n]{0,200}\]\([^)\n]{0,500}\)/, 'a'],
    [/<https?:\/\/[^>\s]{1,500}>/, 'a'],
    [/(\*\*|__)(?=\S)[^\n]{0,300}?\S\1/, 'b'],
    [/(?<![\w*])\*(?=\S)[^*\n]{0,300}?\S\*(?!\*)|(?<!\w)_(?=\S)[^_\n]{0,300}?\S_(?!\w)/, 'i'],
    [/~~(?=\S)[^\n]{0,300}?\S~~/, 'c'],
    [/<\/?[A-Za-z][^>\n]{0,300}>/, 't'],
  ]),
}

/** comments that span lines: [opening, closing] */
const BLOCK_COMMENT: Record<'mermaid' | 'plantuml' | 'graphviz', [string, string] | null> = { mermaid: null, plantuml: ["/'", "'/"], graphviz: ['/*', '*/'] }

function ruled(lang: 'mermaid' | 'plantuml' | 'graphviz'): Lexer {
  const rules = RULES[lang]
  const block = BLOCK_COMMENT[lang]
  return (line, st, out) => {
    let i = 0
    const n = line.length
    if (st && block) {
      const e = line.indexOf(block[1])
      if (e < 0) {
        put(out, 'c', line)
        return st
      }
      put(out, 'c', line.slice(0, e + block[1].length))
      i = e + block[1].length
    }
    // whole-line comments: ' in PlantUML, # in DOT
    if (i === 0 && ((lang === 'plantuml' && /^\s*'/.test(line)) || (lang === 'graphviz' && /^\s*#/.test(line)))) {
      put(out, 'c', line)
      return ''
    }
    while (i < n) {
      const at = block ? line.indexOf(block[0], i) : -1
      scan(at < 0 ? line.slice(i) : line.slice(i, at), rules, out)
      if (at < 0) break
      const e = line.indexOf(block![1], at + block![0].length)
      if (e < 0) {
        put(out, 'c', line.slice(at))
        return 'C'
      }
      put(out, 'c', line.slice(at, e + block![1].length))
      i = e + block![1].length
    }
    return ''
  }
}

// ---------------------------------------------------------------- Markdown (code blocks in their own language)

const markdown: Lexer = (line, st, out) => {
  const f = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/.exec(line)
  if (st) {
    // in a code block: its closing fence, or a line of its code
    const a = st.indexOf(S3)
    const b = st.indexOf(S3, a + 1)
    const mark = st.slice(1, a)
    const lang = st.slice(a + 1, b)
    if (f && f[2][0] === mark[0] && f[2].length >= mark.length && !f[3] && !line.slice(f[0].length).trim()) {
      put(out, 'k', line)
      return ''
    }
    const lx = LEXERS[lang]
    if (!lx) {
      put(out, 'm', line)
      return st
    }
    const inner = line.length > LINE_MAX ? (put(out, '', line), st.slice(b + 1)) : lx(line, st.slice(b + 1), out)
    return st.slice(0, b + 1) + inner
  }
  if (f) {
    put(out, 'k', line)
    return 'F' + f[2] + S3 + (languageOf(f[3]) ?? '') + S3
  }
  if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) {
    put(out, 'h', line)
    return ''
  }
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
    put(out, 'o', line)
    return ''
  }
  const lead = /^(\s*(?:>\s*)*)((?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/.exec(line)!
  if (lead[1]) put(out, lead[1].includes('>') ? 'c' : '', lead[1])
  if (lead[2]) put(out, 'o', lead[2])
  scan(line.slice(lead[0].length), RULES.markdown, out)
  return ''
}

// ---------------------------------------------------------------- languages

const LEXERS: Record<string, Lexer> = dict({
  javascript, typescript, tsx, json, python, css: CSS, scss: css(true), html, xml: html, yaml, shell, sql, go, rust, java, c, cpp, csharp,
  markdown, mermaid: ruled('mermaid'), plantuml: ruled('plantuml'), graphviz: ruled('graphviz'), diff, toml: ini, ini,
})

/** display names of the languages */
export const LANGUAGE_NAME: Record<string, string> = dict({
  javascript: 'JavaScript', typescript: 'TypeScript', tsx: 'TSX', json: 'JSON', python: 'Python', css: 'CSS', scss: 'SCSS', html: 'HTML', xml: 'XML',
  yaml: 'YAML', shell: 'Shell', sql: 'SQL', go: 'Go', rust: 'Rust', java: 'Java', c: 'C', cpp: 'C++', csharp: 'C#', markdown: 'Markdown',
  mermaid: 'Mermaid', plantuml: 'PlantUML', graphviz: 'Graphviz', diff: 'Diff', toml: 'TOML', ini: 'INI', text: 'Plain text',
})

/** other names of the languages (code fence info strings, hints) */
const ALIASES: Record<string, string> = dict({
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', node: 'javascript', ecmascript: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  jsonc: 'json', json5: 'json', webmanifest: 'json',
  py: 'python', py3: 'python', python3: 'python', pyw: 'python', gyp: 'python',
  less: 'scss', sass: 'scss',
  htm: 'html', xhtml: 'html', vue: 'html', svelte: 'html',
  svg: 'xml', xsl: 'xml', xslt: 'xml', xsd: 'xml', rss: 'xml', atom: 'xml', plist: 'xml', wsdl: 'xml',
  yml: 'yaml',
  sh: 'shell', bash: 'shell', zsh: 'shell', ksh: 'shell', shellscript: 'shell', console: 'shell', bashrc: 'shell', zshrc: 'shell',
  mysql: 'sql', postgresql: 'sql', postgres: 'sql', psql: 'sql', plsql: 'sql', tsql: 'sql', sqlite: 'sql',
  golang: 'go', rs: 'rust', h: 'c',
  'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', 'h++': 'cpp', ino: 'cpp',
  cs: 'csharp', 'c#': 'csharp',
  md: 'markdown', mkd: 'markdown',
  mmd: 'mermaid', puml: 'plantuml', uml: 'plantuml', pu: 'plantuml', dot: 'graphviz', gv: 'graphviz',
  patch: 'diff', cfg: 'ini', properties: 'ini', editorconfig: 'ini', gitconfig: 'ini', dosini: 'ini',
  txt: 'text', plain: 'text', plaintext: 'text',
})

/** The language a name stands for (a fence's info string, a hint: "js", "TypeScript", "c++"), undefined when unknown. */
export function languageOf(id: string | null | undefined): string | undefined {
  if (!id) return undefined
  const k = id.trim().toLowerCase()
  return ALIASES[k] ?? (k in LEXERS || k === 'text' ? k : undefined)
}

/** file name extensions of source files, opened as code */
export const CODE_EXT: Record<string, string> = dict({
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  json: 'json', jsonc: 'json', json5: 'json', py: 'python', pyw: 'python', css: 'css', scss: 'scss', less: 'scss',
  xml: 'xml', xsl: 'xml', xslt: 'xml', xsd: 'xml', yaml: 'yaml', yml: 'yaml', sh: 'shell', bash: 'shell', zsh: 'shell', bashrc: 'shell', zshrc: 'shell',
  sql: 'sql', go: 'go', rs: 'rust', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', cs: 'csharp',
  toml: 'toml', ini: 'ini', cfg: 'ini', properties: 'ini', diff: 'diff', patch: 'diff', vue: 'html', svelte: 'html',
})

/** the usual file name extension of each language (a source file saved without a name of its own) */
export const LANGUAGE_EXT: Record<string, string> = dict({
  javascript: 'js', typescript: 'ts', tsx: 'tsx', json: 'json', python: 'py', css: 'css', scss: 'scss', html: 'html', xml: 'xml', yaml: 'yaml',
  shell: 'sh', sql: 'sql', go: 'go', rust: 'rs', java: 'java', c: 'c', cpp: 'cpp', csharp: 'cs', markdown: 'md', mermaid: 'mmd', plantuml: 'puml',
  graphviz: 'dot', diff: 'diff', toml: 'toml', ini: 'ini', text: 'txt',
})

/** MIME types of source files, opened as code */
export const CODE_MIME: Record<string, string> = dict({
  'application/json': 'json', 'application/ld+json': 'json', 'application/manifest+json': 'json', 'text/json': 'json',
  'text/javascript': 'javascript', 'application/javascript': 'javascript', 'application/x-javascript': 'javascript', 'text/jsx': 'javascript',
  'application/typescript': 'typescript', 'text/typescript': 'typescript', 'application/x-typescript': 'typescript',
  'text/x-python': 'python', 'text/x-script.python': 'python', 'application/x-python-code': 'python',
  'text/css': 'css', 'text/x-scss': 'scss', 'text/x-less': 'scss',
  'application/xml': 'xml', 'text/xml': 'xml',
  'application/x-yaml': 'yaml', 'application/yaml': 'yaml', 'text/yaml': 'yaml', 'text/x-yaml': 'yaml',
  'application/x-sh': 'shell', 'text/x-sh': 'shell', 'text/x-shellscript': 'shell', 'application/x-shellscript': 'shell',
  'application/sql': 'sql', 'text/x-sql': 'sql', 'text/x-go': 'go', 'text/x-rust': 'rust', 'text/rust': 'rust',
  'text/x-java': 'java', 'text/x-java-source': 'java', 'text/x-c': 'c', 'text/x-csrc': 'c', 'text/x-chdr': 'c',
  'text/x-c++src': 'cpp', 'text/x-c++hdr': 'cpp', 'text/x-csharp': 'csharp',
  'application/toml': 'toml', 'text/x-toml': 'toml', 'text/x-diff': 'diff', 'text/x-patch': 'diff',
})

const extOf = (name?: string) => /\.([^./\\]+)$/.exec(name ?? '')?.[1].toLowerCase() ?? ''

/** The language of a source file from its name, else its MIME type; undefined for a file that is not source code. */
export function languageOfFile(name?: string, type?: string): string | undefined {
  return CODE_EXT[extOf(name)] ?? CODE_MIME[(type ?? '').split(';')[0].trim().toLowerCase()]
}

// ---------------------------------------------------------------- highlighting

/** tokens of lines already read, by language, state and text: an edit reads again only the lines it changed */
const CACHE = new Map<string, { toks: Token[]; end: string }>()
const CACHE_MAX = 20_000
const CACHED_LINE = 2_000

function lineTokens(lang: string, lx: Lexer, line: string, st: string): { toks: Token[]; end: string } {
  const key = line.length <= CACHED_LINE ? lang + S3 + st + S3 + line : ''
  const hit = key ? CACHE.get(key) : undefined
  if (hit) return hit
  let r: { toks: Token[]; end: string }
  if (line.length > LINE_MAX) r = { toks: [['', line]], end: st }
  else {
    // a CRLF text: the CR is not code
    const cr = line.endsWith('\r')
    const toks: Token[] = []
    const end = lx(cr ? line.slice(0, -1) : line, st, toks)
    if (cr) toks.push(['', '\r'])
    r = { toks, end }
  }
  if (key) {
    if (CACHE.size >= CACHE_MAX) CACHE.clear()
    CACHE.set(key, r)
  }
  return r
}

/**
 * The tokens of each line of `text` (lines are separated by "\n"; a token array may be shared between calls: do not
 * change it). An unknown language, or a text over `max` characters: plain.
 */
export function highlightLines(lang: string | undefined, text: string, max = HIGHLIGHT_MAX): Token[][] {
  const lines = text.split('\n')
  const id = languageOf(lang)
  const lx = id ? LEXERS[id] : undefined
  if (!lx || text.length > max) return lines.map((l) => (l ? [['', l]] : []))
  let st = ''
  return lines.map((l) => {
    const r = lineTokens(id!, lx, l, st)
    st = r.end
    return r.toks
  })
}

/** The tokens of the whole text, lines separated by ['', '\n'] tokens. */
export function highlight(lang: string | undefined, text: string, max = HIGHLIGHT_MAX): Token[] {
  const out: Token[] = []
  highlightLines(lang, text, max).forEach((toks, k) => {
    if (k) out.push(['', '\n'])
    for (const t of toks) out.push(t)
  })
  return out
}
