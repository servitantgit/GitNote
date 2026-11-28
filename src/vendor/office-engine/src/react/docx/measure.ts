/**
 * What the measure pass reads of a rendered block beyond its height: where its rows (a table) or lines (a paragraph)
 * are, so that pagination can cut it between two of them.
 */
import type { Table } from '../../core/docx/types'
import type { Lines } from './paginate'

/**
 * The rows of a top-level table (`el`: its rendered block): their tops and the bottom of the last, the leading header
 * rows, and the row boundaries a merged cell spans when what it holds would not fit above them.
 */
export function tableLines(el: HTMLElement, t: Table): Lines | undefined {
  const trs = Array.from(el.querySelector('table')?.tBodies[0]?.rows ?? [])
  if (!trs.length || trs.length !== t.rows.length) return undefined
  const top = el.getBoundingClientRect().top
  const ys = trs.map((tr) => tr.getBoundingClientRect().top - top)
  ys.push(trs[trs.length - 1].getBoundingClientRect().bottom - top)
  let head = 0
  while (head < t.rows.length && t.rows[head].header) head++
  const keep = new Set<number>()
  trs.forEach((tr, r) => {
    for (const td of Array.from(tr.cells)) {
      if (td.rowSpan <= 1) continue
      // a merged cell going on on the next page keeps what it holds above the break
      const kids = td.children
      const cs = getComputedStyle(td)
      let need = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      if (kids.length) need += kids[kids.length - 1].getBoundingClientRect().bottom - kids[0].getBoundingClientRect().top
      for (let b = r + 1; b < Math.min(r + td.rowSpan, trs.length); b++) if (ys[b] - ys[r] < need - 0.5) keep.add(b)
    }
  })
  return { ys, head: head < t.rows.length ? head : 0, keep: keep.size ? [...keep] : undefined }
}

/**
 * The one range measuring uses. Every live Range is updated by the browser on each DOM removal: one per paragraph
 * measured, waiting for the garbage collector, would make removing the measured blocks slower and slower.
 */
let shared: Range | null = null
const theRange = () => (shared ??= document.createRange())

/** inline boxes measured as a whole (pictures, text boxes, list markers), not by the text inside them */
const ATOMIC = 'img, .de-tbox, .de-ph, .de-img-missing, .de-marker'

/**
 * The lines of a rendered paragraph (`el`: its box): the top of the first, the boundary between each two, the bottom
 * of the last, from the top of the box (px). The text boxes are read in order: one whose middle is below the bottom of
 * the line so far starts the next line; two lines meet halfway between the bottom of the one and the top of the other.
 */
export function paraLines(el: HTMLElement): Lines {
  const box = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  const top = parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth)
  const bottom = box.height - parseFloat(cs.paddingBottom) - parseFloat(cs.borderBottomWidth)
  const lines: { t: number; b: number }[] = []
  const add = (r: DOMRect) => {
    if (!r.height) return
    const t = r.top - box.top
    const b = r.bottom - box.top
    const cur = lines[lines.length - 1]
    if (cur && (t + b) / 2 <= cur.b) {
      cur.t = Math.min(cur.t, t)
      cur.b = Math.max(cur.b, b)
    } else lines.push({ t, b })
  }
  const range = theRange()
  const walk = (n: Node) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        range.selectNodeContents(c)
        for (const r of range.getClientRects()) add(r)
      } else if (c.nodeType === 1) {
        if ((c as Element).matches(ATOMIC)) add((c as Element).getBoundingClientRect())
        else walk(c)
      }
    }
  }
  walk(el)
  const ys = [top]
  for (let i = 1; i < lines.length; i++) {
    const y = (lines[i - 1].b + lines[i].t) / 2
    // lines that overlap that much are taken as one
    if (y > ys[ys.length - 1] + 0.5 && y < bottom - 0.5) ys.push(y)
  }
  ys.push(Math.max(bottom, top))
  return { ys }
}

/**
 * Where each line of a rendered paragraph starts (offsets in the paragraph; `ys` from `paraLines`): for each boundary,
 * the first character whose middle is below it (a binary search). Undefined when the characters cannot be told apart
 * that way.
 */
export function lineStarts(el: HTMLElement, ys: number[]): number[] | undefined {
  const top = el.getBoundingClientRect().top
  // the paragraph's runs, each one element: an object, or a text node
  const runs: { o: number; n: number; el: HTMLElement; text?: Text }[] = []
  for (const sp of el.querySelectorAll<HTMLElement>(':scope > [data-o], :scope > a > [data-o]')) {
    if (sp.hasAttribute('data-empty')) continue
    const o = Number(sp.dataset.o)
    if (sp.hasAttribute('data-obj')) runs.push({ o, n: 1, el: sp })
    else if (sp.childNodes.length === 1 && sp.firstChild!.nodeType === 3) runs.push({ o, n: (sp.firstChild as Text).length, el: sp, text: sp.firstChild as Text })
    else return undefined
  }
  if (!runs.length) return undefined
  const len = runs[runs.length - 1].o + runs[runs.length - 1].n
  const range = theRange()
  const runAt = (o: number) => {
    let lo = 0
    let hi = runs.length - 1
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1
      if (runs[m].o <= o) lo = m
      else hi = m - 1
    }
    return runs[lo]
  }
  /** the middle of the character at `o`, from the top of the paragraph */
  const mid = (o: number) => {
    const r = runAt(o)
    let rect: DOMRect
    if (!r.text) rect = r.el.getBoundingClientRect()
    else {
      let i = Math.min(o - r.o, r.n - 1)
      // the second half of a surrogate pair is where the first is
      if (i > 0 && (r.text.data.charCodeAt(i) & 0xfc00) === 0xdc00) i--
      range.setStart(r.text, i)
      range.setEnd(r.text, i + 1)
      rect = range.getBoundingClientRect()
    }
    return (rect.top + rect.bottom) / 2 - top
  }
  const at = [0]
  for (let k = 1; k < ys.length - 1; k++) {
    let lo = at[k - 1] + 1
    let hi = len
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (mid(m) > ys[k]) hi = m
      else lo = m + 1
    }
    // a line break belongs to the line it ends
    const r = lo < len ? runAt(lo) : undefined
    if (r?.text && r.text.data[lo - r.o] === '\n') lo++
    if (lo >= len) return undefined
    at.push(lo)
  }
  return at
}
