/** FILTERXML: the values an XPath picks from XML text. */
import { parseXml, type XEl } from '../../xml'
import { A, type FnDef } from './fn'
import { ERR, type Value } from './types'
import { ArrayV, str } from './values'

/** what a step picks: an element, or a text (an attribute's value, `text()`) */
type Item = XEl | string

const isEl = (x: Item): x is XEl => typeof x !== 'string'
const textOf = (x: Item): string => (isEl(x) ? x.t + x.c.map(textOf).join('') : x)
const local = (n: string) => n.slice(n.indexOf(':') + 1)

function descendants(el: XEl, out: XEl[] = []): XEl[] {
  for (const c of el.c) {
    out.push(c)
    descendants(c, out)
  }
  return out
}

/** the steps of a path, cut at the `/` outside brackets and quotes; `deep`: the step came after `//` */
function steps(path: string): { text: string; deep: boolean }[] {
  const out: { text: string; deep: boolean }[] = []
  let depth = 0
  let quote = ''
  let cur = ''
  let deep = false
  let slashes = 0
  const push = () => {
    if (cur !== '') out.push({ text: cur, deep })
    cur = ''
  }
  for (const ch of path) {
    if (quote) {
      if (ch === quote) quote = ''
      cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === '[') {
      depth++
      cur += ch
    } else if (ch === ']') {
      depth--
      cur += ch
    } else if (ch === '/' && depth === 0) {
      push()
      slashes++
      deep = slashes >= 2
      continue
    } else cur += ch
    if (ch !== '/') {
      if (cur.length === 1) deep = slashes >= 2
      slashes = 0
    }
  }
  push()
  if (depth !== 0 || quote) throw ERR.VALUE
  return out
}

/** the value an operand of a predicate has for an element: `.`, `text()`, `@attr`, a child's name, a literal */
function operand(text: string, el: XEl): string | undefined {
  const t = text.trim()
  if (/^(['"]).*\1$/.test(t)) return t.slice(1, -1)
  if (/^-?\d+(\.\d+)?$/.test(t)) return t
  if (t === '.' || t === 'text()') return textOf(el)
  if (t.startsWith('@')) return el.a[t.slice(1)]
  const kid = el.c.find((c) => local(c.n) === t)
  return kid ? textOf(kid) : undefined
}

function test(pred: string, el: XEl, pos: number, size: number): boolean {
  const p = pred.trim()
  if (/^\d+$/.test(p)) return pos === Number(p)
  if (p === 'last()') return pos === size
  let m = /^(contains|starts-with)\(\s*(.+?)\s*,\s*(.+?)\s*\)$/.exec(p)
  if (m) {
    const a = operand(m[2], el)
    const b = operand(m[3], el)
    if (a === undefined || b === undefined) return false
    return m[1] === 'contains' ? a.includes(b) : a.startsWith(b)
  }
  m = /^(.+?)\s*(!=|<=|>=|=|<|>)\s*(.+)$/.exec(p)
  if (m) {
    const lhs = m[1].trim()
    const a = lhs === 'position()' ? String(pos) : operand(lhs, el)
    const rhs = m[3].trim()
    const b = rhs === 'last()' ? String(size) : operand(rhs, el)
    if (a === undefined || b === undefined) return false
    const numeric = a.trim() !== '' && b.trim() !== '' && !Number.isNaN(Number(a)) && !Number.isNaN(Number(b))
    const c = numeric ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0
    return m[2] === '=' ? c === 0 : m[2] === '!=' ? c !== 0 : m[2] === '<' ? c < 0 : m[2] === '<=' ? c <= 0 : m[2] === '>' ? c > 0 : c >= 0
  }
  // an attribute or a child that is there
  return operand(p, el) !== undefined
}

function select(root: XEl, path: string): Item[] {
  // a document above the root: the first step of an absolute path names the root itself
  let ctx: Item[] = [{ n: '', a: {}, c: [root], t: '' }]
  for (const step of steps(path.trim())) {
    const m = /^([^[]*)((?:\[[^\]]*\])*)$/.exec(step.text.trim())
    if (!m) throw ERR.VALUE
    const name = m[1].trim()
    const preds = [...m[2].matchAll(/\[([^\]]*)\]/g)].map((x) => x[1])
    const next: Item[] = []
    for (const c of ctx) {
      if (!isEl(c)) continue
      const pool = step.deep ? [c, ...descendants(c)] : [c]
      if (name === '.') {
        next.push(c)
        continue
      }
      for (const from of pool) {
        if (name.startsWith('@')) {
          const v = from.a[name.slice(1)]
          if (v !== undefined) next.push(v)
          continue
        }
        if (name === 'text()') {
          if (from.t !== '') next.push(from.t)
          continue
        }
        let found = from.c.filter((k) => name === '*' || local(k.n) === local(name))
        for (const p of preds) found = found.filter((k, i) => test(p, k, i + 1, found.length))
        next.push(...found)
      }
    }
    ctx = next
  }
  return ctx
}

export const WEB: Record<string, FnDef> = {
  FILTERXML: A(2, 2, (a, ev) => {
    const xml = str(ev.scalar(a[0]))
    const path = str(ev.scalar(a[1]))
    let root: XEl
    try {
      root = parseXml(xml)
    } catch {
      throw ERR.VALUE
    }
    const found = select(root, path)
    if (!found.length) throw ERR.VALUE
    // text that is a number is one
    return new ArrayV(found.map((x): Value[] => {
      const t = textOf(x)
      return [/^\s*-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(t) ? Number(t) : t]
    }))
  }),
}
