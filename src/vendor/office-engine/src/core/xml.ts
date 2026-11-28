/**
 * Minimal streaming XML tokenizer tailored to OOXML (works inside Web Workers,
 * where DOMParser is unavailable). Element names are reduced to local names;
 * attributes too, except relationship-namespace ones which become `r:<local>`.
 */
import { dict } from './dict'

export type Attrs = Record<string, string>

export interface SaxHandler {
  /** Return `true` to skip the element's whole subtree (no `close` is emitted then). */
  open(name: string, attrs: Attrs, selfClosing: boolean): boolean | void
  close(name: string): void
  text(text: string): void
}

const REL_NS = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
])

const ENTITIES: Record<string, string> = dict({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })

export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e] ?? m
  })
}

const isWs = (c: number) => c === 32 || c === 9 || c === 10 || c === 13

/**
 * Elements inside one another, at most: far more than a document nests (tables in tables in text boxes stay under a
 * hundred), and few enough for the code that walks a tree by calling itself. A file nested deeper is refused with an
 * error, instead of running out of stack somewhere later.
 */
export const MAX_XML_DEPTH = 1024

export const tooDeep = () => new Error(`XML nested deeper than ${MAX_XML_DEPTH} elements`)

/** characters an unfinished tag may run to before the file is refused (a tag is held whole: its attributes are read together) */
const MAX_XML_TAG = 16 * 1024 * 1024

export class SaxParser {
  /** what of the last chunk waits for the next one: the start of a token, a few characters at most */
  private buf = ''
  private depth = 0
  private skipDepth = -1
  private relPrefixes = new Set<string>(['r'])
  /**
   * Inside a comment, a processing instruction, a declaration or a CDATA section that ends in a later chunk: what
   * ends it. Its content is passed on (or dropped) chunk by chunk, never held: a comment of 300 MB costs nothing.
   */
  private until = ''
  private cdata = false
  /**
   * A tag that ends in a later chunk: its pieces so far, joined when the end comes (so it is read once, however many
   * chunks it spans), their length, and the quote its end is looked for inside.
   */
  private tag: string[] | null = null
  private tagLen = 0
  private tagQuote = 0
  private tagQuoted = false

  /**
   * @param raw optional tap receiving every consumed source segment verbatim (tags, text, comments…),
   *   called right before the matching handler event. Used for byte-preserving rewrites. A long text or comment
   *   comes in several segments.
   */
  constructor(
    private h: SaxHandler,
    private raw?: (segment: string) => void,
  ) {}

  write(chunk: string): void {
    if (!chunk) return
    if (this.tag) {
      // only the new characters are looked at, for the end of the tag
      if (this.tagEnd(chunk) < 0) {
        this.tag.push(chunk)
        this.tagLen += chunk.length
        if (this.tagLen > MAX_XML_TAG) throw new Error(`XML tag longer than ${MAX_XML_TAG >> 20} MB`)
        return
      }
      chunk = this.tag.join('') + chunk
      this.tag = null
    } else if (this.buf) chunk = this.buf + chunk
    this.buf = ''
    this.run(chunk, false)
  }

  end(): void {
    const s = this.buf
    this.buf = ''
    this.run(s, true)
    this.buf = ''
    this.until = ''
    this.cdata = false
    this.tag = null
  }

  /** index of the `>` that ends the unfinished tag in `chunk`, -1 when it is not there (the quote state moves on) */
  private tagEnd(chunk: string): number {
    if (!this.tagQuoted) return chunk.indexOf('>')
    let q = this.tagQuote
    for (let j = 0; j < chunk.length; j++) {
      const cc = chunk.charCodeAt(j)
      if (q !== 0) {
        if (cc === q) q = 0
      } else if (cc === 34 || cc === 39) q = cc
      else if (cc === 62) return j
    }
    this.tagQuote = q
    return -1
  }

  /** the tag starting at `lt` does not end in `s`: it is held until it does */
  private holdTag(s: string, lt: number, quote: number, quoted: boolean) {
    this.tag = [s.substring(lt)]
    this.tagLen = s.length - lt
    this.tagQuote = quote
    this.tagQuoted = quoted
    if (this.tagLen > MAX_XML_TAG) throw new Error(`XML tag longer than ${MAX_XML_TAG >> 20} MB`)
  }

