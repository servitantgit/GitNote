/**
 * Graphviz DOT: graphs, digraphs, subgraphs and clusters, default attributes, edge chains, rank=same, record and
 * HTML-like labels (as text). Laid out by the layered layout, like `dot`.
 * https://graphviz.org/doc/info/lang.html
 */
import { GraphBuilder, renderGraph, type Dir, type GEdge, type GNode, type Graph, type Head, type NodeStyle, type Rendered, type Section, type Shape } from './graph'
import { color, DiagramError, labelText } from './svg'
import { dict } from '../dict'

type Tok = { t: 'id' | 'str' | 'html' | 'p'; v: string; pos: number }

/** a syntax error, with the 1-based line of the character at `pos` */
function dotError(src: string, pos: number, what: string): DiagramError {
  let line = 1
  for (let k = src.indexOf('\n'); k >= 0 && k < pos; k = src.indexOf('\n', k + 1)) line++
  return new DiagramError(`Graphviz DOT, line ${line}: ${what}`)
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  const n = src.length
  let i = 0
  let lineStart = true
  while (i < n) {
    const c = src[i]
    if (c === '\n') {
      lineStart = true
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '﻿') {
      i++
      continue
    }
    if (lineStart && c === '#') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    lineStart = false
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2)
      if (e < 0) throw dotError(src, i, 'unterminated comment')
      i = e + 2
      continue
    }
    if (c === '"') {
      let v = ''
      const at = i
      i++
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && src[i + 1] === '"') {
          v += '"'
          i += 2
        } else if (src[i] === '\\' && src[i + 1] === '\n') i += 2
        else v += src[i++]
      }
      if (i >= n) throw dotError(src, at, 'unterminated string')
      i++
      // "a" + "b"
      const prev = out[out.length - 1]
      const plus = out[out.length - 2]
      if (prev?.t === 'p' && prev.v === '+' && plus?.t === 'str') {
        out.pop()
        plus.v += v
      } else out.push({ t: 'str', v, pos: at })
      continue
    }
    if (c === '<') {
      let depth = 0
      const s = i
      for (; i < n; i++) {
        if (src[i] === '<') depth++
        else if (src[i] === '>' && --depth === 0) break
      }
      if (i >= n) throw dotError(src, s, 'unterminated <…> label')
      out.push({ t: 'html', v: src.slice(s + 1, i), pos: s })
      i++
      continue
    }
    if (c === '-' && (src[i + 1] === '>' || src[i + 1] === '-')) {
      out.push({ t: 'p', v: src.slice(i, i + 2), pos: i })
      i += 2
      continue
    }
    if ('{}[]=;,:+'.includes(c)) {
      out.push({ t: 'p', v: c, pos: i })
      i++
      continue
    }
    const m = /^(-?(?:\.\d+|\d+(?:\.\d*)?)|[A-Za-z_\u0080-￿][\w\u0080-￿]*)/.exec(src.slice(i, i + 256))
    if (!m) throw dotError(src, i, `unexpected “${c}”`)
    out.push({ t: 'id', v: m[0], pos: i })
    i += m[0].length
  }
  return out
}

interface Scope {
  node: Record<string, string>
  edge: Record<string, string>
  cluster?: string
  members: Set<string>
  name?: string
}

const SHAPES: Record<string, Shape> = dict({
  box: 'rect', rect: 'rect', rectangle: 'rect', square: 'rect', msquare: 'rect', ellipse: 'ellipse', oval: 'ellipse', egg: 'ellipse', circle: 'circle',
  doublecircle: 'doublecircle', point: 'point', plaintext: 'none', plain: 'none', none: 'none', underline: 'none', diamond: 'diamond', mdiamond: 'diamond',
  hexagon: 'hexagon', octagon: 'octagon', doubleoctagon: 'octagon', tripleoctagon: 'octagon', triangle: 'triangle', invtriangle: 'triangle', parallelogram: 'lean-r',
  trapezium: 'trap-b', invtrapezium: 'trap-t', house: 'trap-b', invhouse: 'trap-t', cylinder: 'cylinder', note: 'note', tab: 'folder', folder: 'folder', box3d: 'box3d',
  component: 'component', cds: 'flag', larrow: 'flag', rarrow: 'flag', lpromoter: 'flag', rpromoter: 'flag', star: 'circle', record: 'rect', mrecord: 'round', underlinebox: 'rect',
})

