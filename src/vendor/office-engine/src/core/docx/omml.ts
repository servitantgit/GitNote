/**
 * A readable linear form of an Office Math (OMML) equation: what the document shows in place of the typeset formula.
 * The equation itself is kept as it is in the file (see the converter); this text is only for reading and searching.
 */
import { dict } from '../dict'
import { kid, kids, type XEl } from '../xml'

const SUP = dict(Object.fromEntries([...'0123456789+-−=()ni'].map((c, i) => [c, '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁻⁼⁽⁾ⁿⁱ'[i]])))
const SUB = dict(Object.fromEntries([...'0123456789+-−=()'].map((c, i) => [c, '₀₁₂₃₄₅₆₇₈₉₊₋₋₌₍₎'[i]])))

/** one thing that needs no parentheses to be an operand: a word, a number, a symbol, or text already enclosed */
function atom(s: string): boolean {
  if (s.length === 0) return true
  if (/^[\p{L}\p{N}\p{M}.²³¹⁰⁴-⁹₀-₉′″]+$/u.test(s) || [...s].length === 1) return true
  if (s[0] !== '(' || s[s.length - 1] !== ')') return false
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')' && --depth === 0 && i < s.length - 1) return false
  }
  return depth === 0
}

const wrap = (s: string) => (atom(s) ? s : `(${s})`)

/** a script: in Unicode super / subscripts when every character has one, else `^x` / `_x` (parenthesized when long) */
function script(s: string, up: boolean): string {
  if (!s) return ''
  const map = up ? SUP : SUB
  let out = ''
  for (const c of s) {
    const m = map[c]
    if (m === undefined) return (up ? '^' : '_') + wrapLimit(s)
    out += m
  }
  return out
}
/** after ^ / _ : a plain word stays bare, anything else is enclosed */
const wrapLimit = (s: string) => (/^[\p{L}\p{N}.]+$/u.test(s) || atom(s) ? s : `(${s})`)

const chr = (pr: XEl | undefined, name: string, dflt: string) => {
  const v = kid(pr, name)?.a.val
  return v === undefined ? dflt : v
}

const RADICAL: Record<string, string> = dict({ 2: '√', 3: '∛', 4: '∜' })

function children(e: XEl | undefined): string {
  let s = ''
  for (const c of e?.c ?? []) s += lin(c)
  return s
}

function lin(e: XEl): string {
  switch (e.n) {
    case 'r': {
      let s = ''
      for (const c of e.c) if (c.n === 't') s += c.t
      return s
    }
    case 't': return e.t
    case 'oMathPara': return kids(e, 'oMath').map(lin).join(' ')
    case 'f': return `${wrap(children(kid(e, 'num')))}/${wrap(children(kid(e, 'den')))}`
    case 'sSup': return wrap(children(kid(e, 'e'))) + script(children(kid(e, 'sup')), true)
    case 'sSub': return wrap(children(kid(e, 'e'))) + script(children(kid(e, 'sub')), false)
    case 'sSubSup': return wrap(children(kid(e, 'e'))) + script(children(kid(e, 'sub')), false) + script(children(kid(e, 'sup')), true)
    case 'sPre': return script(children(kid(e, 'sub')), false) + script(children(kid(e, 'sup')), true) + wrap(children(kid(e, 'e')))
    case 'rad': {
      const deg = children(kid(e, 'deg'))
      const hide = kid(kid(e, 'radPr'), 'degHide')
      const body = `(${children(kid(e, 'e'))})`
      if (!deg || (hide && hide.a.val !== '0' && hide.a.val !== 'false')) return '√' + body
      return (RADICAL[deg] ?? script(deg, true) + '√') + body
    }
    case 'nary': {
      const pr = kid(e, 'naryPr')
      const sub = children(kid(e, 'sub'))
      const sup = children(kid(e, 'sup'))
      const op = chr(pr, 'chr', '∫')
      const body = children(kid(e, 'e'))
      return op + (sub ? '_' + wrapLimit(sub) : '') + (sup ? '^' + wrapLimit(sup) : '') + (body ? (op ? ' ' : '') + body : '')
    }
    case 'd': {
      const pr = kid(e, 'dPr')
      const parts = kids(e, 'e').map(children)
      return chr(pr, 'begChr', '(') + parts.join(chr(pr, 'sepChr', ',')) + chr(pr, 'endChr', ')')
    }
    case 'func': {
      const name = children(kid(e, 'fName'))
      const arg = children(kid(e, 'e'))
      return name + (arg.startsWith('(') ? '' : ' ') + arg
    }
    case 'acc': return children(kid(e, 'e')) + chr(kid(e, 'accPr'), 'chr', '̂')
    case 'bar': {
      const body = children(kid(e, 'e'))
      return atom(body) ? [...body].map((c) => c + '̅').join('') : `‾(${body})`
    }
    case 'groupChr': return children(kid(e, 'e'))
    case 'limLow': return children(kid(e, 'e')) + '_' + wrapLimit(children(kid(e, 'lim')))
    case 'limUpp': return children(kid(e, 'e')) + '^' + wrapLimit(children(kid(e, 'lim')))
    case 'm': return '[' + kids(e, 'mr').map((r) => kids(r, 'e').map(children).join(', ')).join('; ') + ']'
    case 'eqArr': return kids(e, 'e').map(children).join('; ')
    case 'phant': {
      const show = kid(kid(e, 'phantPr'), 'show')
      return show && (show.a.val === '0' || show.a.val === 'false') ? '' : children(kid(e, 'e'))
    }
    default:
      // properties (…Pr) carry no text; the rest (oMath, e, box, borderBox, …) is its content
      return e.n.endsWith('Pr') ? '' : children(e)
  }
}

/** the linear text of an `m:oMath` / `m:oMathPara` element */
export function ommlText(e: XEl): string {
  return lin(e)
}
