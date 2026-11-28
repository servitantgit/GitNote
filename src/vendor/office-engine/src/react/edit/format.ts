import type { FmtPatch } from '../../core/xlsx/types'
import { MARK_KEY, type FormatCommand, type TextFormat } from '../controller'
import type { DocxEditor, FormatState } from '../docx/DocxEditor'
import type { PptxEditor, PptxFormat } from '../pptx/PptxEditor'
import { fontName } from './Toolbar'

// The editors' formatting states as the controller's TextFormat, and its commands as editor calls: one formatting
// API for a host's toolbar, whichever kind of document is open. The controller validates each command before dispatch.

const ALIGNS = ['left', 'center', 'right', 'justify'] as const
const alignOf = (a: string | undefined): TextFormat['align'] => ALIGNS.find((x) => x === a)
/** sizes as the toolbars show them: to the half point */
const half = (n: number | undefined) => (n ? Math.round(n * 2) / 2 : undefined)

export function docxFormat(s: FormatState): TextFormat {
  return { bold: s.b, italic: s.i, underline: s.u, strike: s.strike, font: fontName(s.font) || undefined, size: half(s.sz), color: s.color, highlight: s.hl, align: alignOf(s.align), list: s.lst ?? null }
}

export function applyDocx(ed: DocxEditor, c: FormatCommand) {
  if (c.op === 'toggle') ed.toggle(MARK_KEY[c.mark])
  else if (c.op === 'font') ed.setFont(c.name)
  else if (c.op === 'size') ed.setSize(c.pt)
  else if (c.op === 'color') ed.setColor(c.color)
  else if (c.op === 'highlight') ed.setHighlight(c.color)
  else if (c.op === 'align') ed.setPara({ align: c.align }, { align: c.align })
  else if (c.op === 'list') ed.setList(c.list)
  else if (c.op === 'clear') ed.clearFormat()
}

export function pptxFormat(s: PptxFormat): TextFormat {
  return { bold: s.b, italic: s.i, underline: s.u, strike: s.strike, font: fontName(s.font) || undefined, size: half(s.sz), color: s.color, highlight: s.hl, align: alignOf(s.algn), list: s.bullet === 'bullet' || s.bullet === 'number' ? s.bullet : null }
}

export function applyPptx(ed: PptxEditor, c: FormatCommand) {
  if (c.op === 'toggle') ed.toggle(MARK_KEY[c.mark])
  else if (c.op === 'font') ed.setFont(c.name)
  else if (c.op === 'size') ed.setSize(c.pt)
  else if (c.op === 'color') ed.setColor(c.color)
  else if (c.op === 'highlight') ed.setHighlight(c.color)
  else if (c.op === 'align') ed.setAlign(c.align)
  else if (c.op === 'list') ed.setList(c.list)
  else if (c.op === 'clear') ed.clearFormat()
}

/** a CSS font size (px number or 'pt' string) in points */
const pt = (v: unknown) => (typeof v === 'string' && v.endsWith('pt') ? parseFloat(v) : typeof v === 'number' ? Math.round(v * 0.75 * 2) / 2 : undefined)

/** the active cell's formatting from its CSS, the workbook's base font where the cell sets none */
export function cellFormat(css: Record<string, string | number>, base: { fontFamily?: string; fontSize?: string | number }): TextFormat {
  const deco = String(css.textDecoration ?? '')
  const fill = typeof css.background === 'string' && !css.background.includes('gradient') ? css.background : undefined
  return {
    bold: css.fontWeight === 700,
    italic: css.fontStyle === 'italic',
    underline: deco.includes('underline'),
    strike: deco.includes('line-through'),
    font: fontName((css.fontFamily ?? base.fontFamily) as string | undefined) || undefined,
    size: pt(css.fontSize) ?? pt(base.fontSize),
    color: css.color as string | undefined,
    highlight: fill,
    align: alignOf(css.textAlign as string | undefined),
  }
}

/** a command as a cell format patch; null for what cells do not have (lists, justified text) */
export function cellPatch(c: FormatCommand, now: TextFormat): FmtPatch | null {
  if (c.op === 'toggle') return { [MARK_KEY[c.mark]]: !now[c.mark] }
  if (c.op === 'font') return { font: c.name }
  if (c.op === 'size') return { sz: c.pt }
  if (c.op === 'color') return { color: c.color }
  if (c.op === 'highlight') return { fill: c.color }
  if (c.op === 'align') return c.align === 'justify' ? null : { align: c.align }
  if (c.op === 'clear') return { clear: true }
  return null
}

/** the marks a command leaves (the part of the format the next toggle depends on): `now` with the command applied */
export function marksAfter(c: FormatCommand, now: TextFormat): TextFormat {
  if (c.op === 'toggle') return { ...now, [c.mark]: !now[c.mark] }
  if (c.op === 'clear') return { ...now, bold: false, italic: false, underline: false, strike: false }
  return now
}