const ARROWS: Record<string, Head> = dict({
  normal: 'arrow', inv: 'arrow', empty: 'triangle', onormal: 'triangle', invempty: 'triangle', oinv: 'triangle', vee: 'open', open: 'open', halfopen: 'open',
  diamond: 'diamond', odiamond: 'odiamond', ediamond: 'odiamond', box: 'diamond', obox: 'odiamond', dot: 'circle', odot: 'ocircle', invdot: 'circle', invodot: 'ocircle',
  none: 'none', crow: 'many', tee: 'one', curve: 'open', icurve: 'open',
})

function arrow(v: string | undefined, dflt: Head): Head {
  if (!v) return dflt
  const k = v.toLowerCase().replace(/^[lr](?=[a-z])/, '')
  return ARROWS[k] ?? ARROWS[k.replace(/^o/, '')] ?? dflt
}

/** a Graphviz color: names, #rgb(a), "H S V" or "H,S,V"; the first of a color list */
function dotColor(v: string | undefined): string | undefined {
  if (!v) return undefined
  const first = v.split(/[:;]/)[0].trim()
  const hsv = /^([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)$/.exec(first)
  if (hsv) {
    const [h, s, b] = [Number(hsv[1]), Number(hsv[2]), Number(hsv[3])]
    const f = (k: number) => {
      const x = (k + h * 6) % 6
      return Math.round((b - b * s * Math.max(0, Math.min(x, 4 - x, 1))) * 255)
    }
    return '#' + [f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, '0')).join('')
  }
  const name = first.replace(/^\/\w+\//, '').toLowerCase()
  // X11 grey levels (gray0 … gray100); numbered variants (red3) as their base color
  const g = /^gr[ae]y(\d{1,3})$/.exec(name)
  if (g) {
    const x = Math.round((Math.min(100, Number(g[1])) * 255) / 100)
      .toString(16)
      .padStart(2, '0')
    return `#${x}${x}${x}`
  }
  return color(/^[a-z]+\d+$/.test(name) ? name.replace(/\d+$/, '') : name)
}

function htmlLabel(v: string): string {
  return labelText(
    v
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/td>\s*<td/gi, '  <td')
      .replace(/<[^>]+>/g, '')
      .replace(/\n\s*\n/g, '\n'),
  )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
}

const ENTITIES: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', nbsp: '\u00a0', apos: "'" }

/** Graphviz decodes HTML entities (&lt; &amp; &#38; &#x26; …) in every label before it looks at escapes or record syntax */
function decodeEntities(v: string, record = false): string {
  return v.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (m, d?: string, h?: string, name?: string) => {
    const cp = d ? Number(d) : h ? parseInt(h, 16) : NaN
    const ch = !Number.isNaN(cp) ? (cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m) : ENTITIES[name!] ?? m
    // in a record an entity is text, never syntax: `&lt;` must not open a port
    return record && '{}|<>'.includes(ch) ? `\\${ch}` : ch
  })
}

/** text of a plain label: \n \l \r line breaks, \N the node name */
function plainLabel(v: string, id: string, graph = ''): string {
  return decodeEntities(v)
    .replace(/\\[nlr]/g, '\n')
    .replace(/\\N/g, id)
    .replace(/\\G/g, graph)
    .replace(/\\(.)/g, '$1')
    .replace(/\n$/, '')
}

/** a record label's field tree: a string is a cell, an array a `{ }` group (which runs the other way) */
type RecField = string | RecField[]

/**
 * "<f0> a|{b|<p> c}|": every `|` makes a field even when it is empty, `<port>` is dropped, `{ }` nests, and
 * `\{ \} \| \< \>` and `\ ` escape. Entities are decoded first, as Graphviz does.
 */
function parseRecord(v: string, id: string): RecField[] {
  const s = decodeEntities(v, true)
  const SP = '\ue000' // an escaped space survives trimming
  let i = 0
  const level = (): RecField[] => {
    const out: RecField[] = []
    let text = ''
    let group: RecField[] | null = null
    const end = () => {
      out.push(group ?? text.replace(/^[ \t]+|[ \t]+$/g, '').split(SP).join(' '))
      text = ''
      group = null
    }
    while (i < s.length) {
      const c = s[i++]
      if (c === '\\' && i < s.length) {
        const e = s[i++]
        text += e === 'n' || e === 'l' || e === 'r' ? '\n' : e === 'N' ? id : e === ' ' ? SP : e
      } else if (c === '{') group = level()
      else if (c === '}') break
      else if (c === '|') end()
      else if (c === '<') {
        const close = s.indexOf('>', i)
        i = close < 0 ? s.length : close + 1
      } else if (!group) text += c
    }
    end()
    return out
  }
  return level()
}

