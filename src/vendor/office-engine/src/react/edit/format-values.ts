import type { FormatCommand } from '../controller'

/** Shared with SizeBox: 1–400 points, rounded to the nearest half point. */
export function fontSize(pt: number): number | null {
  if (!Number.isFinite(pt) || pt < 1 || pt > 400) return null
  return Math.round(pt * 2) / 2
}

/** Only opaque hex is part of the write contract. CSS names/functions and transparency are rejected. */
function color(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const s = value.trim().toLowerCase()
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + s.slice(1).replace(/./g, '$&$&')
  if (/^#[0-9a-f]{6}$/.test(s)) return s
  if (/^#[0-9a-f]{6}ff$/.test(s)) return s.slice(0, 7)
  return undefined
}

/** Runtime validation also covers JavaScript and web-component hosts. Never turn an unknown op into clear. */
export function formatCommand(cmd: FormatCommand): FormatCommand | null {
  if (!cmd || typeof cmd !== 'object') return null
  switch (cmd.op) {
    case 'toggle': return ['bold', 'italic', 'underline', 'strike'].includes(cmd.mark) ? cmd : null
    case 'font': {
      if (typeof cmd.name !== 'string') return null
      const name = cmd.name.trim()
      return name && !/[\u0000-\u001f\u007f]/.test(name) ? { ...cmd, name } : null
    }
    case 'size': {
      const pt = fontSize(cmd.pt)
      return pt === null ? null : { ...cmd, pt }
    }
    case 'color':
    case 'highlight': {
      const c = color(cmd.color)
      return c === undefined ? null : { ...cmd, color: c }
    }
    case 'align': return ['left', 'center', 'right', 'justify'].includes(cmd.align) ? cmd : null
    case 'list': return cmd.list === null || cmd.list === 'bullet' || cmd.list === 'number' ? cmd : null
    case 'clear': return cmd
    default: return null
  }
}
