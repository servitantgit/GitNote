/**
 * Guard against catastrophic backtracking in the REGEX* functions. A running RegExp cannot be interrupted and a worker
 * has no other way out, so a pattern whose shape allows an exponential blow-up is first replayed over the actual text
 * by a small backtracking matcher with a step budget; only when that finishes is the native RegExp run.
 */

type Node =
  | { k: 'atom'; re: RegExp }
  | { k: 'seq'; items: Node[] }
  | { k: 'alt'; items: Node[] }
  | { k: 'group'; cap: number; body: Node }
  | { k: 'rep'; min: number; max: number; lazy: boolean; body: Node }
  | { k: 'bol' }
  | { k: 'eol' }
  | { k: 'wb'; neg: boolean }
  | { k: 'ref'; n: number; name: string }
  | { k: 'look'; behind: boolean; neg: boolean; body: Node }

/** steps (node visits and match attempts) allowed over all start positions of one call */
const STEP_BUDGET = 2_000_000

/**
 * A pattern this file does not model (so it cannot be analysed) is refused only when the text is longer than this:
 * short texts cannot hurt, and refusing every unusual pattern would break ordinary formulas.
 */
const UNMODELED_TEXT_LIMIT = 64

class Unmodeled extends Error {}
class OverBudget extends Error {}

function parse(src: string, flags: string): { root: Node; caps: number; names: Map<string, number> } {
  let i = 0
  let caps = 0
  const names = new Map<string, number>()
  const atom = (from: number): Node => {
    try {
      return { k: 'atom', re: new RegExp(`^(?:${src.slice(from, i)})$`, flags) }
    } catch {
      throw new Unmodeled()
    }
  }

  const escape = (): Node => {
    const from = i++
    const c = src[i]
    if (c === undefined) throw new Unmodeled()
    if (/[1-9]/.test(c)) {
      const m = /^\d+/.exec(src.slice(i))![0]
      i += m.length
      return { k: 'ref', n: +m, name: '' }
    }
    if (c === 'k' && src[i + 1] === '<') {
      const end = src.indexOf('>', i)
      if (end < 0) throw new Unmodeled()
      const name = src.slice(i + 2, end)
      i = end + 1
      return { k: 'ref', n: 0, name }
    }
    if (c === 'b' || c === 'B') {
      i++
      return { k: 'wb', neg: c === 'B' }
    }
    if (c === 'p' || c === 'P') {
      const end = src.indexOf('}', i)
      if (src[i + 1] !== '{' || end < 0) throw new Unmodeled()
      i = end + 1
    } else if (c === 'u' && src[i + 1] === '{') {
      const end = src.indexOf('}', i)
      if (end < 0) throw new Unmodeled()
      i = end + 1
    } else if (c === 'u') i += 5
    else if (c === 'x') i += 3
    else if (c === 'c') i += 2
    else i++
    return atom(from)
  }

  const cls = (): Node => {
    const from = i++
    while (i < src.length && src[i] !== ']') i += src[i] === '\\' ? 2 : 1
    if (i >= src.length) throw new Unmodeled()
    i++
    return atom(from)
  }

  const group = (): Node => {
    i++
    let cap = 0
    let look: { behind: boolean; neg: boolean } | undefined
    if (src[i] === '?') {
      const rest = src.slice(i, i + 4)
      if (rest.startsWith('?:')) i += 2
      else if (rest.startsWith('?=') || rest.startsWith('?!')) look = { behind: false, neg: rest[1] === '!' }, (i += 2)
      else if (rest.startsWith('?<=') || rest.startsWith('?<!')) look = { behind: true, neg: rest[2] === '!' }, (i += 3)
      else if (rest.startsWith('?<')) {
        const end = src.indexOf('>', i)
        if (end < 0) throw new Unmodeled()
        cap = ++caps
        names.set(src.slice(i + 2, end), cap)
        i = end + 1
      } else throw new Unmodeled()
    } else cap = ++caps
    const body = alt()
    if (src[i] !== ')') throw new Unmodeled()
    i++
    return look ? { k: 'look', ...look, body } : { k: 'group', cap, body }
  }

  const term = (): Node => {
    const c = src[i]
    let node: Node
    if (c === '\\') node = escape()
    else if (c === '[') node = cls()
    else if (c === '(') node = group()
    else if (c === '^') (i++, (node = { k: 'bol' }))
    else if (c === '$') (i++, (node = { k: 'eol' }))
    else if (c === '*' || c === '+' || c === '?') throw new Unmodeled()
    else {
      const from = i
      i += (flags.includes('u') ? src.codePointAt(i)! : 0) > 0xffff ? 2 : 1
      node = atom(from)
    }
    let min: number
    let max: number
    const q = src[i]
    if (q === '*') (min = 0), (max = Infinity), i++
    else if (q === '+') (min = 1), (max = Infinity), i++
    else if (q === '?') (min = 0), (max = 1), i++
    else {
      const m = q === '{' ? /^\{(\d+)(?:(,)(\d*))?\}/.exec(src.slice(i)) : null
      if (!m) return node
      min = +m[1]
      max = m[2] ? (m[3] ? +m[3] : Infinity) : min
      i += m[0].length
    }
    const lazy = src[i] === '?'
    if (lazy) i++
    return { k: 'rep', min, max, lazy, body: node }
  }

  const seq = (): Node => {
    const items: Node[] = []
    while (i < src.length && src[i] !== '|' && src[i] !== ')') items.push(term())
    return { k: 'seq', items }
  }

  const alt = (): Node => {
    const items = [seq()]
    while (src[i] === '|') (i++, items.push(seq()))
    return items.length === 1 ? items[0] : { k: 'alt', items }
  }

  const root = alt()
  if (i < src.length) throw new Unmodeled()
  return { root, caps, names }
}