const recLines = (f: RecField): string[] => (typeof f === 'string' ? f.split('\n') : f.flatMap(recLines))

/** fields side by side (a row of cells, taller cells spilling over several rows) or stacked (one section each) */
function recordSections(fields: RecField[], across: boolean): Section[] {
  if (!across) return fields.flatMap((f) => (typeof f === 'string' ? [{ rows: f.split('\n').map((t) => [t]), center: true }] : recordSections(f, true)))
  const cols = fields.map(recLines)
  const height = Math.max(...cols.map((c) => c.length))
  return [{ rows: Array.from({ length: height }, (_, r) => cols.map((c) => c[r] ?? '')), grid: true }]
}

export function parseDot(src: string): Graph[] {
  const toks = tokenize(src)
  let p = 0
  const peek = (k = 0) => toks[p + k]
  const isP = (v: string, k = 0) => peek(k)?.t === 'p' && peek(k).v === v
  const eat = (v: string) => {
    if (isP(v)) {
      p++
      return true
    }
    return false
  }
  const kw = (v: string) => peek()?.t === 'id' && peek().v.toLowerCase() === v
  const graphs: Graph[] = []
  const err = (t: Tok | undefined, what: string) => dotError(src, t?.pos ?? src.length, what)
  while (p < toks.length) {
    const strict = kw('strict')
    if (strict) p++
    if (!kw('graph') && !kw('digraph')) throw err(peek(), `“graph” or “digraph” expected, found “${peek()?.v ?? 'end of text'}”`)
    const directed = peek().v.toLowerCase() === 'digraph'
    p++
    const name = peek()?.t !== 'p' ? toks[p++].v : ''
    if (!eat('{')) throw err(peek(), '“{” expected after the graph name')
    const b = new GraphBuilder('TB', 'ellipse')
    const nodeAttrs = new Map<string, Record<string, string>>()
    const edges: { e: GEdge; attrs: Record<string, string> }[] = []
    const same: string[][] = []
    let anon = 0
    const graphAttrs: Record<string, string> = {}
    const clusterAttrs = new Map<string, Record<string, string>>()

    const attrList = (): Record<string, string> => {
      const a: Record<string, string> = {}
      while (eat('[')) {
        const open = toks[p - 1]
        while (p < toks.length && !isP(']')) {
          const k = toks[p++]
          if (k.t === 'p') {
            if (k.v === '}' || k.v === '{' || k.v === '[' || k.v === '->') throw err(k, `“]” expected, found “${k.v}”`)
            continue
          }
          if (eat('=')) {
            const v = toks[p++]
            if (!v || v.t === 'p') throw err(v ?? k, `a value expected after “${k.v} =”`)
            a[k.v.toLowerCase()] = v.t === 'html' ? '<' + v.v + '>' : v.v
          } else a[k.v.toLowerCase()] = 'true'
        }
        if (!eat(']')) throw err(open, '“[” is never closed (“]” expected)')
      }
      return a
    }
    const nodeRef = (scope: Scope): string => {
      const id = toks[p++].v
      // port: a:p or a:p:n
      while (isP(':')) p += 2
      if (!nodeAttrs.has(id)) {
        nodeAttrs.set(id, { ...scope.node })
        b.node(id, {}, scope.cluster)
      } else if (scope.cluster && b.get(id) && b.get(id)!.cluster === undefined) b.get(id)!.cluster = scope.cluster
      scope.members.add(id)
      return id
    }
    const stmts = (scope: Scope) => {
      while (p < toks.length && !isP('}')) {
        if (eat(';') || eat(',')) continue
        const t = peek()
        if (t.t === 'id' && ['graph', 'node', 'edge'].includes(t.v.toLowerCase()) && isP('[', 1)) {
          p++
          const a = attrList()
          const which = t.v.toLowerCase()
          if (which === 'node') Object.assign(scope.node, a)
          else if (which === 'edge') Object.assign(scope.edge, a)
          else setGraph(scope, a)
          continue
        }
        if (t.t !== 'p' && isP('=', 1)) {
          const k = t.v.toLowerCase()
          p += 2
          const v = toks[p++]
          setGraph(scope, { [k]: v ? (v.t === 'html' ? '<' + v.v + '>' : v.v) : '' })
          continue
        }
        // a chain of node ids / subgraphs joined by edge operators
        const ends: string[][] = []
        for (;;) {
          if (kw('subgraph') || isP('{')) ends.push([...subgraph(scope)])
          else if (peek() && peek().t !== 'p') ends.push([nodeRef(scope)])
          else throw ends.length ? err(peek(-1), `a node or subgraph expected after “${peek(-1)?.v}”`) : err(peek(), `unexpected “${peek()?.v ?? 'end of text'}”`)
          if (isP('->') || isP('--')) {
            if (isP('->') !== directed) throw err(peek(), `“${peek().v}” in ${directed ? 'a digraph (use “->”)' : 'an undirected graph (use “--”)'}`)
            p++
          } else break
        }
        const a = attrList()
        if (ends.length === 1) {
          for (const id of ends[0]) if (Object.keys(a).length && nodeAttrs.has(id)) Object.assign(nodeAttrs.get(id)!, a)
          continue
        }
        const attrs = { ...scope.edge, ...a }
        for (let k = 0; k + 1 < ends.length; k++) for (const from of ends[k]) for (const to of ends[k + 1]) edges.push({ e: { from, to }, attrs })
      }
    }
    const setGraph = (scope: Scope, a: Record<string, string>) => {
      if (scope.cluster) Object.assign(clusterAttrs.get(scope.cluster)!, a)
      else if (!scope.name) Object.assign(graphAttrs, a)
      if (a.rank && scope.name !== undefined) (scope as Scope & { rank?: string }).rank = a.rank
    }
    const subgraph = (parent: Scope): Set<string> => {
      let sname: string | undefined
      if (kw('subgraph')) {
        p++
        if (peek() && peek().t !== 'p') sname = toks[p++].v
      }
      const isCluster = !!sname && /^cluster/i.test(sname)
      const scope: Scope & { rank?: string } = { node: { ...parent.node }, edge: { ...parent.edge }, cluster: parent.cluster, members: new Set(), name: sname ?? `__anon${anon++}` }
      if (isCluster) {
        const cid = `${sname}`
        b.cluster(cid, '', parent.cluster)
        clusterAttrs.set(cid, {})
        scope.cluster = cid
      }
      if (eat('{')) {
        const open = toks[p - 1]
        stmts(scope)
        if (!eat('}')) throw err(open, '“{” is never closed (“}” expected)')
      }
      if (scope.rank && /^(same|min|max|source|sink)$/.test(scope.rank) && scope.members.size > 1) same.push([...scope.members])
      for (const m of scope.members) parent.members.add(m)
      return scope.members
    }
    const root: Scope = { node: {}, edge: {}, members: new Set() }
    const open = toks[p - 1]
    stmts(root)
    if (!eat('}')) throw err(open, '“{” is never closed (“}” expected)')

    // attributes → model
    const dir: Dir = ({ LR: 'LR', RL: 'RL', BT: 'BT', TB: 'TB' } as Record<string, Dir>)[(graphAttrs.rankdir ?? 'TB').toUpperCase()] ?? 'TB'
    b.g.dir = dir
    if (graphAttrs.label) b.g.title = graphAttrs.label.startsWith('<') ? htmlLabel(graphAttrs.label.slice(1, -1)) : plainLabel(graphAttrs.label, '', name)
    for (const n of b.g.nodes) applyNode(n, nodeAttrs.get(n.id) ?? {}, dir)
    for (const c of b.g.clusters) {
      const a = clusterAttrs.get(c.id) ?? {}
      c.label = a.label ? (a.label.startsWith('<') ? htmlLabel(a.label.slice(1, -1)) : plainLabel(a.label, '', c.id)) : ''
      const st: NodeStyle = {}
      const style = (a.style ?? '').toLowerCase()
      if (style.includes('filled')) st.fill = dotColor(a.fillcolor ?? a.color ?? a.bgcolor) ?? '#d3d3d3'
      else if (a.bgcolor) st.fill = dotColor(a.bgcolor)
      if (a.color || a.pencolor) st.stroke = dotColor(a.pencolor ?? a.color)
      if (style.includes('dashed')) st.dash = '6 4'
      if (style.includes('dotted')) st.dash = '2 3'
      if (a.fontcolor) st.color = dotColor(a.fontcolor)
      if (style.includes('invis')) st.stroke = st.fill = 'none'
      c.style = st
    }
    // strict: at most one edge between two nodes (undirected: in either order); later attributes win
    const seen = new Map<string, { e: GEdge; attrs: Record<string, string> }>()
    const kept: { e: GEdge; attrs: Record<string, string> }[] = []
    for (const x of edges) {
      if (!strict) {
        kept.push(x)
        continue
      }
      const key = directed || x.e.from <= x.e.to ? `${x.e.from}\0${x.e.to}` : `${x.e.to}\0${x.e.from}`
      const old = seen.get(key)
      if (old) Object.assign(old.attrs, x.attrs)
      else {
        // own copy: a chain shares one attribute object between its edges
        const own = { e: x.e, attrs: { ...x.attrs } }
        seen.set(key, own)
        kept.push(own)
      }
    }
    for (const { e, attrs } of kept) b.g.edges.push(applyEdge(e, attrs, directed))
    b.g.sameRank = same
    graphs.push(b.g)
  }
  if (!graphs.length) throw new DiagramError('No “graph” or “digraph” found')
  return graphs
}