  /**
   * The comment / processing instruction / declaration / CDATA section opened at `lt` (its opening `open` characters
   * long) does not end in `s`: what is there of it is passed on, less the characters its end may start with.
   */
  private enter(s: string, lt: number, open: number, until: string, cdata: boolean) {
    const n = s.length
    const keep = Math.min(n - lt - open, until.length - 1)
    this.raw?.(s.substring(lt, n - keep))
    if (cdata && this.skipDepth < 0 && n - keep > lt + open) this.h.text(s.substring(lt + open, n - keep))
    this.buf = s.substring(n - keep)
    this.until = until
    this.cdata = cdata
  }

  private run(s: string, final: boolean) {
    const n = s.length
    let i = 0
    if (this.until) {
      const until = this.until
      const e = s.indexOf(until)
      const cdata = this.cdata
      if (e < 0) {
        // not yet: on with it, less the characters its end may start with
        const keep = final ? 0 : Math.min(n, until.length - 1)
        if (n > keep) {
          const seg = s.substring(0, n - keep)
          this.raw?.(seg)
          if (cdata && this.skipDepth < 0) this.h.text(seg)
        }
        this.buf = s.substring(n - keep)
        return
      }
      this.raw?.(s.substring(0, e + until.length))
      if (cdata && this.skipDepth < 0 && e > 0) this.h.text(s.substring(0, e))
      this.until = ''
      this.cdata = false
      i = e + until.length
    }
    while (i < n) {
      const lt = s.indexOf('<', i)
      if (lt < 0) {
        // Text is passed on as it comes (a run of it is not held until its end: it may be the whole file), less a
        // character reference that may be cut by the end of the chunk.
        let cut = n
        if (!final) {
          const amp = s.lastIndexOf('&')
          if (amp >= i && amp >= n - 16 && s.indexOf(';', amp) < 0) cut = amp
        }
        if (cut > i) {
          const seg = s.substring(i, cut)
          this.raw?.(seg)
          this.onText(seg)
        }
        i = cut
        break
      }
      if (lt > i) {
        const seg = s.substring(i, lt)
        this.raw?.(seg)
        this.onText(seg)
      }
      i = lt
      if (lt + 1 >= n) break
      const c = s.charCodeAt(lt + 1)
      if (c === 47) {
        const gt = s.indexOf('>', lt + 2)
        if (gt < 0) {
          if (!final) this.holdTag(s, lt, 0, false)
          i = n
          break
        }
        this.raw?.(s.substring(lt, gt + 1))
        this.onClose(s.substring(lt + 2, gt))
        i = gt + 1
        continue
      }
      if (c === 63) {
        const e = s.indexOf('?>', lt + 2)
        if (e < 0) {
          if (!final) this.enter(s, lt, 2, '?>', false)
          return
        }
        this.raw?.(s.substring(lt, e + 2))
        i = e + 2
        continue
      }
      if (c === 33) {
        if (n - lt < 9 && !final) break
        if (s.startsWith('<!--', lt)) {
          const e = s.indexOf('-->', lt + 4)
          if (e < 0) {
            if (!final) this.enter(s, lt, 4, '-->', false)
            return
          }
          this.raw?.(s.substring(lt, e + 3))
          i = e + 3
          continue
        }
        if (s.startsWith('<![CDATA[', lt)) {
          const e = s.indexOf(']]>', lt + 9)
          if (e < 0) {
            if (!final) this.enter(s, lt, 9, ']]>', true)
            return
          }
          this.raw?.(s.substring(lt, e + 3))
          if (this.skipDepth < 0) this.h.text(s.substring(lt + 9, e))
          i = e + 3
          continue
        }
        const e = s.indexOf('>', lt + 2)
        if (e < 0) {
          if (!final) this.enter(s, lt, 2, '>', false)
          return
        }
        this.raw?.(s.substring(lt, e + 1))
        i = e + 1
        continue
      }
      let gt = -1
      let q = 0
      for (let j = lt + 1; j < n; j++) {
        const cc = s.charCodeAt(j)
        if (q !== 0) {
          if (cc === q) q = 0
        } else if (cc === 34 || cc === 39) q = cc
        else if (cc === 62) {
          gt = j
          break
        }
      }
      if (gt < 0) {
        if (!final) this.holdTag(s, lt, q, true)
        i = n
        break
      }
      this.raw?.(s.substring(lt, gt + 1))
      this.onOpen(s, lt + 1, gt)
      i = gt + 1
    }
    this.buf = i >= n ? '' : s.substring(i)
  }