/** a repeated (more than once possible) part holding another repeated part, or an alternation: the shapes that can blow up */
function risky(n: Node, inRepeat = false): boolean {
  switch (n.k) {
    case 'rep': {
      const again = n.max > 1
      if (again && inRepeat) return true
      return risky(n.body, inRepeat || again)
    }
    case 'alt':
      return inRepeat || n.items.some((x) => risky(x, inRepeat))
    case 'seq':
      return n.items.some((x) => risky(x, inRepeat))
    case 'group':
    case 'look':
      return risky(n.body, inRepeat)
    default:
      return false
  }
}

/** Replays the match (not its result, only its backtracking) from every start position; the end of the first match, or -1. */
function simulate(root: Node, text: string, unicode: boolean, ignoreCase: boolean, names: Map<string, number>, from: number, steps: { n: number }): number {
  const caps: ([number, number] | undefined)[] = []
  const tick = () => {
    if (++steps.n > STEP_BUDGET) throw new OverBudget()
  }
  const charAt = (p: number): string => {
    if (p >= text.length) return ''
    if (unicode) {
      const cp = text.codePointAt(p)!
      return String.fromCodePoint(cp)
    }
    return text[p]
  }
  const word = (p: number) => p >= 0 && p < text.length && /\w/.test(text[p])

  const m = (n: Node, p: number, k: (q: number) => boolean): boolean => {
    tick()
    switch (n.k) {
      case 'atom': {
        const c = charAt(p)
        return !!c && n.re.test(c) && k(p + c.length)
      }
      case 'seq': {
        const go = (idx: number, q: number): boolean => (idx === n.items.length ? k(q) : m(n.items[idx], q, (r) => go(idx + 1, r)))
        return go(0, p)
      }
      case 'alt':
        return n.items.some((x) => m(x, p, k))
      case 'group': {
        if (!n.cap) return m(n.body, p, k)
        return m(n.body, p, (q) => {
          const prev = caps[n.cap]
          caps[n.cap] = [p, q]
          if (k(q)) return true
          caps[n.cap] = prev
          return false
        })
      }
      case 'rep': {
        if (n.body.k === 'atom') {
          // a single-character body: the real engines loop here without recursion, then give characters back one by one
          const ends = [p]
          let q = p
          while (ends.length - 1 < n.max) {
            const c = charAt(q)
            if (!c || !n.body.re.test(c)) break
            tick()
            q += c.length
            ends.push(q)
          }
          const count = ends.length - 1
          if (count < n.min) return false
          if (n.lazy) {
            for (let j = n.min; j <= count; j++) if ((tick(), k(ends[j]))) return true
          } else {
            for (let j = count; j >= n.min; j--) if ((tick(), k(ends[j]))) return true
          }
          return false
        }
        const loop = (count: number, q: number): boolean => {
          const more = () => count < n.max && m(n.body, q, (r) => (r === q && count >= n.min ? false : loop(count + 1, r)))
          const stop = () => count >= n.min && k(q)
          return n.lazy ? stop() || more() : more() || stop()
        }
        return loop(0, p)
      }
      case 'bol':
        return p === 0 && k(p)
      case 'eol':
        return p === text.length && k(p)
      case 'wb':
        return word(p - 1) !== word(p) !== n.neg && k(p)
      case 'ref': {
        const c = caps[n.n || names.get(n.name) || 0]
        const s = c ? text.slice(c[0], c[1]) : ''
        const t = text.slice(p, p + s.length)
        return (ignoreCase ? t.toLowerCase() === s.toLowerCase() : t === s) && k(p + s.length)
      }
      case 'look': {
        // lookbehind is taken as always true: it only reads text already passed and costs little
        if (n.behind) return k(p)
        const hit = m(n.body, p, () => true)
        return hit !== n.neg && k(p)
      }
    }
  }

  let end = -1
  for (let s = from; s <= text.length && end < 0; s++) {
    caps.length = 0
    m(root, s, (q) => ((end = q), true))
  }
  return end
}

/** what was found of the patterns asked about: safe, not modeled, or the tree to replay */
const seen = new Map<string, ReturnType<typeof parse> | 'safe' | 'unmodeled'>()

/**
 * Would running `re` (a pattern already accepted by the native engine) over `text` take unreasonably long? `all`: the
 * caller goes through every match, not only the first one.
 */
export function regexTooCostly(re: RegExp, text: string, all: boolean): boolean {
  // (a column of cells asks for the same pattern again and again: it is read once)
  const flags = re.flags.replace(/[gy]/g, '')
  const key = flags + '/' + re.source
  let parsed = seen.get(key)
  if (parsed === undefined) {
    try {
      const p = parse(re.source, flags)
      parsed = risky(p.root) ? p : 'safe'
    } catch {
      parsed = 'unmodeled'
    }
    if (seen.size >= 256) seen.clear()
    seen.set(key, parsed)
  }
  if (parsed === 'unmodeled') return text.length > UNMODELED_TEXT_LIMIT
  if (parsed === 'safe') return false
  const steps = { n: 0 }
  try {
    let from = 0
    while (from <= text.length) {
      const end = simulate(parsed.root, text, re.unicode, re.ignoreCase, parsed.names, from, steps)
      if (end < 0 || !all) break
      from = Math.max(end, from + 1)
    }
    return false
  } catch (e) {
    // the budget, or a stack overflow on a very long text: either way the native engine is not trusted with it
    if (e instanceof OverBudget || e instanceof RangeError) return true
    throw e
  }
}
