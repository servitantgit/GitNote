import { el, getAttr, isNode, kidsOf, parseRaw, rootEl, serialize } from './raw'
import { normalize, ZipArchive } from './zip'
import { rebuildZip, type PartData } from './zipwrite'
import { decodeXml, kids, parseXml, utf8Declaration, type XEl } from './xml'
import { dict } from './dict'

export type DocKind = 'docx' | 'xlsx' | 'pptx'

export interface Rel {
  id: string
  type: string
  target: string
  external: boolean
}

export type Rels = Map<string, Rel>

const MIME: Record<string, string> = dict({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ico: 'image/x-icon',
  emf: 'image/emf',
  wmf: 'image/wmf',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
})

export function mimeOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return MIME[ext] ?? 'application/octet-stream'
}

/** Browser-renderable image? (EMF/WMF/TIFF are not.) */
export function isWebImage(path: string): boolean {
  return /\.(png|jpe?g|jpe|gif|bmp|svg|webp|ico)$/i.test(path)
}

export function dirOf(part: string): string {
  const i = part.lastIndexOf('/')
  return i < 0 ? '' : part.slice(0, i)
}

export function resolvePath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const out = baseDir ? baseDir.split('/') : []
  for (const seg of target.split('/')) {
    if (seg === '..') out.pop()
    else if (seg && seg !== '.') out.push(seg)
  }
  return out.join('/')
}

/** Inverse of resolvePath: target of `abs` relative to directory `fromDir`. */
export function relativeTarget(fromDir: string, abs: string): string {
  const a = fromDir ? fromDir.split('/') : []
  const b = abs.split('/')
  let i = 0
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
}

export function relsPathFor(part: string): string {
  const d = dirOf(part)
  const f = part.slice(d.length ? d.length + 1 : 0)
  return (d ? d + '/' : '') + '_rels/' + f + '.rels'
}

export class OpcPackage {
  private relsCache = new Map<string, Promise<Rels>>()
  private xmlCache = new Map<string, Promise<XEl | undefined>>()
  private contentTypes?: Promise<Map<string, string>>
  /** edited parts: normalized path → { path, data } (data null = deleted) */
  private changes = new Map<string, { path: string; data: PartData | null }>()

  constructor(readonly zip: ZipArchive) {}

  has(path: string) {
    const ch = this.changes.get(normalize(path))
    if (ch) return ch.data !== null
    return this.zip.has(path)
  }

  get dirty(): boolean {
    return this.changes.size > 0
  }

  /** paths of the parts the package holds now (those added in this session with them, those deleted without) */
  paths(): string[] {
    const out = new Map<string, string>()
    for (const e of this.zip.list()) out.set(normalize(e.name), e.name)
    for (const [k, ch] of this.changes) {
      if (ch.data === null) out.delete(k)
      else out.set(k, ch.path)
    }
    return [...out.values()]
  }

  /** Current text of a part (edited version if any). */
  async text(path: string): Promise<string> {
    const ch = this.changes.get(normalize(path))
    if (ch) {
      if (ch.data === null) throw new Error(`Missing part: ${path}`)
      if (typeof ch.data === 'string') return ch.data
      if (ch.data instanceof Uint8Array) return decodeXml(ch.data)
      throw new Error(`Part ${path} is a stream`)
    }
    return this.zip.text(path)
  }

  /** Decompressed stream of the current version of a part (edited parts included). */
  async stream(path: string, onRaw?: (consumed: number, total: number) => void): Promise<ReadableStream<Uint8Array>> {
    const ch = this.changes.get(normalize(path))
    if (!ch) return this.zip.stream(path, onRaw)
    if (ch.data === null) throw new Error(`Missing part: ${path}`)
    if (typeof ch.data === 'function') return ch.data()
    const bytes = typeof ch.data === 'string' ? new TextEncoder().encode(ch.data) : ch.data
    return new ReadableStream({
      start(c) {
        c.enqueue(bytes)
        c.close()
      },
    })
  }

  /** what a part was set to in this session (null: deleted); undefined when it is as read */
  changed(path: string): PartData | null | undefined {
    return this.changes.get(normalize(path))?.data
  }

  setPart(path: string, data: PartData | null): void {
    path = path.replace(/^\/+/, '')
    this.changes.set(normalize(path), { path, data })
    this.xmlCache.delete(path)
    this.relsCache.clear()
    if (/\[content_types\]\.xml$/i.test(path)) this.contentTypes = undefined
  }

