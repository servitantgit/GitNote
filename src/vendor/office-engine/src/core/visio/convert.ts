/**
 * Visio drawings (.vsdx) → PPTX, for viewing: a slide per page, each shape drawn where it is. A shape's geometry
 * becomes a custom path already turned, flipped and moved to its place on the slide (so groups need no frames of
 * their own), its text a text box over it, its picture a picture. Fills, lines, line ends and text formats are
 * written on each element; background pages are drawn under the pages that name them.
 */
import { THEME } from '../convert'
import { fileHex } from '../color'
import { mediaTypes, Part, XML_HEAD } from '../iwork/ooxml'
import { OpcPackage, relsOfType, type Rels } from '../opc'
import { escAttr, escText } from '../raw'
import type { ZipArchive } from '../zip'
import { writeZip, type PartData } from '../zipwrite'
import { apply, mul, placement, roundCorners, sectionPath, subPaths, transform, type Matrix, type SubPath } from './geometry'
import { parseVisioXml, Resolved, Sheet, Styles, toNum, vkid, vkids, type VNode } from './sheet'
import { readText } from './text'
import { luminance, parseVisioTheme, ThemeLook, withLuminance, type Paint, type ThemedFill, type VisioTheme } from './theme'

/** Visio's built-in colors, named by number where a file gives no palette of its own */
const PALETTE = [
  '#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#800000', '#008000', '#000080', '#808000',
  '#800080', '#008080', '#c0c0c0', '#e6e6e6', '#cdcdcd', '#b3b3b3', '#9a9a9a', '#808080', '#666666', '#4d4d4d', '#333333', '#1a1a1a',
]

/** line patterns as DrawingML preset dashes (1 is solid) */
const DASH: Record<number, string> = {
  2: 'dash', 3: 'sysDot', 4: 'dashDot', 5: 'lgDashDotDot', 6: 'lgDashDot', 7: 'lgDashDot', 8: 'lgDashDotDot', 9: 'sysDash', 10: 'dot', 11: 'dashDot',
  12: 'lgDashDotDot', 13: 'lgDashDot', 14: 'lgDashDot', 15: 'lgDashDotDot', 16: 'lgDash', 17: 'dot', 18: 'lgDashDot', 19: 'lgDashDotDot', 20: 'lgDashDot',
  21: 'lgDashDot', 22: 'lgDashDot', 23: 'sysDash',
}

/** line ends that are not a filled triangle */
const ARROW: Record<number, string> = { 1: 'arrow', 3: 'arrow', 5: 'stealth', 6: 'stealth', 7: 'arrow', 8: 'stealth', 9: 'arrow', 10: 'oval', 11: 'diamond', 20: 'oval', 21: 'oval', 22: 'diamond', 41: 'oval', 42: 'oval' }

const BULLET: Record<number, string> = { 1: '•', 2: '◦', 3: '▪', 4: '▫', 5: '♦', 6: '➢' }

const EMU_IN = 914400
/** PowerPoint's largest and smallest slide side, in inches */
const MAX_SLIDE = 56
const MIN_SLIDE = 1
/** groups inside groups: well past what drawings nest (the XML reader stops at 1,024 elements, a group takes two) */
const MAX_DEPTH = 500
/**
 * What a drawing may ask for. A small file can draw without end: every instance of a master draws all of the
 * master's shapes again. Past these the file is refused, instead of the slides being built.
 */
export const VISIO_LIMITS = {
  /** shapes drawn in the whole document */
  shapes: 400_000,
  /** characters of slide XML written in the whole document */
  output: 256 * 1024 * 1024,
}
const tooLarge = () => new Error('The Visio drawing is too large to show')

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const GRP =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'

const emu = (inches: number) => Math.round(inches * EMU_IN)
const hex6 = (c: string) => c.replace('#', '').toUpperCase()

function colorXml(p: Paint): string {
  const alpha = p.trans > 0.005 ? `<a:alpha val="${Math.round((1 - Math.min(1, p.trans)) * 100000)}"/>` : ''
  return `<a:srgbClr val="${hex6(p.hex)}">${alpha}</a:srgbClr>`
}
const solid = (p: Paint) => `<a:solidFill>${colorXml(p)}</a:solidFill>`

type Fill = { t: 'none' } | { t: 'solid'; paint: Paint } | { t: 'grad'; stops: { pos: number; paint: Paint }[]; angle: number; radial?: boolean }

interface Line {
  paint: Paint
  /** inches */
  w: number
  pattern: number
  begin: number
  end: number
  beginSize: number
  endSize: number
}

/** a master's shapes, by their ids */
interface Master {
  part: string
  top: VNode[]
  byId: Map<string, VNode>
}

interface Page {
  name: string
  part?: string
  sheet: Sheet
  background: boolean
  backPage?: string
  id?: string
}

/** what the shapes of one page (or of a master used on it) are drawn with */
interface Ctx {
  /** the part the shape is in: where its relationships (pictures) are */
  part: string
  master?: Master
  look?: ThemeLook
  hiddenLayers: Set<string>
  /** lengths that are not drawing units (line weights, font sizes): inches on the slide per inch */
  k: number
}

function fillXml(f: Fill): string {
  if (f.t === 'none') return '<a:noFill/>'
  if (f.t === 'solid') return solid(f.paint)
  const gs = f.stops.map((s) => `<a:gs pos="${Math.round(s.pos * 100000)}">${colorXml(s.paint)}</a:gs>`).join('')
  const dir = f.radial
    ? '<a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path>'
    : `<a:lin ang="${Math.round(((((f.angle % 360) + 360) % 360) * 60000))}" scaled="0"/>`
  return `<a:gradFill rotWithShape="1"><a:gsLst>${gs}</a:gsLst>${dir}</a:gradFill>`
}

