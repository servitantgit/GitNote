import { tsvCell } from '../../core/xlsx/clip'

/** the first table of an HTML clipboard as tab separated text (the page's text when it has none) */
export function htmlToTsv(html: string): string {
  // an inert document: nothing in it runs or loads
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const text = (el: Element) => {
    const copy = el.cloneNode(true) as Element
    copy.querySelectorAll('br').forEach((b) => b.replaceWith('\n'))
    copy.querySelectorAll('style,script').forEach((x) => x.remove())
    return (copy.textContent ?? '').replace(/[ \t\r\f ]+/g, ' ').replace(/ ?\n ?/g, '\n').trim()
  }
  const table = doc.querySelector('table')
  if (!table) return text(doc.body)
  const lines: string[] = []
  for (const tr of Array.from(table.rows)) {
    const vals: string[] = []
    for (const td of Array.from(tr.cells)) {
      vals.push(tsvCell(text(td)))
      for (let i = 1; i < Math.min(100, td.colSpan || 1); i++) vals.push('')
    }
    lines.push(vals.join('\t'))
  }
  return lines.join('\n')
}
