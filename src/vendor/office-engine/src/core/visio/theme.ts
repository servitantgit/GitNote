/**
 * Visio themes. A cell whose stored value is `Themed` takes it from the page's theme: a color of the scheme (or of
 * one of its variations) picked by the shape's QuickStyle…Color cell, put through the fill, line or font style its
 * QuickStyle…Matrix cell picks. The styles are DrawingML (fmtScheme); Visio's own additions (variations, line ends,
 * connector styles, font colors) are in the theme's extension lists.
 */
import { fileHex, hexToRgb, rgbToHex, rgbToHsl, hslToRgb, type RGB } from '../color'
import { dict, own } from '../dict'
import { descAll, kid, kids, num, parseXml, path, type XEl } from '../xml'

export interface LineEx {
  rounding?: number
  start?: number
  end?: number
  startSize?: number
  endSize?: number
  pattern?: number
}

interface VarStyle {
  fill: number
  line: number
  font: number
}

export interface VisioTheme {
  /** the number pages name the theme by (ThemeIndex) */
  id?: number
  /** dk1, lt1, dk2, lt2, accent1-6, and bkgnd */
  colors: Record<string, string>
  /** the color variations: 7 colors each */
  variations: string[][]
  font?: string
  fills: XEl[]
  lines: XEl[]
  connectorLines: XEl[]
  lineEx: LineEx[]
  connectorLineEx: LineEx[]
  fonts: { color?: XEl; style: number }[]
  connectorFonts: { color?: XEl; style: number }[]
  fillPatterns: number[]
  /** the style variations: 4 styles each */
  varStyles: VarStyle[][]
}