function applyNode(n: GNode, a: Record<string, string>, dir: Dir) {
  const shapeName = (a.shape ?? 'ellipse').toLowerCase()
  n.shape = SHAPES[shapeName] ?? 'ellipse'
  const lab = a.label
  if (lab !== undefined) {
    // a record label may start with a port and end with one ("<f0> a|<f1>"): it is never an HTML label
    if (shapeName !== 'record' && shapeName !== 'mrecord' && lab.startsWith('<') && lab.endsWith('>')) n.label = htmlLabel(lab.slice(1, -1))
    else if (shapeName === 'record' || shapeName === 'mrecord') {
      const fields = parseRecord(lab, n.id)
      n.label = fields.flatMap(recLines).filter(Boolean).join('\n')
      // TB / BT: the top-level fields sit side by side; LR / RL: they are stacked
      let top = fields
      let across = !(dir === 'LR' || dir === 'RL')
      // a lone `{ }` group around everything just flips the direction
      while (top.length === 1 && Array.isArray(top[0])) {
        top = top[0]
        across = !across
      }
      if (top.length > 1) n.sections = recordSections(top, across)
    } else n.label = plainLabel(lab, n.id)
  }
  if (n.shape === 'point') n.label = ''
  const st: NodeStyle = {}
  const style = (a.style ?? '').toLowerCase()
  if (style.includes('filled') || a.fillcolor) st.fill = dotColor(a.fillcolor ?? a.color) ?? '#d3d3d3'
  else if (n.shape !== 'point') st.fill = '#ffffff'
  if (a.color) st.stroke = dotColor(a.color)
  else st.stroke = '#000000'
  if (a.fontcolor) st.color = dotColor(a.fontcolor)
  if (style.includes('dashed')) st.dash = '6 4'
  if (style.includes('dotted')) st.dash = '2 3'
  if (style.includes('bold')) st.sw = 2.4
  if (a.penwidth) st.sw = Math.min(8, Number(a.penwidth) || 1)
  if (style.includes('invis')) st.hidden = true
  if (style.includes('rounded') && n.shape === 'rect') n.shape = 'round'
  if (n.shape === 'none') st.fill = undefined
  n.style = st
}