  private onText(raw: string) {
    if (this.skipDepth >= 0 || this.depth === 0) return
    this.h.text(raw.indexOf('&') >= 0 ? decodeEntities(raw) : raw)
  }

  private onOpen(s: string, start: number, end: number) {
    let stop = end
    let self = false
    if (s.charCodeAt(end - 1) === 47) {
      self = true
      stop = end - 1
    }
    if (this.skipDepth >= 0) {
      if (!self && ++this.depth > MAX_XML_DEPTH) throw tooDeep()
      return
    }
    let k = start
    while (k < stop && !isWs(s.charCodeAt(k))) k++
    const qname = s.substring(start, k)
    const colon = qname.indexOf(':')
    const name = colon < 0 ? qname : qname.substring(colon + 1)
    const attrs: Attrs = {}
    while (k < stop) {
      if (isWs(s.charCodeAt(k))) {
        k++
        continue
      }
      const eq = s.indexOf('=', k)
      if (eq < 0 || eq >= stop) break
      let an = s.substring(k, eq).trim()
      let v = eq + 1
      while (v < stop && s.charCodeAt(v) !== 34 && s.charCodeAt(v) !== 39) v++
      if (v >= stop) break
      const ve = s.indexOf(s[v], v + 1)
      if (ve < 0) break
      const raw = s.substring(v + 1, ve)
      k = ve + 1
      const ac = an.indexOf(':')
      if (ac >= 0) {
        const pfx = an.substring(0, ac)
        const local = an.substring(ac + 1)
        if (pfx === 'xmlns') {
          if (REL_NS.has(raw)) this.relPrefixes.add(local)
          continue
        }
        an = this.relPrefixes.has(pfx) ? 'r:' + local : local
      } else if (an === 'xmlns') continue
      attrs[an] = raw.indexOf('&') >= 0 ? decodeEntities(raw) : raw
    }
    const skip = this.h.open(name, attrs, self)
    if (self) {
      if (!skip) this.h.close(name)
      return
    }
    if (++this.depth > MAX_XML_DEPTH) throw tooDeep()
    if (skip) this.skipDepth = this.depth
  }

  private onClose(qname: string) {
    if (this.skipDepth >= 0) {
      if (this.depth === this.skipDepth) this.skipDepth = -1
      this.depth--
      return
    }
    this.depth--
    const t = qname.trim()
    const colon = t.indexOf(':')
    this.h.close(colon < 0 ? t : t.substring(colon + 1))
  }
}

export class AbortedError extends Error {
  constructor() {
    super('aborted')
    this.name = 'AbortError'
  }
}

export interface StreamParseOptions {
  signal?: AbortSignal
  /** verbatim source tap, see SaxParser */
  raw?: (segment: string) => void
  /** Called after each chunk (decompressed byte count); may return a promise to yield. */
  onChunk?: (bytes: number) => void | Promise<void>
}

/**
 * How a part is encoded: the byte order mark, else the first bytes of "<?" as UTF-16 (XML 1.0 appendix F), else a
 * single-byte encoding the declaration names, else UTF-8. The common case costs two comparisons.
 */