const toLinear = (v: number) => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
const toSrgb = (v: number) => {
  const c = Math.max(0, Math.min(1, v))
  return (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255
}

const schemeColor = (el: XEl | undefined): string | undefined => {
  const v = el?.c[0]
  if (!v) return undefined
  return v.n === 'srgbClr' ? fileHex(v.a.val) : v.n === 'sysClr' ? (fileHex(v.a.lastClr) ?? (v.a.val === 'window' ? '#ffffff' : '#000000')) : undefined
}

export function parseVisioTheme(xml: string): VisioTheme {
  const root = parseXml(xml)
  const te = kid(root, 'themeElements')
  const clr = kid(te, 'clrScheme')
  const colors: Record<string, string> = dict({})
  for (const c of clr?.c ?? []) {
    const hex = schemeColor(c)
    if (hex) colors[c.n] = hex
  }
  const bk = schemeColor(descAll(clr, 'bkgnd')[0])
  if (bk) colors.bkgnd = bk
  const variations = descAll(clr, 'variationClrScheme').map((v) => [1, 2, 3, 4, 5, 6, 7].map((i) => schemeColor(kid(v, `varColor${i}`)) ?? ''))
  const fmt = kid(te, 'fmtScheme')
  const all = descAll(root, 'ext')
  const ext = (name: string) => all.map((e) => kid(e, name)).find(Boolean)
  const conn = ext('fmtConnectorScheme')
  const lineEx = (list: XEl | undefined): LineEx[] =>
    kids(list, 'lineStyle').map((s) => {
      const a = kid(s, 'lineEx')?.a ?? {}
      return { rounding: num(a.rndg), start: num(a.start), end: num(a.end), startSize: num(a.startSize), endSize: num(a.endSize), pattern: num(a.pattern) }
    })
  const fontProps = (list: XEl | undefined) => kids(list, 'fontProps').map((f) => ({ color: kid(f, 'color')?.c[0], style: num(f.a.style, 0)! }))
  const ls = ext('lineStyles')
  const fg = ext('fontStylesGroup')
  return {
    id: num(path(ext('themeScheme'), 'schemeID')?.a.schemeEnum),
    colors,
    variations,
    font: path(te, 'fontScheme', 'minorFont', 'latin')?.a.typeface || undefined,
    fills: kid(fmt, 'fillStyleLst')?.c ?? [],
    lines: kids(kid(fmt, 'lnStyleLst'), 'ln'),
    connectorLines: kids(kid(conn, 'lnStyleLst'), 'ln'),
    lineEx: lineEx(kid(ls, 'fmtSchemeLineStyles')),
    connectorLineEx: lineEx(kid(ls, 'fmtConnectorSchemeLineStyles')),
    fonts: fontProps(kid(fg, 'fontStyles')),
    connectorFonts: fontProps(kid(fg, 'connectorFontStyles')),
    fillPatterns: kids(ext('fillStyles'), 'fillProps').map((f) => num(f.a.pattern, 1)!),
    varStyles: kids(ext('variationStyleSchemeLst'), 'variationStyleScheme').map((s) =>
      kids(s, 'varStyle').map((v) => ({ fill: num(v.a.fillIdx, 0)!, line: num(v.a.lineIdx, 0)!, font: num(v.a.fontIdx, 0)! })),
    ),
  }
}

const SCHEME: Record<string, string> = dict({ tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' })

/** a color with how see-through it is (0 opaque … 1 clear) */
export interface Paint {
  hex: string
  trans: number
}

/** A DrawingML color; `phClr` is the color the style is applied with. Tints and shades mix in linear light, as Office does. */
export function drawingPaint(el: XEl | undefined, theme: VisioTheme, phClr: string | undefined): Paint | undefined {
  if (!el) return undefined
  let hex: string | undefined
  if (el.n === 'srgbClr') hex = fileHex(el.a.val)
  else if (el.n === 'sysClr') hex = fileHex(el.a.lastClr) ?? (el.a.val === 'window' ? '#ffffff' : '#000000')
  else if (el.n === 'schemeClr') hex = el.a.val === 'phClr' ? phClr : own(theme.colors, own(SCHEME, el.a.val) ?? el.a.val)
  if (!hex) return undefined
  let rgb = hexToRgb(hex)
  let trans = 0
  for (const m of el.c) {
    const v = (num(m.a.val) ?? 0) / 100000
    switch (m.n) {
      case 'alpha':
        trans = 1 - Math.max(0, Math.min(1, v))
        break
      case 'tint':
        rgb = rgb.map((c) => toSrgb(toLinear(c) * v + (1 - v))) as RGB
        break
      case 'shade':
        rgb = rgb.map((c) => toSrgb(toLinear(c) * v)) as RGB
        break
      case 'lumMod':
      case 'lumOff':
      case 'satMod': {
        const hsl = rgbToHsl(rgb)
        if (m.n === 'lumMod') hsl[2] = Math.max(0, Math.min(1, hsl[2] * v))
        else if (m.n === 'lumOff') hsl[2] = Math.max(0, Math.min(1, hsl[2] + v))
        else hsl[1] = Math.max(0, Math.min(1, hsl[1] * v))
        rgb = hslToRgb(hsl)
        break
      }
    }
  }
  return { hex: rgbToHex(rgb), trans }
}

export interface ThemedFill {
  /** the solid color, or a gradient's first */
  color: Paint
  /** a gradient's stops (pos 0-1) and its angle in degrees, clockwise from left-to-right */
  stops?: { pos: number; paint: Paint }[]
  angle?: number
  radial?: boolean
  pattern: number
}

export interface ThemedLine {
  color?: Paint
  /** inches */
  weight?: number
  pattern: number
  ex: LineEx
}

/** DrawingML preset dashes as Visio line patterns */
const DASH_PATTERN: Record<string, number> = dict({ solid: 1, dash: 2, sysDash: 2, lgDash: 2, dot: 3, sysDot: 3, dashDot: 4, lgDashDot: 4, sysDashDot: 4, lgDashDotDot: 5, sysDashDotDot: 5 })

/** What a page's theme gives a shape: the page picks the theme and its variation, the shape the colors and styles. */
export class ThemeLook {
  constructor(
    private theme: VisioTheme,
    private colors: VisioTheme,
    private variationColor: number,
    private variationStyle: number,
  ) {}

  get font(): string | undefined {
    return this.theme.font
  }

  get background(): string {
    return this.colors.colors.bkgnd ?? this.colors.colors.lt1 ?? '#ffffff'
  }

  /** the color a QuickStyle…Color cell names: 0 dark, 1 light, 2-7 accents, 8 background, 100-106 the variation's */
  color(index: number): string | undefined {
    const c = this.colors
    if (index >= 100 && index <= 106) {
      const v = c.variations[this.variationColor] ?? c.variations[0]
      return (v && v[index - 100]) || c.colors.accent1
    }
    const name = ['dk1', 'lt1', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'bkgnd'][index]
    return name ? (c.colors[name] ?? (name === 'bkgnd' ? c.colors.lt1 : undefined)) : undefined
  }

  /** the style number (1-based) a QuickStyle…Matrix cell names: itself, or the one its style variation gives */
  private index(matrix: number, kind: keyof VarStyle): number {
    if (matrix >= 100 && matrix <= 103) {
      const v = this.theme.varStyles[this.variationStyle] ?? this.theme.varStyles[0]
      return v?.[matrix - 100]?.[kind] ?? 0
    }
    return matrix
  }

  private paint(el: XEl | undefined, phClr: string | undefined): Paint | undefined {
    return drawingPaint(el, this.colors === this.theme ? this.theme : { ...this.theme, colors: this.colors.colors }, phClr)
  }

  fill(matrix: number, color: number): ThemedFill | undefined {
    const ph = this.color(color)
    const i = this.index(matrix, 'fill')
    const el = i >= 1 ? this.theme.fills[i - 1] : undefined
    const pattern = (i >= 1 ? this.theme.fillPatterns[i - 1] : undefined) ?? 1
    if (!el) return ph ? { color: { hex: ph, trans: 0 }, pattern: 1 } : undefined
    if (el.n === 'noFill') return { color: { hex: ph ?? '#ffffff', trans: 0 }, pattern: 0 }
    if (el.n === 'gradFill') {
      const stops = kids(kid(el, 'gsLst'), 'gs')
        .map((g) => ({ pos: Math.max(0, Math.min(1, (num(g.a.pos, 0) ?? 0) / 100000)), paint: this.paint(g.c[0], ph) }))
        .filter((s): s is { pos: number; paint: Paint } => !!s.paint)
        .sort((a, b) => a.pos - b.pos)
      if (stops.length > 1) return { color: stops[0].paint, stops, angle: (num(kid(el, 'lin')?.a.ang, 0) ?? 0) / 60000, radial: !!kid(el, 'path'), pattern }
      if (stops.length) return { color: stops[0].paint, pattern }
    }
    const p = this.paint(el.c[0], ph)
    return p ? { color: p, pattern } : ph ? { color: { hex: ph, trans: 0 }, pattern } : undefined
  }

  line(matrix: number, color: number, connector: boolean): ThemedLine | undefined {
    const ph = this.color(color)
    const i = this.index(matrix, 'line')
    const lines = connector && this.theme.connectorLines.length ? this.theme.connectorLines : this.theme.lines
    const exs = connector && this.theme.connectorLineEx.length ? this.theme.connectorLineEx : this.theme.lineEx
    const at = <T>(list: T[]): T | undefined => (i >= 1 ? list[Math.min(i, list.length) - 1] : undefined)
    const el = at(lines)
    const ex = at(exs) ?? {}
    if (!el) return ph ? { color: { hex: ph, trans: 0 }, pattern: 1, ex } : undefined
    const solid = kid(el, 'solidFill')
    const none = !!kid(el, 'noFill')
    const dash = kid(el, 'prstDash')?.a.val
    return {
      color: none ? undefined : (this.paint(solid?.c[0], ph) ?? (ph ? { hex: ph, trans: 0 } : undefined)),
      weight: el.a.w !== undefined ? (num(el.a.w, 9525) ?? 9525) / 914400 : undefined,
      pattern: none ? 0 : (ex.pattern ?? own(DASH_PATTERN, dash) ?? 1),
      ex,
    }
  }

  /** the text color and the Style bits (bold, italic…) */
  text(matrix: number, color: number, connector: boolean): { color?: Paint; style: number } {
    const ph = this.color(color)
    const i = this.index(matrix, 'font')
    const list = connector && this.theme.connectorFonts.length ? this.theme.connectorFonts : this.theme.fonts
    const f = i >= 1 ? list[Math.min(i, list.length) - 1] : undefined
    return { color: (f ? this.paint(f.color, ph) : undefined) ?? (ph ? { hex: ph, trans: 0 } : undefined), style: f?.style ?? 0 }
  }
}

/** how light a color is, 0-1 */
export function luminance(hex: string): number {
  return rgbToHsl(hexToRgb(hex))[2]
}

/** the color, as light as `lum` (0-1): its hue and saturation kept */
export function withLuminance(hex: string, lum: number): string {
  const hsl = rgbToHsl(hexToRgb(hex))
  hsl[2] = Math.max(0, Math.min(1, lum))
  return rgbToHex(hslToRgb(hsl))
}