function lineXml(l: Line | undefined, k: number, ends: boolean): string {
  if (!l) return '<a:ln><a:noFill/></a:ln>'
  const size = (n: number) => (n <= 1 ? 'sm' : n >= 4 ? 'lg' : 'med')
  const end = (tag: string, type: number, sz: number) => (ends && type > 0 ? `<a:${tag} type="${ARROW[type] ?? 'triangle'}" w="${size(sz)}" len="${size(sz)}"/>` : '')
  const dash = DASH[l.pattern] ?? (l.pattern > 1 ? 'dash' : '')
  // a weight of 0 is the thinnest line a device draws
  return `<a:ln w="${Math.max(3175, emu(l.w * k))}">${solid(l.paint)}${dash ? `<a:prstDash val="${dash}"/>` : ''}${end('headEnd', l.begin, l.beginSize)}${end('tailEnd', l.end, l.endSize)}</a:ln>`
}

const round = (v: number) => Math.round(v)

/** sub-paths (in slide inches) as one custom geometry in a box around them */
function pathShape(id: number, name: string, paths: SubPath[], fill: Fill, line: Line | undefined, k: number, ends: boolean): string {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const see = (x: number, y: number) => {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  for (const p of paths) {
    for (const s of p.segs) {
      if (s.t === 'Z') continue
      see(s.x, s.y)
      if (s.t === 'C') {
        see(s.x1, s.y1)
        see(s.x2, s.y2)
      }
    }
  }
  if (!isFinite(x0) || !isFinite(y0) || !isFinite(x1) || !isFinite(y1)) return ''
  const ox = emu(x0)
  const oy = emu(y0)
  const w = Math.max(0, emu(x1) - ox)
  const h = Math.max(0, emu(y1) - oy)
  const pt = (x: number, y: number) => `<a:pt x="${round(x * EMU_IN) - ox}" y="${round(y * EMU_IN) - oy}"/>`
  let d = ''
  for (const p of paths) {
    for (const s of p.segs) {
      if (s.t === 'M') d += `<a:moveTo>${pt(s.x, s.y)}</a:moveTo>`
      else if (s.t === 'L') d += `<a:lnTo>${pt(s.x, s.y)}</a:lnTo>`
      else if (s.t === 'C') d += `<a:cubicBezTo>${pt(s.x1, s.y1)}${pt(s.x2, s.y2)}${pt(s.x, s.y)}</a:cubicBezTo>`
    }
    if (p.closed) d += '<a:close/>'
  }
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escAttr(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${ox}" y="${oy}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>` +
    `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${Math.max(1, w)}" h="${Math.max(1, h)}">${d}</a:path></a:pathLst></a:custGeom>` +
    `${fillXml(fill)}${lineXml(line, k, ends)}</p:spPr></p:sp>`
  )
}

/**
 * How a box (w × h, in a y-up frame sent to the slide by `m`) is placed as a DrawingML frame: its center, its
 * turn in degrees clockwise, and whether it is mirrored. `upright`: a mirrored frame is turned the way that keeps
 * its content the right way up (text is never mirrored).
 */
function frame(m: Matrix, w: number, h: number, upright: boolean): { cx: number; cy: number; scale: number; rot: number; flipH: boolean } {
  const [cx, cy] = apply(m, w / 2, h / 2)
  // the box's own frame has y down: (u, v) = (x, h - y)
  const a = m[0]
  const b = m[1]
  const c = -m[2]
  const d = -m[3]
  const scale = Math.hypot(a, b) || 1
  const det = a * d - b * c
  let rot: number
  let flipH = false
  if (det >= 0) rot = Math.atan2(b, a)
  else if (upright) {
    // mirrored: the turn left once a flip is taken out, of the two the one nearer to upright
    const r1 = Math.atan2(-b, -a)
    const r2 = Math.atan2(b, a)
    rot = Math.cos(r1) >= Math.cos(r2) ? r1 : r2
  } else {
    rot = Math.atan2(-b, -a)
    flipH = true
  }
  let deg = (rot * 180) / Math.PI
  deg = ((deg % 360) + 360) % 360
  if (Math.abs(deg) < 0.01 || Math.abs(deg - 360) < 0.01) deg = 0
  return { cx, cy, scale, rot: deg, flipH }
}

function xfrmXml(cx: number, cy: number, w: number, h: number, rot: number, flipH: boolean): string {
  const attrs = (rot ? ` rot="${Math.round(rot * 60000)}"` : '') + (flipH ? ' flipH="1"' : '')
  return `<a:xfrm${attrs}><a:off x="${emu(cx - w / 2)}" y="${emu(cy - h / 2)}"/><a:ext cx="${Math.max(0, emu(w))}" cy="${Math.max(0, emu(h))}"/></a:xfrm>`
}

class VisioConverter {
  private pkg: OpcPackage
  private styles = new Styles()
  private colors = new Map<number, string>()
  /** master id → its part */
  private masters = new Map<string, string>()
  private loaded = new Map<string, Promise<Master | undefined>>()
  private themes: VisioTheme[] = []
  private sheets = new WeakMap<VNode, Sheet>()
  private files = new Map<string, PartData>()
  private media = new Map<string, string>()
  private slide!: Part
  private ids = 1
  private out: string[] = []
  private count = 0
  private written = 0

  constructor(private zip: ZipArchive) {
    this.pkg = new OpcPackage(zip)
  }

  private sheet(el: VNode | undefined): Sheet | undefined {
    if (!el) return undefined
    let s = this.sheets.get(el)
    if (!s) this.sheets.set(el, (s = new Sheet(el)))
    return s
  }

  private async xml(part: string): Promise<VNode | undefined> {
    return this.zip.has(part) ? parseVisioXml(await this.zip.text(part)) : undefined
  }

  /** a color cell: `#rrggbb`, or a number of the document's palette; undefined for a themed (or unknown) one */
  private color(v: string | undefined): string | undefined {
    if (v === undefined) return undefined
    if (v[0] === '#') return fileHex(v.slice(1))
    const m = /^RGB\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(v)
    if (m) return '#' + [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')
    if (!/^\d+$/.test(v)) return undefined
    const n = Number(v)
    return this.colors.get(n) ?? PALETTE[n]
  }

  private master(id: string): Promise<Master | undefined> {
    let p = this.loaded.get(id)
    if (!p) {
      p = (async () => {
        const part = this.masters.get(id)
        if (!part) return undefined
        const root = await this.xml(part)
        const byId = new Map<string, VNode>()
        const walk = (shapes: VNode | undefined, depth: number) => {
          if (depth > MAX_DEPTH) return
          for (const s of vkids(shapes, 'Shape')) {
            if (s.a.ID !== undefined && !byId.has(s.a.ID)) byId.set(s.a.ID, s)
            walk(vkid(s, 'Shapes'), depth + 1)
          }
        }
        const shapes = vkid(root, 'Shapes')
        walk(shapes, 0)
        return { part, top: vkids(shapes, 'Shape'), byId }
      })()
      this.loaded.set(id, p)
    }
    return p
  }

  // ---- looks

  private themedFill(r: Resolved, ctx: Ctx): ThemedFill | undefined {
    return ctx.look?.fill(r.num('QuickStyleFillMatrix'), r.num('QuickStyleFillColor'))
  }

  private fill(r: Resolved, ctx: Ctx): Fill {
    const themed = (v: string | undefined) => v === 'Themed'
    const rawPattern = r.cell('FillPattern')
    const rawFg = r.cell('FillForegnd')
    const needTheme = themed(rawPattern) || themed(rawFg) || themed(r.cell('FillGradientEnabled')) || themed(r.cell('FillBkgnd'))
    const tf = needTheme ? this.themedFill(r, ctx) : undefined
    const pattern = themed(rawPattern) ? (tf?.pattern ?? 1) : toNum(rawPattern, 1)
    if (pattern === 0) return { t: 'none' }
    const trans = Math.max(0, Math.min(1, toNum(r.cell('FillForegndTrans'))))
    const fgHex = this.color(rawFg)
    const fg: Paint = fgHex ? { hex: fgHex, trans } : (tf?.color ?? { hex: '#ffffff', trans })
    const bgHex = this.color(r.cell('FillBkgnd'))
    const bgTrans = Math.max(0, Math.min(1, toNum(r.cell('FillBkgndTrans'))))
    const lastStop = tf?.stops?.[tf.stops.length - 1].paint
    const bg: Paint = bgHex ? { hex: bgHex, trans: bgTrans } : (lastStop ?? fg)
    // gradients: the stops of the FillGradient section, or the theme's
    const gradOn = themed(r.cell('FillGradientEnabled')) ? !!tf?.stops : r.num('FillGradientEnabled') === 1
    if (gradOn) {
      const stops: { pos: number; paint: Paint }[] = []
      for (const key of r.rowKeys('FillGradient')) {
        const c = this.color(r.rowCell('FillGradient', key, 'GradientStopColor'))
        if (!c) continue
        stops.push({
          pos: Math.max(0, Math.min(1, toNum(r.rowCell('FillGradient', key, 'GradientStopPosition')))),
          paint: { hex: c, trans: Math.max(0, Math.min(1, toNum(r.rowCell('FillGradient', key, 'GradientStopColorTrans')))) },
        })
      }
      stops.sort((a, b) => a.pos - b.pos)
      if (stops.length > 1) {
        const dir = r.num('FillGradientDir')
        const radial = dir >= 8 && r.cell('FillGradientDir') !== 'Themed'
        // the angle is Office's: clockwise from left-to-right (90°: the first stop at the top)
        const angle = (toNum(r.cell('FillGradientAngle')) * 180) / Math.PI
        return { t: 'grad', stops, angle, radial }
      }
      if (tf?.stops) return { t: 'grad', stops: tf.stops, angle: tf.angle ?? 0, radial: tf.radial }
    }
    if (pattern === 1) return { t: 'solid', paint: fg }
    // the gradient patterns of older drawings: foreground to background
    if (pattern >= 25 && pattern <= 40) {
      const two = [
        { pos: 0, paint: fg },
        { pos: 1, paint: bg },
      ]
      const axial = [
        { pos: 0, paint: bg },
        { pos: 0.5, paint: fg },
        { pos: 1, paint: bg },
      ]
      switch (pattern) {
        case 25:
          return { t: 'grad', stops: two, angle: 0 }
        case 26:
          return { t: 'grad', stops: axial, angle: 0 }
        case 27:
          return { t: 'grad', stops: two, angle: 180 }
        case 28:
          return { t: 'grad', stops: two, angle: 90 }
        case 29:
          return { t: 'grad', stops: axial, angle: 90 }
        case 30:
          return { t: 'grad', stops: two, angle: 270 }
        case 31:
          return { t: 'grad', stops: two, angle: 45 }
        case 32:
          return { t: 'grad', stops: axial, angle: 45 }
        case 33:
          return { t: 'grad', stops: two, angle: 135 }
        case 34:
          return { t: 'grad', stops: axial, angle: 135 }
        default:
          return { t: 'grad', stops: two, angle: 0, radial: true }
      }
    }
    // hatches: lines of the foreground over the background, shown as the mix a thin hatch reads as
    const mix = (a: string, b: string, t: number) => {
      const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16))
      const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16))
      return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('')
    }
    return { t: 'solid', paint: { hex: mix(bg.hex, fg.hex, 0.35), trans: Math.min(bg.trans, fg.trans) } }
  }

  private line(r: Resolved, ctx: Ctx, oneD: boolean, fill: Fill): { line?: Line; rounding: number } {
    const themed = (n: string) => r.cell(n) === 'Themed'
    const needTheme = ['LinePattern', 'LineColor', 'LineWeight', 'Rounding', 'BeginArrow', 'EndArrow'].some(themed)
    const tl = needTheme ? ctx.look?.line(r.num('QuickStyleLineMatrix'), r.num('QuickStyleLineColor'), oneD) : undefined
    const rounding = themed('Rounding') ? (tl?.ex.rounding ?? 0) / EMU_IN : Math.max(0, r.num('Rounding'))
    const pattern = themed('LinePattern') ? (tl?.pattern ?? 1) : r.num('LinePattern', 1)
    if (pattern === 0) return { rounding }
    const colorHex = this.color(r.cell('LineColor'))
    let paint: Paint = colorHex ? { hex: colorHex, trans: 0 } : (tl?.color ?? { hex: '#000000', trans: 0 })
    if (themed('LineColor') && tl && !tl.color) return { rounding }
    // a themed line too close to the fill it outlines is drawn as a darker fill color, a lighter one around a very dark fill (the line variation)
    if (themed('LineColor') && r.num('QuickStyleVariation') & 2 && fill.t === 'solid' && Math.abs(luminance(paint.hex) - luminance(fill.paint.hex)) < 0.1666) {
      const fl = luminance(fill.paint.hex)
      paint = { hex: withLuminance(fill.paint.hex, fl < 0.2 ? fl + 0.3 : fl * 0.73), trans: 0 }
    }
    paint = { hex: paint.hex, trans: Math.max(paint.trans, Math.max(0, Math.min(1, toNum(r.cell('LineColorTrans'))))) }
    const arrow = (n: string, v: number | undefined) => (themed(n) ? (v ?? 0) : r.num(n))
    return {
      rounding,
      line: {
        paint,
        w: themed('LineWeight') ? (tl?.weight ?? 0.75 / 72) : Math.max(0, r.num('LineWeight', 0.75 / 72)),
        pattern,
        begin: arrow('BeginArrow', tl?.ex.start),
        end: arrow('EndArrow', tl?.ex.end),
        beginSize: themed('BeginArrowSize') ? (tl?.ex.startSize ?? 2) : r.num('BeginArrowSize', 2),
        endSize: themed('EndArrowSize') ? (tl?.ex.endSize ?? 2) : r.num('EndArrowSize', 2),
      },
    }
  }

  // ---- text

  private textBox(el: VNode | undefined, r: Resolved, ctx: Ctx, m: Matrix, w: number, h: number, oneD: boolean, fill: Fill): string {
    const paras = readText(el)
    if (!paras.length || r.num('HideText') === 1) return ''
    const k = ctx.k
    const tw = r.num('TxtWidth', w)
    const th = r.num('TxtHeight', h)
    const tm = mul(m, placement(r.num('TxtPinX', w / 2), r.num('TxtPinY', h / 2), r.num('TxtLocPinX', tw / 2), r.num('TxtLocPinY', th / 2), r.num('TxtAngle'), false, false))
    const f = frame(tm, tw, th, true)
    const themedText = () => ctx.look?.text(r.num('QuickStyleFontMatrix'), r.num('QuickStyleFontColor'), oneD)
    // text over the shape's own fill: a themed color too close to it turns black or white (the text variation)
    const contrast = (hex: string): string => {
      if (!(r.num('QuickStyleVariation') & 8) || fill.t !== 'solid' || fill.paint.trans > 0.5) return hex
      const fl = luminance(fill.paint.hex)
      return Math.abs(luminance(hex) - fl) < 0.1666 ? (fl > 0.7292 ? '#000000' : '#ffffff') : hex
    }
    const bkRaw = r.cell('TextBkgnd')
    // the color behind the characters: a color, or a palette number plus one (0: none)
    let highlight: string | undefined
    if (bkRaw && bkRaw !== '0' && bkRaw !== 'Themed' && toNum(r.cell('TextBkgndTrans')) < 0.5) {
      highlight = bkRaw[0] === '#' ? this.color(bkRaw) : /^\d+$/.test(bkRaw) ? (Number(bkRaw) === 255 ? ctx.look?.background : this.color(String(Number(bkRaw) - 1))) : undefined
    }
    let firstSize = 12
    /** characters of the longest line, and of the longest word */
    let longest = 0
    let word = 0
    let body = ''
    for (const p of paras) {
      const pc = (n: string) => r.rowCell('Paragraph', p.pp, n)
      const align = ['l', 'ctr', 'r', 'just', 'just'][toNum(pc('HorzAlign'), 1)] ?? 'ctr'
      const indLeft = toNum(pc('IndLeft')) * k
      const indFirst = toNum(pc('IndFirst')) * k
      const spLine = toNum(pc('SpLine'), -1.2)
      const bulletN = toNum(pc('Bullet'))
      const bulletChar = bulletN === 7 ? (pc('BulletStr') ?? '').slice(0, 8) : BULLET[bulletN]
      let runs = ''
      let size = 0
      const rPr = (cp: string, tag = 'a:rPr'): string => {
        const cc = (n: string) => r.rowCell('Character', cp, n)
        const rawSize = toNum(cc('Size'), 12 / 72)
        const pt = Math.max(1, Math.min(4000, rawSize * 72 * k))
        if (!size) size = pt
        const rawStyle = cc('Style')
        const tt = rawStyle === 'Themed' || cc('Color') === 'Themed' ? themedText() : undefined
        const style = rawStyle === 'Themed' ? (tt?.style ?? 0) : toNum(rawStyle)
        const colorHex = this.color(cc('Color'))
        const color = colorHex ?? (tt?.color ? contrast(tt.color.hex) : cc('Color') === 'Themed' ? contrast('#000000') : '#000000')
        const trans = Math.max(0, Math.min(1, toNum(cc('ColorTrans'))))
        const pos = toNum(cc('Pos'))
        const rawFont = cc('Font')
        const font = !rawFont || rawFont === 'Themed' || /^\d+$/.test(rawFont) ? (ctx.look?.font ?? 'Calibri') : rawFont
        let attrs = ` lang="en-US" sz="${Math.round(pt * 100)}"`
        if (style & 1) attrs += ' b="1"'
        if (style & 2) attrs += ' i="1"'
        if (style & 4 || toNum(cc('DblUnderline'))) attrs += ` u="${toNum(cc('DblUnderline')) ? 'dbl' : 'sng'}"`
        if (toNum(cc('Strikethru')) || toNum(cc('DoubleStrikethrough'))) attrs += ' strike="sngStrike"'
        if (pos === 1) attrs += ' baseline="30000"'
        else if (pos === 2) attrs += ' baseline="-25000"'
        if (toNum(cc('Case')) === 1) attrs += ' cap="all"'
        else if (style & 8) attrs += ' cap="small"'
        return (
          `<${tag}${attrs}>${solid({ hex: color, trans })}${highlight ? `<a:highlight><a:srgbClr val="${hex6(highlight)}"/></a:highlight>` : ''}` +
          `<a:latin typeface="${escAttr(font)}"/><a:ea typeface="${escAttr(font)}"/><a:cs typeface="${escAttr(font)}"/></${tag}>`
        )
      }
      let lastCp = '0'
      let chars = 0
      for (const run of p.runs) {
        lastCp = run.cp
        chars = run.br ? 0 : chars + run.text.length
        longest = Math.max(longest, chars)
        runs += run.br ? `<a:br>${rPr(run.cp)}</a:br>` : `<a:r>${rPr(run.cp)}<a:t>${escText(run.text)}</a:t></a:r>`
      }
      for (const w of p.runs.map((x) => (x.br ? ' ' : x.text)).join('').split(/[\s\u00ad-]+/)) {
        // CJK text breaks between any two characters: only the letters that stay together count
        let n = 0
        for (const ch of w) n += ch.codePointAt(0)! > 0x2e7f ? 0 : 1
        word = Math.max(word, n)
      }
      const end = rPr(p.runs.length ? lastCp : '0', 'a:endParaRPr')
      if (body === '') firstSize = size || 12
      const hang = bulletChar ? Math.max(indFirst < 0 ? -indFirst : 0, (size || 12) / 72) : 0
      const marL = Math.max(0, indLeft + (bulletChar && indFirst >= 0 ? hang : 0))
      const indent = bulletChar ? -hang : indFirst
      const spacing =
        (spLine < 0 ? `<a:lnSpc><a:spcPct val="${Math.round((-spLine / 1.2) * 100000)}"/></a:lnSpc>` : spLine > 0 ? `<a:lnSpc><a:spcPts val="${Math.round(spLine * 72 * k * 100)}"/></a:lnSpc>` : '') +
        `<a:spcBef><a:spcPts val="${Math.max(0, Math.round(toNum(pc('SpBefore')) * 72 * k * 100))}"/></a:spcBef>` +
        `<a:spcAft><a:spcPts val="${Math.max(0, Math.round(toNum(pc('SpAfter')) * 72 * k * 100))}"/></a:spcAft>`
      const bullet = bulletChar ? `<a:buFont typeface="Arial"/><a:buChar char="${escAttr(bulletChar)}"/>` : '<a:buNone/>'
      body += `<a:p><a:pPr algn="${align}" marL="${emu(marL)}" indent="${emu(Math.max(-marL, indent))}">${spacing}${bullet}</a:pPr>${runs}${end}</a:p>`
    }
    const anchor = ['t', 'ctr', 'b'][r.num('VerticalAlign', 1)] ?? 'ctr'
    const ins = (n: string) => Math.max(0, emu(r.num(n) * k))
    let bw = tw * f.scale
    const bh = th * f.scale
    // a block narrower than a character (the text of a vertical line) does not wrap: the text is laid across it,
    // in a box wide enough to hold its longest line around the same center
    const margins = (r.num('LeftMargin') + r.num('RightMargin')) * k
    const wrap = bw - margins > (firstSize / 72) * 0.75
    if (!wrap) bw = Math.max(bw, (longest * firstSize * 0.62) / 72 + margins)
    // the fonts here may be wider than the drawing's: a block its longest word barely fits is widened, so the word is not broken
    else bw = Math.max(bw, Math.min(bw * 1.5, (word * firstSize * 0.56) / 72 + margins))
    const id = ++this.ids
    return (
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrmXml(f.cx, f.cy, bw, bh, f.rot, false)}` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody>` +
      `<a:bodyPr wrap="${wrap ? 'square' : 'none'}" lIns="${ins('LeftMargin')}" tIns="${ins('TopMargin')}" rIns="${ins('RightMargin')}" bIns="${ins('BottomMargin')}" anchor="${anchor}"${wrap ? '' : ' anchorCtr="1"'} rtlCol="0"><a:noAutofit/></a:bodyPr>` +
      `<a:lstStyle/>${body}</p:txBody></p:sp>`
    )
  }

  // ---- pictures

  private async picture(el: VNode | undefined, mEl: VNode | undefined, r: Resolved, ctx: Ctx, masterPart: string | undefined, m: Matrix, w: number, h: number): Promise<string> {
    // the picture is the shape's own, or its master's (found from the master's part)
    const own = vkid(el, 'ForeignData')
    const data = own ?? vkid(mEl, 'ForeignData')
    const rid = vkid(data, 'Rel')?.a['r:id']
    const part = own ? ctx.part : masterPart
    if (!data || !rid || !part || !(w > 0) || !(h > 0)) return ''
    let rels: Rels
    try {
      rels = await this.pkg.rels(part)
    } catch {
      return ''
    }
    const rel = rels.get(rid)
    if (!rel || rel.external || !this.zip.has(rel.target)) return ''
    let name = this.media.get(rel.target)
    if (!name) {
      const ext = /\.([a-z0-9]{1,5})$/i.exec(rel.target)?.[1].toLowerCase() ?? 'bin'
      name = `image${this.media.size + 1}.${ext}`
      this.media.set(rel.target, name)
    }
    const f = frame(m, w, h, false)
    const id = ++this.ids
    // the picture may be larger than the shape that shows a part of it
    const iw = r.num('ImgWidth', w)
    const ih = r.num('ImgHeight', h)
    const ix = r.num('ImgOffsetX')
    const iy = r.num('ImgOffsetY')
    let crop = ''
    if (iw > 0 && ih > 0 && (Math.abs(iw - w) > 1e-6 || Math.abs(ih - h) > 1e-6 || Math.abs(ix) > 1e-6 || Math.abs(iy) > 1e-6)) {
      const pct = (v: number) => Math.round(Math.max(0, Math.min(0.99, v)) * 100000)
      crop = `<a:srcRect l="${pct(-ix / iw)}" t="${pct((iy + ih - h) / ih)}" r="${pct((ix + iw - w) / iw)}" b="${pct(-iy / ih)}"/>`
    }
    const embed = this.slide.rel('image', `../media/${name}`)
    return (
      `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${embed}"/>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
      `<p:spPr>${xfrmXml(f.cx, f.cy, w * f.scale, h * f.scale, f.rot, f.flipH)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
    )
  }

  // ---- shapes

  /**
   * Draws a shape (and, for a group, its members). `el` is the shape on the page, `mEl` the master's shape it is
   * an instance of; either may be missing. `parent` sends the parent's coordinates to the slide.
   */
  private async shape(el: VNode | undefined, mEl: VNode | undefined, ctx: Ctx, mPart: string | undefined, parent: Matrix, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return
    if (++this.count > VISIO_LIMITS.shapes) throw tooLarge()
    // an instance names its master; its members name the master's members
    if (el?.a.Master !== undefined) {
      const master = await this.master(el.a.Master)
      if (master) {
        ctx = { ...ctx, master }
        mPart = master.part
        mEl = el.a.MasterShape !== undefined ? master.byId.get(el.a.MasterShape) : master.top[0]
      }
    } else if (el?.a.MasterShape !== undefined && ctx.master) mEl = ctx.master.byId.get(el.a.MasterShape) ?? mEl
    const type = el?.a.Type ?? mEl?.a.Type ?? 'Shape'
    if (type === 'Guide') return
    const r = new Resolved([this.sheet(el), this.sheet(mEl)], this.styles, {
      line: el?.a.LineStyle ?? mEl?.a.LineStyle,
      fill: el?.a.FillStyle ?? mEl?.a.FillStyle,
      text: el?.a.TextStyle ?? mEl?.a.TextStyle,
    })
    const w = r.num('Width')
    const h = r.num('Height')
    const m = mul(parent, placement(r.num('PinX'), r.num('PinY'), r.num('LocPinX', w / 2), r.num('LocPinY', h / 2), r.num('Angle'), r.num('FlipX') === 1, r.num('FlipY') === 1))
    if (!m.every(isFinite)) return
    // on layers that are all hidden: not shown
    const layers = (r.cell('LayerMember') ?? '').split(';').filter(Boolean)
    const hidden = layers.length > 0 && layers.every((l) => ctx.hiddenLayers.has(l))
    const oneD = r.cell('BeginX') !== undefined && r.cell('EndX') !== undefined
    const mode = type === 'Group' ? r.num('DisplayMode', 2) : 2

    const own: string[] = []
    if (!hidden && mode !== 0) {
      const fill = this.fill(r, ctx)
      const { line, rounding } = this.line(r, ctx, oneD, fill)
      const filled: SubPath[] = []
      const stroked: SubPath[] = []
      let same = true
      for (const g of r.geometry()) {
        if (toNum(g.cells.get('NoShow')) === 1) continue
        const noFill = toNum(g.cells.get('NoFill')) === 1
        const noLine = toNum(g.cells.get('NoLine')) === 1
        for (let sp of subPaths(sectionPath(g, w, h))) {
          if (rounding > 0) sp = roundCorners(sp, rounding)
          const placed: SubPath = { segs: transform(sp.segs, m), closed: sp.closed }
          const f = !noFill && sp.closed && fill.t !== 'none'
          const s = !noLine && !!line
          if (f) filled.push(placed)
          if (s) stroked.push(placed)
          if (f !== s) same = false
        }
      }
      const name = el?.a.Name ?? el?.a.NameU ?? mEl?.a.Name ?? mEl?.a.NameU ?? 'Shape'
      const ends = stroked.length > 0 && stroked.some((p) => !p.closed)
      if (same && filled.length) own.push(pathShape(++this.ids, name, filled, fill, line, ctx.k, ends))
      else {
        if (filled.length) own.push(pathShape(++this.ids, name, filled, fill, undefined, ctx.k, false))
        if (stroked.length) own.push(pathShape(++this.ids, name, stroked, { t: 'none' }, line, ctx.k, ends))
      }
      if (type === 'Foreign') own.push(await this.picture(el, mEl, r, ctx, mPart, m, w, h))
      own.push(this.textBox(vkid(el, 'Text') ?? vkid(mEl, 'Text'), r, ctx, m, w, h, oneD, fill))
    }
    for (const x of own) this.written += x.length
    if (this.written > VISIO_LIMITS.output) throw tooLarge()
    // a group's own drawing is behind its members (1) or in front of them (2)
    if (mode === 1) this.out.push(...own)
    const shapes = vkid(el, 'Shapes')
    if (shapes) for (const c of vkids(shapes, 'Shape')) await this.shape(c, undefined, ctx, mPart, m, depth + 1)
    // members the instance does not list are the master's, as they are
    else for (const c of vkids(vkid(mEl, 'Shapes'), 'Shape')) await this.shape(undefined, c, ctx, mPart, m, depth + 1)
    if (mode !== 1) this.out.push(...own)
  }

  // ---- pages

  private theme(sheet: Sheet): ThemeLook | undefined {
    if (!this.themes.length) return undefined
    const n = (name: string) => toNum(sheet.cells.get(name), -1)
    const theme = this.themes.find((t) => t.id !== undefined && t.id === n('ThemeIndex')) ?? this.themes[0]
    const colors = this.themes.find((t) => t.id !== undefined && t.id === n('ColorSchemeIndex')) ?? theme
    const index = (v: number) => (v >= 0 && v < 16 ? v : 0)
    return new ThemeLook(theme, colors, index(n('VariationColorIndex')), index(n('VariationStyleIndex')))
  }

  /** a page's size on paper, in inches, and how many of them one drawing unit is */
  private size(sheet: Sheet): { w: number; h: number; unit: number } {
    const n = (name: string, def: number) => toNum(sheet.cells.get(name), def)
    const ps = n('PageScale', 1)
    const ds = n('DrawingScale', 1)
    const unit = ps > 0 && ds > 0 && isFinite(ps / ds) ? ps / ds : 1
    const w = n('PageWidth', 8.5)
    const h = n('PageHeight', 11)
    return { w: (w > 0 ? w : 8.5) * unit, h: (h > 0 ? h : 11) * unit, unit }
  }

  private async drawPage(page: Page, byId: Map<string, Page>, to: Matrix, k: number, seen: Set<Page>): Promise<void> {
    if (seen.has(page) || seen.size > 16) return
    seen.add(page)
    // the background page first: under this page's shapes
    const back = page.backPage !== undefined ? byId.get(page.backPage) : undefined
    if (back) await this.drawPage(back, byId, to, k, seen)
    const root = page.part ? await this.xml(page.part) : undefined
    const hiddenLayers = new Set<string>()
    for (const row of page.sheet.sections.get('Layer')?.rows.values() ?? []) if (row.cells.get('Visible') === '0') hiddenLayers.add(row.key)
    const ctx: Ctx = { part: page.part ?? '', look: this.theme(page.sheet), hiddenLayers, k }
    for (const s of vkids(vkid(root, 'Shapes'), 'Shape')) await this.shape(s, undefined, ctx, undefined, to, 0)
  }

  async convert(): Promise<Blob> {
    const { pkg, zip, files } = this
    const rootRels = await pkg.rels('')
    const docPart = [...rootRels.values()].find((r) => /\/visio\/.*\/document$/.test(r.type) && zip.has(r.target))?.target ?? 'visio/document.xml'
    const doc = await this.xml(docPart)
    if (!doc) throw new Error('Not a Visio drawing (no document part)')
    for (const c of vkids(vkid(doc, 'Colors'), 'ColorEntry')) {
      const hex = c.a.RGB?.[0] === '#' ? fileHex(c.a.RGB.slice(1)) : undefined
      if (hex && /^\d+$/.test(c.a.IX ?? '')) this.colors.set(Number(c.a.IX), hex)
    }
    for (const s of vkids(vkid(doc, 'StyleSheets'), 'StyleSheet')) if (s.a.ID !== undefined) this.styles.add(s.a.ID, s)
    const docRels = await pkg.rels(docPart)
    for (const t of relsOfType(docRels, 'theme')) {
      if (!zip.has(t.target)) continue
      try {
        this.themes.push(parseVisioTheme(await zip.text(t.target)))
      } catch {
        // a theme that is not read: its colors fall back to black on white
      }
    }

    // masters: their shapes are read when a page uses them
    const mastersPart = relsOfType(docRels, 'masters')[0]?.target
    const masterPages: Page[] = []
    if (mastersPart && zip.has(mastersPart)) {
      const rels = await pkg.rels(mastersPart)
      for (const m of vkids(await this.xml(mastersPart), 'Master')) {
        const target = rels.get(vkid(m, 'Rel')?.a['r:id'] ?? '')?.target
        if (m.a.ID === undefined || !target || !zip.has(target)) continue
        this.masters.set(m.a.ID, target)
        masterPages.push({ name: m.a.Name ?? m.a.NameU ?? `Master ${m.a.ID}`, part: target, sheet: new Sheet(vkid(m, 'PageSheet')), background: false })
      }
    }

    const pagesPart = relsOfType(docRels, 'pages')[0]?.target
    const pages: Page[] = []
    if (pagesPart && zip.has(pagesPart)) {
      const rels = await pkg.rels(pagesPart)
      for (const p of vkids(await this.xml(pagesPart), 'Page')) {
        const target = rels.get(vkid(p, 'Rel')?.a['r:id'] ?? '')?.target
        pages.push({
          id: p.a.ID,
          name: p.a.Name ?? p.a.NameU ?? `Page ${pages.length + 1}`,
          part: target && zip.has(target) ? target : undefined,
          sheet: new Sheet(vkid(p, 'PageSheet')),
          background: p.a.Background === '1',
          backPage: p.a.BackPage,
        })
      }
    }
    const byId = new Map<string, Page>()
    for (const p of pages) if (p.id !== undefined) byId.set(p.id, p)
    // the pages shown: the foreground ones; a drawing of background pages only shows those; a stencil its masters
    let shown = pages.filter((p) => !p.background)
    if (!shown.length) shown = pages
    if (!shown.length) shown = masterPages
    if (!shown.length) throw new Error('The Visio file has no pages')

    // one slide size for all: the largest page (PowerPoint has limits)
    const sizes = shown.map((p) => this.size(p.sheet))
    const maxW = Math.max(...sizes.map((s) => s.w))
    const maxH = Math.max(...sizes.map((s) => s.h))
    const g = Math.min(1, MAX_SLIDE / Math.max(maxW, maxH))
    const SW = Math.max(MIN_SLIDE, maxW * g)
    const SH = Math.max(MIN_SLIDE, maxH * g)
    const mixed = sizes.some((s) => Math.abs(s.w * g - SW) > 0.01 || Math.abs(s.h * g - SH) > 0.01)

    const PML = 'application/vnd.openxmlformats-officedocument.presentationml'
    let overrides =
      `<Override PartName="/ppt/presentation.xml" ContentType="${PML}.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${PML}.slideMaster+xml"/>` +
      `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${PML}.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`
    const presRels = new Part('ppt/presentation.xml')
    presRels.rel('slideMaster', 'slideMasters/slideMaster1.xml')
    let sldIds = ''
    for (let i = 0; i < shown.length; i++) {
      const page = shown[i]
      const size = sizes[i]
      const part = new Part(`ppt/slides/slide${i + 1}.xml`)
      part.rel('slideLayout', '../slideLayouts/slideLayout1.xml')
      this.slide = part
      this.ids = 1
      this.out = []
      const pw = size.w * g
      const ph = size.h * g
      const ox = (SW - pw) / 2
      const oy = (SH - ph) / 2
      // drawing units (y up, from the bottom left of the page) to inches on the slide (y down)
      const s = size.unit * g
      const to: Matrix = [s, 0, 0, -s, ox, oy + ph]
      const look = this.theme(page.sheet)
      const paper = look && this.themes.length ? look.background : '#ffffff'
      if (mixed) {
        // pages of other sizes: the page drawn as a sheet on the slide
        const rect: SubPath = { segs: [{ t: 'M', x: ox, y: oy }, { t: 'L', x: ox + pw, y: oy }, { t: 'L', x: ox + pw, y: oy + ph }, { t: 'L', x: ox, y: oy + ph }], closed: true }
        this.out.push(pathShape(++this.ids, 'Page', [rect], { t: 'solid', paint: { hex: paper, trans: 0 } }, { paint: { hex: '#c8c8c8', trans: 0 }, w: 0.75 / 72, pattern: 1, begin: 0, end: 0, beginSize: 2, endSize: 2 }, 1, false))
      }
      await this.drawPage(page, byId, to, g, new Set())
      const bg = `<p:bg><p:bgPr>${solid({ hex: mixed ? '#f0f0f0' : paper, trans: 0 })}<a:effectLst/></p:bgPr></p:bg>`
      files.set(part.path, `${XML_HEAD}<p:sld ${NS}><p:cSld name="${escAttr(page.name)}">${bg}<p:spTree>${GRP}${this.out.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`)
      files.set(part.relsPath, part.relsXml())
      overrides += `<Override PartName="/${part.path}" ContentType="${PML}.slide+xml"/>`
      sldIds += `<p:sldId id="${256 + i}" r:id="${presRels.rel('slide', `slides/slide${i + 1}.xml`)}"/>`
    }
    presRels.rel('theme', 'theme/theme1.xml')

    const layout = new Part('ppt/slideLayouts/slideLayout1.xml')
    layout.rel('slideMaster', '../slideMasters/slideMaster1.xml')
    files.set(layout.path, `${XML_HEAD}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GRP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`)
    files.set(layout.relsPath, layout.relsXml())
    const master = new Part('ppt/slideMasters/slideMaster1.xml')
    const layoutId = `<p:sldLayoutId id="2147483649" r:id="${master.rel('slideLayout', '../slideLayouts/slideLayout1.xml')}"/>`
    master.rel('theme', '../theme/theme1.xml')
    files.set(
      master.path,
      `${XML_HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr>${solid({ hex: '#ffffff', trans: 0 })}<a:effectLst/></p:bgPr></p:bg><p:spTree>${GRP}</p:spTree></p:cSld>` +
        '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
        `<p:sldLayoutIdLst>${layoutId}</p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr></p:bodyStyle>` +
        '<p:otherStyle><a:lvl1pPr><a:buNone/><a:defRPr sz="1200"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>',
    )
    files.set(master.relsPath, master.relsXml())
    files.set('ppt/theme/theme1.xml', THEME)
    files.set(
      'ppt/presentation.xml',
      `${XML_HEAD}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
        `<p:sldIdLst>${sldIds}</p:sldIdLst><p:sldSz cx="${emu(SW)}" cy="${emu(SH)}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    )
    files.set(presRels.relsPath, presRels.relsXml())
    files.set(
      '_rels/.rels',
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    )
    for (const [src, name] of this.media) files.set(`ppt/media/${name}`, await zip.bytes(src))
    files.set(
      '[Content_Types].xml',
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${mediaTypes(this.media.values())}${overrides}</Types>`,
    )
    return writeZip(files, `${PML}.presentation`)
  }
}

/** Converts an opened Visio package (.vsdx, .vsdm, .vstx, .vssx…) to a PPTX file. */
export function visioToPptx(zip: ZipArchive): Promise<Blob> {
  return new VisioConverter(zip).convert()
}