function applyEdge(e: GEdge, a: Record<string, string>, directed: boolean): GEdge {
  const style = (a.style ?? '').toLowerCase()
  const dir = (a.dir ?? (directed ? 'forward' : 'none')).toLowerCase()
  const head = arrow(a.arrowhead, 'arrow')
  const tail = arrow(a.arrowtail, 'arrow')
  e.head = dir === 'forward' || dir === 'both' ? head : 'none'
  e.tail = dir === 'back' || dir === 'both' ? tail : 'none'
  const lab = a.label ?? a.xlabel
  if (lab) e.label = lab.startsWith('<') && lab.endsWith('>') ? htmlLabel(lab.slice(1, -1)) : plainLabel(lab, '')
  if (a.headlabel) e.headLabel = plainLabel(a.headlabel, '')
  if (a.taillabel) e.tailLabel = plainLabel(a.taillabel, '')
  e.line = style.includes('invis') ? 'hidden' : style.includes('dashed') ? 'dashed' : style.includes('dotted') ? 'dotted' : style.includes('bold') ? 'thick' : 'solid'
  e.color = dotColor(a.color) ?? '#000000'
  if (a.penwidth) e.sw = Math.min(8, Number(a.penwidth) || 1)
  if (a.minlen) e.minlen = Math.max(1, Math.min(6, Math.round(Number(a.minlen)) || 1))
  return e
}

export function renderDot(src: string): Rendered {
  return renderGraph(parseDot(src)[0])
}

export function renderDotAll(src: string): Rendered[] {
  return parseDot(src).map(renderGraph)
}