  /**
   * Refuses a main part that is not XML: a tool that wrote something else there leaves a blank document, and the
   * garbage would be saved back as the document.
   */
  async assertXml(path: string): Promise<void> {
    const reader = (await this.stream(path)).getReader()
    const first = await reader.read()
    await reader.cancel().catch(() => {})
    const b = first.value ?? new Uint8Array(0)
    let i = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0
    // UTF-16 (a byte order mark) is read by the parts' reader
    if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return
    // (UTF-16 without a mark has a zero byte beside every character)
    while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d || b[i] === 0)) i++
    if (b[i] !== 0x3c) throw new Error(`The file is damaged: its main part “${path}” is ${b.length ? 'not XML' : 'empty'}`)
  }

  /**
   * The format of the package as its main part declares it: a workbook with macros is an .xlsm, a template an .xltx…
   * A file named or typed otherwise is one Excel / Word / PowerPoint refuse to open. Undefined for a plain document.
   */
  async flavor(): Promise<{ ext: string; mime: string } | undefined> {
    const main = await this.mainPart().catch(() => undefined)
    const f = main && FLAVORS[(await this.contentType(main.path)) ?? '']
    return f ? { ext: f[0], mime: f[1] } : undefined
  }

  /** Builds the edited package; unchanged entries are copied without recompression. `type`: of a plain document of its kind. */
  async save(type: string): Promise<Blob> {
    type = (await this.flavor())?.mime ?? type
    await this.ensureContentTypes()
    const m = new Map<string, PartData | null>()
    for (const { path, data } of this.changes.values()) m.set(path, typeof data === 'string' ? utf8Declaration(data) : data)
    return rebuildZip(this.zip, m, type)
  }

  /** Adds a relationship from `part` to `target` (absolute part path); returns its id. */
  async addRel(part: string, type: string, target: string, external = false): Promise<string> {
    const rp = relsPathFor(part)
    const nodes = this.has(rp)
      ? parseRaw(await this.text(rp))
      : parseRaw('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>')
    const root = rootEl(nodes)!
    const ids = new Set(kidsOf(root, 'Relationship').map((r) => getAttr(r, 'Id')))
    let n = ids.size + 1
    while (ids.has(`rId${n}`)) n++
    const id = `rId${n}`
    root.c.push(el('Relationship', external ? { Id: id, Type: type, Target: target, TargetMode: 'External' } : { Id: id, Type: type, Target: relativeTarget(dirOf(part), target) }))
    root.self = false
    this.setPart(rp, serialize(nodes))
    return id
  }

  async removeRelsTo(part: string, target: string): Promise<void> {
    const rp = relsPathFor(part)
    if (!this.has(rp)) return
    const nodes = parseRaw(await this.text(rp))
    const root = rootEl(nodes)!
    const base = dirOf(part)
    root.c = root.c.filter((c) => !(isNode(c) && resolvePath(base, getAttr(c, 'Target') ?? '').toLowerCase() === target.toLowerCase()))
    this.setPart(rp, serialize(nodes))
  }

  /**
   * A package without `[Content_Types].xml` (some tools leave it out) opens, but is not one Office opens: the part is
   * written from what the relationships say each part is, when the package is edited or saved.
   */
  private async ensureContentTypes(): Promise<void> {
    if (this.has('[Content_Types].xml')) return
    const kind = (await this.mainPart()).kind
    const types = new Map<string, string>()
    const seen = new Set<string>([''])
    const queue = ['']
    while (queue.length) {
      const part = queue.pop()!
      for (const r of (await this.rels(part)).values()) {
        if (r.external || seen.has(r.target) || !this.has(r.target)) continue
        seen.add(r.target)
        queue.push(r.target)
        const t = r.type.endsWith('/officeDocument') ? MAIN_TYPE[kind] : (REL_TYPE[kind + ':' + r.type.split('/').pop()] ?? REL_TYPE[r.type.split('/').pop()!])
        if (t) types.set(r.target, t)
      }
    }
    const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
    const exts = new Map<string, string>([['rels', 'application/vnd.openxmlformats-package.relationships+xml'], ['xml', 'application/xml']])
    for (const p of this.paths()) {
      const ext = (p.split('.').pop() ?? '').toLowerCase()
      if (!exts.has(ext) && mimeOf(p) !== 'application/octet-stream') exts.set(ext, mimeOf(p))
      else if (!exts.has(ext) && ext === 'vml') exts.set(ext, 'application/vnd.openxmlformats-officedocument.vmlDrawing')
    }
    const xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      [...exts].map(([e, t]) => `<Default Extension="${esc(e)}" ContentType="${esc(t)}"/>`).join('') +
      [...types].map(([p, t]) => `<Override PartName="/${esc(p)}" ContentType="${esc(t)}"/>`).join('') +
      '</Types>'
    this.setPart('[Content_Types].xml', xml)
  }

  /** Ensures a <Default Extension=…> entry exists (for new media types). */
  async ensureDefaultType(ext: string, contentType: string): Promise<void> {
    await this.ensureContentTypes()
    const ct = '[Content_Types].xml'
    const nodes = parseRaw(await this.text(ct))
    const root = rootEl(nodes)!
    if (kidsOf(root, 'Default').some((d) => getAttr(d, 'Extension')?.toLowerCase() === ext.toLowerCase())) return
    root.c.unshift(el('Default', { Extension: ext, ContentType: contentType }))
    this.setPart(ct, serialize(nodes))
  }

  /** Free part name like `word/media/image7.png`. */
  freeName(dir: string, base: string, ext: string): string {
    for (let i = 1; ; i++) {
      const p = `${dir}/${base}${i}.${ext}`
      if (!this.has(p)) return p
    }
  }

  async setContentType(partName: string, contentType: string | null): Promise<void> {
    await this.ensureContentTypes()
    const ct = '[Content_Types].xml'
    const nodes = parseRaw(await this.text(ct))
    const root = rootEl(nodes)!
    const pn = '/' + partName.replace(/^\/+/, '')
    root.c = root.c.filter((c) => !(isNode(c) && getAttr(c, 'PartName')?.toLowerCase() === pn.toLowerCase()))
    if (contentType) root.c.push(el('Override', { PartName: pn, ContentType: contentType }))
    this.setPart(ct, serialize(nodes))
  }

  /** Parsed XML part (cached). Missing parts resolve to undefined. */
  xml(path: string, cache = true): Promise<XEl | undefined> {
    const load = async () => (this.has(path) ? parseXml(await this.text(path), SKIP_EXT) : undefined)
    if (!cache) return load()
    let p = this.xmlCache.get(path)
    if (!p) this.xmlCache.set(path, (p = load()))
    return p
  }

  rels(part: string): Promise<Rels> {
    let p = this.relsCache.get(part)
    if (!p) {
      p = (async () => {
        const map: Rels = new Map()
        const rp = relsPathFor(part)
        if (!this.has(rp)) return map
        const root = parseXml(await this.text(rp))
        const base = dirOf(part)
        for (const r of kids(root, 'Relationship')) {
          const external = r.a.TargetMode === 'External'
          const target = r.a.Target ?? ''
          map.set(r.a.Id, {
            id: r.a.Id,
            type: r.a.Type ?? '',
            external,
            target: external ? target : resolvePath(base, target),
          })
        }
        return map
      })()
      this.relsCache.set(part, p)
    }
    return p
  }

  async contentType(path: string): Promise<string | undefined> {
    if (!this.contentTypes) {
      this.contentTypes = (async () => {
        const m = new Map<string, string>()
        if (!this.has('[Content_Types].xml')) return m
        const root = parseXml(await this.text('[Content_Types].xml'))
        for (const d of kids(root, 'Default')) m.set('ext:' + (d.a.Extension ?? '').toLowerCase(), d.a.ContentType)
        for (const o of kids(root, 'Override')) m.set((o.a.PartName ?? '').replace(/^\//, '').toLowerCase(), o.a.ContentType)
        return m
      })()
    }
    const m = await this.contentTypes
    const key = path.toLowerCase()
    return m.get(key) ?? m.get('ext:' + (key.split('.').pop() ?? ''))
  }

  async blob(path: string): Promise<Blob> {
    const ch = this.changes.get(normalize(path))
    const bytes = ch && ch.data !== null && typeof ch.data !== 'function' ? (typeof ch.data === 'string' ? new TextEncoder().encode(ch.data) : ch.data) : await this.zip.bytes(path)
    return new Blob([bytes as BlobPart], { type: mimeOf(path) })
  }

  async mainPart(): Promise<{ path: string; kind: DocKind }> {
    const rels = await this.rels('')
    let path: string | undefined
    for (const r of rels.values()) if (r.type.endsWith('/officeDocument')) path = r.target
    const candidates: [string, DocKind][] = [
      ['word/document.xml', 'docx'],
      ['xl/workbook.xml', 'xlsx'],
      ['ppt/presentation.xml', 'pptx'],
    ]
    if (!path) path = candidates.find(([p]) => this.zip.has(p))?.[0]
    if (!path || !this.has(path)) throw new Error('The file is a ZIP archive but not an Office document: it has no Word, Excel or PowerPoint main part (a damaged file, or another kind of archive)')
    const ct = (await this.contentType(path)) ?? ''
    let kind: DocKind | undefined
    if (ct.includes('wordprocessingml')) kind = 'docx'
    else if (ct.includes('spreadsheetml')) kind = 'xlsx'
    else if (ct.includes('presentationml')) kind = 'pptx'
    else kind = candidates.find(([p]) => path!.toLowerCase().startsWith(p.split('/')[0] + '/'))?.[1]
    if (!kind) throw new Error(`Unsupported document type (${ct || path})`)
    return { path, kind }
  }
}

const OOXML = 'application/vnd.openxmlformats-officedocument.'
const MAIN_TYPE: Record<DocKind, string> = {
  docx: OOXML + 'wordprocessingml.document.main+xml',
  xlsx: OOXML + 'spreadsheetml.sheet.main+xml',
  pptx: OOXML + 'presentationml.presentation.main+xml',
}
/** the content type of a part by the type of the relationship to it (`kind:` first, for a type the formats share) */
const REL_TYPE: Record<string, string> = {
  theme: OOXML + 'theme+xml',
  'core-properties': 'application/vnd.openxmlformats-package.core-properties+xml',
  'extended-properties': OOXML + 'extended-properties+xml',
  'custom-properties': OOXML + 'custom-properties+xml',
  drawing: OOXML + 'drawing+xml',
  chart: OOXML + 'drawingml.chart+xml',
  'docx:styles': OOXML + 'wordprocessingml.styles+xml',
  'docx:settings': OOXML + 'wordprocessingml.settings+xml',
  'docx:numbering': OOXML + 'wordprocessingml.numbering+xml',
  'docx:fontTable': OOXML + 'wordprocessingml.fontTable+xml',
  'docx:webSettings': OOXML + 'wordprocessingml.webSettings+xml',
  'docx:footnotes': OOXML + 'wordprocessingml.footnotes+xml',
  'docx:endnotes': OOXML + 'wordprocessingml.endnotes+xml',
  'docx:comments': OOXML + 'wordprocessingml.comments+xml',
  'docx:header': OOXML + 'wordprocessingml.header+xml',
  'docx:footer': OOXML + 'wordprocessingml.footer+xml',
  'xlsx:styles': OOXML + 'spreadsheetml.styles+xml',
  'xlsx:worksheet': OOXML + 'spreadsheetml.worksheet+xml',
  'xlsx:sharedStrings': OOXML + 'spreadsheetml.sharedStrings+xml',
  'xlsx:calcChain': OOXML + 'spreadsheetml.calcChain+xml',
  'xlsx:table': OOXML + 'spreadsheetml.table+xml',
  'xlsx:comments': OOXML + 'spreadsheetml.comments+xml',
  'xlsx:externalLink': OOXML + 'spreadsheetml.externalLink+xml',
  'pptx:slide': OOXML + 'presentationml.slide+xml',
  'pptx:slideMaster': OOXML + 'presentationml.slideMaster+xml',
  'pptx:slideLayout': OOXML + 'presentationml.slideLayout+xml',
  'pptx:notesSlide': OOXML + 'presentationml.notesSlide+xml',
  'pptx:notesMaster': OOXML + 'presentationml.notesMaster+xml',
  'pptx:handoutMaster': OOXML + 'presentationml.handoutMaster+xml',
  'pptx:presProps': OOXML + 'presentationml.presProps+xml',
  'pptx:viewProps': OOXML + 'presentationml.viewProps+xml',
  'pptx:tableStyles': OOXML + 'presentationml.tableStyles+xml',
  'pptx:commentAuthors': OOXML + 'presentationml.commentAuthors+xml',
  'pptx:comments': OOXML + 'presentationml.comments+xml',
}

/** the formats other than the plain document (docx, xlsx, pptx), by the content type of the main part: extension, media type */
const FLAVORS: Record<string, [string, string]> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml': ['dotx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.template'],
  'application/vnd.ms-word.document.macroEnabled.main+xml': ['docm', 'application/vnd.ms-word.document.macroEnabled.12'],
  'application/vnd.ms-word.template.macroEnabledTemplate.main+xml': ['dotm', 'application/vnd.ms-word.template.macroEnabled.12'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml': ['xltx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.template'],
  'application/vnd.ms-excel.sheet.macroEnabled.main+xml': ['xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
  'application/vnd.ms-excel.template.macroEnabled.main+xml': ['xltm', 'application/vnd.ms-excel.template.macroEnabled.12'],
  'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml': ['potx', 'application/vnd.openxmlformats-officedocument.presentationml.template'],
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml': ['ppsx', 'application/vnd.openxmlformats-officedocument.presentationml.slideshow'],
  'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml': ['pptm', 'application/vnd.ms-powerpoint.presentation.macroEnabled.12'],
  'application/vnd.ms-powerpoint.template.macroEnabled.main+xml': ['potm', 'application/vnd.ms-powerpoint.template.macroEnabled.12'],
  'application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml': ['ppsm', 'application/vnd.ms-powerpoint.slideshow.macroEnabled.12'],
}

export function relOfType(rels: Rels, suffix: string): Rel | undefined {
  for (const r of rels.values()) if (r.type.endsWith('/' + suffix)) return r
  return undefined
}

export function relsOfType(rels: Rels, suffix: string): Rel[] {
  return [...rels.values()].filter((r) => r.type.endsWith('/' + suffix))
}

const SKIP_EXT = new Set(['extLst'])
