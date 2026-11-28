/** Cells as text on the clipboard: tab separated, a line per row, as spreadsheet programs write and read them. */
import { translateFormula } from './formula'
import type { ClipCell } from './types'

/**
 * A copied cell repeated `dr` rows and `dc` columns further than the first copy of a block (the worker moves every
 * formula by the distance of the first block): its formula moved by what is left. The rest is as copied, the flag
 * of a dynamic array formula with it.
 */
export function shiftedClip(cell: ClipCell, dr: number, dc: number): ClipCell {
  if (!cell || cell[3] === undefined || (!dr && !dc)) return cell
  const out: NonNullable<ClipCell> = [...cell]
  out[3] = translateFormula(cell[3], dr, dc)
  return out
}

/** a cell written for other programs: quoted when it holds what separates cells and rows there */
export const tsvCell = (s: string) => (/["\t\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

/**
 * The rows of cells of clipboard text. A cell holding line breaks or tabs comes quoted (Excel, Google Sheets,
 * LibreOffice all do it), its own quotes doubled: read as one cell, not as the start of the next rows.
 */
export function parseTsv(raw: string): string[][] {
  const text = raw.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  const rows: string[][] = []
  let row: string[] = []
  let i = 0
  const n = text.length
  for (;;) {
    let cell = ''
    if (text[i] === '"') {
      // quoted, when the quote that closes it ends the cell; else a cell that merely starts with a quote
      let j = i + 1
      let v = ''
      let closed = false
      while (j < n) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            v += '"'
            j += 2
            continue
          }
          closed = j + 1 === n || text[j + 1] === '\t' || text[j + 1] === '\n'
          break
        }
        v += text[j++]
      }
      if (closed) {
        cell = v
        i = j + 1
      }
    }
    if (i < n && text[i] !== '\t' && text[i] !== '\n' && !(cell && text[i - 1] === '"')) {
      let j = i
      while (j < n && text[j] !== '\t' && text[j] !== '\n') j++
      cell = text.slice(i, j)
      i = j
    }
    row.push(cell)
    if (i >= n) break
    if (text[i] === '\n') {
      rows.push(row)
      row = []
    }
    i++
  }
  rows.push(row)
  return rows
}