export function xmlEncoding(b: Uint8Array): string {
  const a = b[0]
  const c = b[1]
  if (a === 0xff && c === 0xfe) return 'utf-16le'
  if (a === 0xfe && c === 0xff) return 'utf-16be'
  if (a === 0x3c && c === 0) return 'utf-16le'
  if (a === 0 && c === 0x3c) return 'utf-16be'
  if (a !== 0x3c || c !== 0x3f) return 'utf-8'
  let head = ''
  for (let i = 0; i < b.length && i < 200 && b[i] !== 0x3e; i++) head += String.fromCharCode(b[i])
  const label = /encoding\s*=\s*["']([A-Za-z][\w.:-]*)["']/.exec(head)?.[1].toLowerCase()
  // the bytes are 8-bit here: a "UTF-16" declaration over them is wrong, and UTF-8 is what they are
  if (!label || label === 'utf-8' || label === 'utf8' || label.startsWith('utf-1') || label.startsWith('utf-3')) return 'utf-8'
  try {
    new TextDecoder(label)
    return label
  } catch {
    return 'utf-8'
  }
}

/** the text of a part: any encoding XML allows (the byte order mark is dropped) */
export function decodeXml(b: Uint8Array): string {
  return new TextDecoder(xmlEncoding(b)).decode(b)
}

/** a part written out as UTF-8 must not declare another encoding */
export function utf8Declaration(xml: string): string {
  if (xml.charCodeAt(0) !== 0x3c || xml.charCodeAt(1) !== 0x3f) return xml
  return xml.replace(/^(<\?xml[^>]*?\bencoding\s*=\s*)(["'])(?!utf-8\2)[^"']*\2/i, '$1$2UTF-8$2')
}

export async function parseXmlStream(stream: ReadableStream<Uint8Array>, h: SaxHandler, opts: StreamParseOptions = {}): Promise<void> {
  const reader = stream.getReader()
  let dec: TextDecoder | undefined
  // the start of the part, held until there is enough of it to tell the encoding
  let head: Uint8Array | undefined
  const p = new SaxParser(h, opts.raw)
  try {
    for (;;) {
      if (opts.signal?.aborted) throw new AbortedError()
      const { done, value } = await reader.read()
      if (done) break
      let chunk = value
      if (!dec) {
        if (head) {
          const all = new Uint8Array(head.length + value.length)
          all.set(head)
          all.set(value, head.length)
          chunk = all
        }
        if (chunk.length < 200) {
          head = chunk
          if (opts.onChunk) await opts.onChunk(value.length)
          continue
        }
        head = undefined
        dec = new TextDecoder(xmlEncoding(chunk))
      }
      p.write(dec.decode(chunk, { stream: true }))
      if (opts.onChunk) await opts.onChunk(value.length)
    }
    if (!dec) dec = new TextDecoder(xmlEncoding(head ?? new Uint8Array(0)))
    if (head) p.write(dec.decode(head, { stream: true }))
    p.write(dec.decode())
    p.end()
  } catch (e) {
    reader.cancel().catch(() => {})
    throw e
  }
}

// ---------------------------------------------------------------------------
// Lightweight element tree

export interface XEl {
  n: string
  a: Attrs
  c: XEl[]
  t: string
}

const TRANSPARENT = 0
const SHALLOW = 1
type Frame = XEl | typeof TRANSPARENT | typeof SHALLOW

export interface TreeBuilderOptions {
  /** When set, elements at this depth are built and emitted one by one; ancestors are not kept. */
  emitDepth?: number
  onElement?: (el: XEl) => void
  onShallowOpen?: (name: string, attrs: Attrs, depth: number) => void
  /** Element local names whose subtree is dropped. */
  skip?: Set<string>
  /**
   * Namespace prefixes a reader understands: an mc:Choice is taken only when everything it `Requires` is in the set,
   * else the mc:Fallback is (content the reader cannot model stays out of the tree, and its source with it).
   * Unset: the first mc:Choice always wins.
   */
  understood?: ReadonlySet<string>
}

/** What a docx reader models of the markup Word 365 hides in mc:Choice: drawings, shapes, groups, newer drawing / run extensions. */
export const DOCX_UNDERSTOOD: ReadonlySet<string> = new Set(['wps', 'wpg', 'wpc', 'wpi', 'wp14', 'w14', 'w15', 'a14', 'a16'])

/** whether every namespace an mc:Choice `Requires` (space separated prefixes) is understood */
export function choiceUnderstood(requires: string | undefined, understood: ReadonlySet<string>): boolean {
  const names = (requires ?? '').split(/\s+/).filter(Boolean)
  return names.length > 0 && names.every((x) => understood.has(x))
}

/** Builds XEl trees; resolves mc:AlternateContent by taking the first mc:Choice (see `understood`). */
export class TreeBuilder implements SaxHandler {
  root: XEl | null = null
  private stack: Frame[] = []
  private parents: XEl[] = []
  private depth = 0
  private alt: boolean[] = []

  constructor(private o: TreeBuilderOptions = {}) {}

  open(name: string, a: Attrs): boolean | void {
    if (this.o.skip?.has(name)) return true
    if (name === 'Fallback') {
      // the fallback stands in when no choice was understood
      if (this.o.understood && this.alt.length && !this.alt[this.alt.length - 1]) {
        this.alt[this.alt.length - 1] = true
        this.stack.push(TRANSPARENT)
        return
      }
      return true
    }
    if (name === 'AlternateContent') {
      // the element holding it is marked: what the reader does not model of it must still be kept
      const holder = this.parents[this.parents.length - 1]
      if (holder && this.o.understood) holder.a['#mc'] = '1'
      this.alt.push(false)
      this.stack.push(TRANSPARENT)
      return
    }
    if (name === 'Choice' && this.alt.length) {
      const top = this.alt.length - 1
      if (this.alt[top] || (this.o.understood && !choiceUnderstood(a.Requires, this.o.understood))) return true
      this.alt[top] = true
      this.stack.push(TRANSPARENT)
      return
    }
    const d = this.depth++
    if (this.o.emitDepth !== undefined && d < this.o.emitDepth) {
      this.o.onShallowOpen?.(name, a, d)
      this.stack.push(SHALLOW)
      return
    }
    const el: XEl = { n: name, a, c: [], t: '' }
    const parent = this.parents[this.parents.length - 1]
    if (parent) parent.c.push(el)
    this.parents.push(el)
    this.stack.push(el)
  }

  close(name: string): void {
    const top = this.stack.pop()
    if (top === TRANSPARENT) {
      if (name === 'AlternateContent') this.alt.pop()
      return
    }
    this.depth--
    if (top === SHALLOW || top === undefined) return
    this.parents.pop()
    if (this.parents.length === 0) {
      if (this.o.emitDepth !== undefined) this.o.onElement?.(top)
      else this.root = top
    }
  }

  text(t: string): void {
    const p = this.parents[this.parents.length - 1]
    if (p) p.t += t
  }
}

export function parseXml(xml: string, skip?: Set<string>, understood?: ReadonlySet<string>): XEl {
  const tb = new TreeBuilder({ skip, understood })
  const p = new SaxParser(tb)
  p.write(xml)
  p.end()
  if (!tb.root) throw new Error('Empty XML document')
  return tb.root
}

// ---------------------------------------------------------------------------
// Tree helpers

export function kid(el: XEl | undefined, name: string): XEl | undefined {
  if (!el) return undefined
  for (const c of el.c) if (c.n === name) return c
  return undefined
}

export function kids(el: XEl | undefined, name: string): XEl[] {
  return el ? el.c.filter((c) => c.n === name) : []
}

export function path(el: XEl | undefined, ...names: string[]): XEl | undefined {
  let cur = el
  for (const n of names) {
    cur = kid(cur, n)
    if (!cur) return undefined
  }
  return cur
}

export function desc(el: XEl | undefined, name: string): XEl | undefined {
  if (!el) return undefined
  for (const c of el.c) {
    if (c.n === name) return c
    const r = desc(c, name)
    if (r) return r
  }
  return undefined
}

export function descAll(el: XEl | undefined, name: string, out: XEl[] = []): XEl[] {
  if (!el) return out
  for (const c of el.c) {
    if (c.n === name) out.push(c)
    else descAll(c, name, out)
  }
  return out
}

export function num(v: string | undefined, def?: number): number | undefined {
  if (v === undefined || v === '') return def
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}

/** OOXML on/off value: absent element → undefined, `<x/>` → true. */
export function onOff(el: XEl | undefined, attr = 'val'): boolean | undefined {
  if (!el) return undefined
  const v = el.a[attr]
  if (v === undefined) return true
  return !(v === '0' || v === 'false' || v === 'off' || v === 'none')
}

export function textOf(el: XEl | undefined): string {
  if (!el) return ''
  if (!el.c.length) return el.t
  let s = ''
  for (const c of el.c) s += c.n === 't' ? c.t : textOf(c)
  return s
}
