import { customIndexed, sheetColor } from '../color'
import { cssFont } from '../fonts'
import type { Theme } from '../theme'
import { kid, kids, num, onOff, type XEl } from '../xml'
import { BUILTIN_FORMATS } from './numfmt'
import type { CellCss } from './types'
import { dict } from '../dict'

interface Font {
  b?: boolean
  i?: boolean
  u?: string
  strike?: boolean
  sz?: number
  color?: string
  name?: string
}

const BORDER: Record<string, [number, string]> = dict({
  thin: [1, 'solid'], medium: [2, 'solid'], thick: [3, 'solid'], dashed: [1, 'dashed'], dotted: [1, 'dotted'],
  double: [3, 'double'], hair: [1, 'dotted'], mediumDashed: [2, 'dashed'], dashDot: [1, 'dashed'],
  mediumDashDot: [2, 'dashed'], dashDotDot: [1, 'dotted'], mediumDashDotDot: [2, 'dotted'], slantDashDot: [2, 'dashed'],
})

/** share of the foreground a pattern fill shows (the rest is the background): lines and grids as their ink coverage */
const PATTERN_INK: Record<string, number> = dict({
  gray125: 0.125, gray0625: 0.0625, lightGray: 0.25, mediumGray: 0.5, darkGray: 0.75,
  lightDown: 0.25, lightUp: 0.25, lightHorizontal: 0.25, lightVertical: 0.25, lightGrid: 0.3, lightTrellis: 0.3,
  darkDown: 0.5, darkUp: 0.5, darkHorizontal: 0.5, darkVertical: 0.5, darkGrid: 0.6, darkTrellis: 0.6,
})

/** `fg` over `bg` by `ink` (0…1), as a hex color; `fg` itself when a color is not plain hex */
function mixHex(fg: string, bg: string, ink: number): string {
  const f = /^#([0-9a-f]{6})$/i.exec(fg)
  const b = /^#([0-9a-f]{6})$/i.exec(bg)
  if (!f || !b) return fg
  let out = '#'
  for (let i = 0; i < 6; i += 2) out += Math.round(parseInt(f[1].slice(i, i + 2), 16) * ink + parseInt(b[1].slice(i, i + 2), 16) * (1 - ink)).toString(16).padStart(2, '0')
  return out
}

export interface XfInfo {
  numFmt: string
  /** font size in pt */
  fontPt: number
  css: CellCss
  /** explicit horizontal alignment */
  hAlign?: string
  wrap: boolean
  /** the cell is locked (the default): what a protected sheet refuses to change */
  locked: boolean
}

export interface SheetStyles {
  xfs: XfInfo[]
  baseFont: CellCss
}

