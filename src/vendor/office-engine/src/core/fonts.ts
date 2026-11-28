import { dict } from './dict'
import type { Block, DocxMeta } from './docx/types'

/** Maps Office font names to CSS stacks with metric-compatible fallbacks. */
const ALIASES: Record<string, string> = dict({
  calibri: 'Carlito',
  cambria: 'Caladea',
  arial: '"Liberation Sans", Arimo',
  helvetica: '"Liberation Sans", Arimo',
  'times new roman': '"Liberation Serif", Tinos',
  'courier new': '"Liberation Mono", Cousine',
  'segoe ui': 'system-ui',
  'calibri light': 'Carlito',
  aptos: '"Segoe UI", system-ui',
  'aptos display': '"Segoe UI", system-ui',
})

const SERIF = /times|cambria|georgia|garamond|book|serif|palatino|minion|baskerville|didot|caslon|mincho|song/i
const MONO = /courier|mono|consolas|menlo|code/i

const cache = new Map<string, string>()

export function cssFont(name: string | undefined): string | undefined {
  if (!name) return undefined
  let v = cache.get(name)
  if (v) return v
  const lower = name.toLowerCase()
  const generic = MONO.test(name) ? 'monospace' : SERIF.test(name) && !/sans/i.test(name) ? 'serif' : 'sans-serif'
  const alias = ALIASES[lower]
  // the name is quoted for CSS: without what would end the quote early (a quote, a backslash, a line break)
  v = `"${name.replace(/["\\\u0000-\u001f]/g, '')}"${alias ? ', ' + alias : ''}, ${generic}`
  cache.set(name, v)
  return v
}

/**
 * A font file the host supplies (DocViewer's `fonts`). Fonts are never taken from a document: its font names only
 * pick among these. Plain data (a URL string or the bytes), so the same list can be handed to a worker.
 */
export interface FontSource {
  /**
   * The family text asks for: a document's own name (`Calibri`), used before an installed font of that name, or the
   * metric-compatible one the stack names after it (`Carlito`, `Caladea`, `Liberation Sans`…), used where the
   * original is not installed.
   */
  family: string
  /** The file (TTF, OTF, WOFF, WOFF2): a URL, resolved against the page, or its bytes. */
  src: string | ArrayBuffer | ArrayBufferView | Blob
  /** CSS font-weight of the file: `400`, `700`, `'bold'`, `'100 900'` (a variable font). Default normal. */
  weight?: number | string
  /** CSS font-style of the file: `'normal'`, `'italic'`, `'oblique'`. Default normal. */
  style?: string
  /** CSS unicode-range: the characters the file covers, when a family comes in several files. */
  unicodeRange?: string
}

/** a family name as CSS compares it: unquoted, spaces collapsed, ASCII case folded */
export function familyKey(name: string): string {
  return name
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2')
    .replace(/\s+/g, ' ')
    .replace(/[A-Z]+/g, (c) => c.toLowerCase())
}

const lists = new Map<string, string[]>()

/** the families (by `familyKey`) of a CSS font-family list, such as the stacks `cssFont()` builds */
export function fontFamilies(stack: string): string[] {
  let v = lists.get(stack)
  if (v) return v
  v = []
  let cur = ''
  let quote = ''
  const end = () => {
    const k = familyKey(cur)
    if (k) v!.push(k)
    cur = ''
  }
  for (const ch of stack) {
    if (quote) {
      if (ch === quote) quote = ''
      else cur += ch
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === ',') end()
    else cur += ch
  }
  end()
  if (lists.size > 1000) lists.clear()
  lists.set(stack, v)
  return v
}

/**
 * The declared fonts text in these stacks can use: those of a family a stack names. With the stacks `cssFont()`
 * builds, a font declared as `Carlito` serves a document in Calibri, and one declared as `Calibri` too.
 */
export function fontsFor<T extends { family: string }>(fonts: readonly T[], stacks: Iterable<string>): T[] {
  if (!fonts.length) return []
  const named = new Set<string>()
  for (const s of stacks) for (const f of fontFamilies(s)) named.add(f)
  return fonts.filter((f) => named.has(familyKey(f.family)))
}

/** the FontFace descriptors of a declared font (what it leaves out is CSS's default) */
export function faceDescriptors(f: Pick<FontSource, 'weight' | 'style' | 'unicodeRange'>): FontFaceDescriptors {
  const d: FontFaceDescriptors = {}
  if (f.weight !== undefined && f.weight !== '') d.weight = String(f.weight)
  if (f.style) d.style = f.style
  if (f.unicodeRange) d.unicodeRange = f.unicodeRange
  return d
}

/** the family name given to a FontFace: without what `cssFont()` leaves out of a name, so the two agree */
export const faceFamily = (family: string) => family.trim().replace(/^(["'])(.*)\1$/, '$2').replace(/["\\\u0000-\u001f]/g, '')

/** `url("…")` for a FontFace source: the address quoted, what would end the quote or the value escaped */
export const cssUrl = (url: string) => `url("${url.replace(/["\\\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}")`

/** the CSS font stacks text of these DOCX blocks is set in: runs, list markers, empty paragraphs, cells, text boxes */
export function docxFonts(blocks: Iterable<Block>, into = new Set<string>()): Set<string> {
  const walk = (b: Block) => {
    if (b.t === 'p') {
      if (b.markFont) into.add(b.markFont)
      if (b.marker?.s.font) into.add(b.marker.s.font)
      for (const x of b.runs) {
        if (x.t === 'box') x.blocks.forEach(walk)
        else if ((x.t === 'text' || x.t === 'field' || x.t === 'ref') && x.s.font) into.add(x.s.font)
      }
    } else if (b.t === 'tbl') for (const r of b.rows) for (const c of r.cells) c.blocks.forEach(walk)
  }
  for (const b of blocks) walk(b)
  return into
}

/** …and of what every page shows: the body's default font, headers and footers */
export function docxPageFonts(meta: DocxMeta, into = new Set<string>()): Set<string> {
  if (meta.font) into.add(meta.font)
  for (const part of [meta.header, meta.footer, meta.firstHeader, meta.firstFooter, meta.evenHeader, meta.evenFooter]) if (part) docxFonts(part, into)
  return into
}