export function parseSheetStyles(root: XEl | undefined, theme: Theme): SheetStyles {
  const indexed = customIndexed(root)
  const col = (el: XEl | undefined) => sheetColor(el, theme, indexed)
  const numFmts = new Map<number, string>()
  for (const f of kids(kid(root, 'numFmts'), 'numFmt')) numFmts.set(Number(f.a.numFmtId), f.a.formatCode ?? 'General')

  const fonts: Font[] = kids(kid(root, 'fonts'), 'font').map((f) => ({
    b: onOff(kid(f, 'b')),
    i: onOff(kid(f, 'i')),
    u: kid(f, 'u') ? kid(f, 'u')!.a.val ?? 'single' : undefined,
    strike: onOff(kid(f, 'strike')),
    sz: num(kid(f, 'sz')?.a.val),
    color: col(kid(f, 'color')),
    name: kid(f, 'name')?.a.val,
  }))
  const fills: (string | undefined)[] = kids(kid(root, 'fills'), 'fill').map((f) => {
    const pf = kid(f, 'patternFill')
    if (pf) {
      const t = pf.a.patternType
      if (!t || t === 'none') return undefined
      if (t === 'solid') return col(kid(pf, 'fgColor')) ?? col(kid(pf, 'bgColor'))
      // a pattern (dots, lines) is not drawn: the cell shows what the eye would see of it, its colors mixed
      return mixHex(col(kid(pf, 'fgColor')) ?? '#000000', col(kid(pf, 'bgColor')) ?? '#ffffff', PATTERN_INK[t] ?? 0.5)
    }
    const gf = kid(f, 'gradientFill')
    if (gf) {
      const stops = kids(gf, 'stop').map((s) => col(kid(s, 'color'))).filter(Boolean)
      if (stops.length >= 2) return `linear-gradient(${num(gf.a.degree, 90)! + 90}deg, ${stops.join(', ')})`
      return stops[0]
    }
    return undefined
  })
  const borders: CellCss[] = kids(kid(root, 'borders'), 'border').map((b) => {
    const css: CellCss = {}
    // a diagonal is a line across the cell: a gradient with a hard stripe (the 50 % line of "to bottom right" joins the top right and the bottom left corners)
    const dg = kid(b, 'diagonal')
    if (dg?.a.style && dg.a.style !== 'none') {
      const [w] = BORDER[dg.a.style] ?? [1]
      const color = col(kid(dg, 'color')) ?? '#000'
      const line = (to: string) => `linear-gradient(${to}, transparent calc(50% - ${w / 2}px), ${color} calc(50% - ${w / 2}px), ${color} calc(50% + ${w / 2}px), transparent calc(50% + ${w / 2}px))`
      const on = (v: string | undefined) => v === '1' || v === 'true'
      const lines = [on(b.a.diagonalUp) ? line('to bottom right') : '', on(b.a.diagonalDown) ? line('to top right') : ''].filter(Boolean)
      if (lines.length) css.backgroundImage = lines.join(', ')
    }
    const side = (el: XEl | undefined, key: string) => {
      const st = el?.a.style
      if (!st || st === 'none') return
      const [w, s] = BORDER[st] ?? [1, 'solid']
      css[key] = `${w}px ${s} ${col(kid(el, 'color')) ?? '#000'}`
    }
    side(kid(b, 'left') ?? kid(b, 'start'), 'borderLeft')
    side(kid(b, 'right') ?? kid(b, 'end'), 'borderRight')
    side(kid(b, 'top'), 'borderTop')
    side(kid(b, 'bottom'), 'borderBottom')
    return css
  })

  const f0 = fonts[0] ?? {}
  const baseFont: CellCss = {
    fontFamily: cssFont(f0.name ?? 'Calibri')!,
    fontSize: `${f0.sz ?? 11}pt`,
    color: f0.color ?? '#000000',
  }

  const xfs: XfInfo[] = kids(kid(root, 'cellXfs'), 'xf').map((xf) => {
    const css: CellCss = {}
    const id = num(xf.a.numFmtId, 0)!
    const font = fonts[num(xf.a.fontId, 0)!]
    if (font) {
      if (font.b) css.fontWeight = 700
      if (font.i) css.fontStyle = 'italic'
      const deco = [font.u && font.u !== 'none' ? 'underline' : '', font.strike ? 'line-through' : ''].filter(Boolean).join(' ')
      if (deco) css.textDecoration = deco
      if (font.u === 'double' || font.u === 'doubleAccounting') css.textDecorationStyle = 'double'
      if (font.sz && font.sz !== f0.sz) css.fontSize = `${font.sz}pt`
      if (font.color && font.color !== f0.color) css.color = font.color
      if (font.name && font.name !== f0.name) css.fontFamily = cssFont(font.name)!
    }
    const fill = fills[num(xf.a.fillId, 0)!]
    if (fill) css.background = fill
    Object.assign(css, borders[num(xf.a.borderId, 0)!])
    const al = kid(xf, 'alignment')
    let hAlign: string | undefined
    let wrap = false
    if (al) {
      const h = al.a.horizontal
      if (h && h !== 'general') {
        hAlign = h
        css.textAlign = h === 'center' || h === 'centerContinuous' ? 'center' : h === 'right' ? 'right' : h === 'justify' || h === 'distributed' ? 'justify' : 'left'
      }
      const v = al.a.vertical
      css.alignItems = v === 'top' ? 'flex-start' : v === 'center' ? 'center' : 'flex-end'
      wrap = al.a.wrapText === '1' || al.a.wrapText === 'true'
      if (wrap) css.whiteSpace = 'pre-wrap'
      // shrink to fit applies to text that does not wrap: the grid scales it down to the cell
      else if (al.a.shrinkToFit === '1' || al.a.shrinkToFit === 'true') css.shrinkToFit = 1
      const ind = num(al.a.indent)
      if (ind) css[hAlign === 'right' ? 'paddingRight' : 'paddingLeft'] = `${ind * 9 + 2}px`
      const rot = num(al.a.textRotation)
      if (rot) css.textRotate = rot === 255 ? 255 : rot > 90 ? 90 - rot : rot
    }
    const lock = kid(xf, 'protection')?.a.locked
    return { numFmt: numFmts.get(id) ?? BUILTIN_FORMATS[id] ?? 'General', fontPt: font?.sz ?? f0.sz ?? 11, css, hAlign, wrap, locked: lock !== '0' && lock !== 'false' }
  })
  if (!xfs.length) xfs.push({ numFmt: 'General', fontPt: f0.sz ?? 11, css: {}, wrap: false, locked: true })
  return { xfs, baseFont }
}
