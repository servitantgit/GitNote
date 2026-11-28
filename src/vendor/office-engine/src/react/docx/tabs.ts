/**
 * Tab stops. The browser lays the text out and only knows tabs every so many spaces: where a paragraph sets its own
 * stops (or holds an absolute position tab), each of its tabs is an element of no width of its own that is given the
 * width that brings the text after it to the stop: to the left of it, centered on it, ending at it, or with its
 * decimal point on it. Done on the elements as they are drawn (and as they are measured), again after every change.
 */

const PX = 96 / 72
/** where a tab goes without a stop set: the next half inch */
const DEFAULT_STOP = 36 * PX

interface Stop {
  /** px from the text margin */
  pos: number
  a: string
  ld?: string
}

/** `data-tabs` of a paragraph element: "pos,a,ld;…" (pt), empty when it only holds absolute position tabs */
export function tabsAttr(tabs: { pos: number; a: string; ld?: string }[] | undefined): string {
  return (tabs ?? []).map((t) => `${+t.pos.toFixed(2)},${t.a}${t.ld ? ',' + t.ld : ''}`).join(';')
}

function stopsOf(attr: string): Stop[] {
  const out: Stop[] = []
  for (const part of attr.split(';')) {
    const [pos, a, ld] = part.split(',')
    if (a && Number.isFinite(Number(pos))) out.push({ pos: Number(pos) * PX, a, ld })
  }
  return out
}

/**
 * The width, on its first line, of what stands between the tab `from` and the tab `to` (the end of the paragraph
 * without one), px on screen; `decimal`: of its part before the decimal point. Read text by text: a range over the
 * elements between the two is not read the same by every browser.
 */
function widthBetween(pel: HTMLElement, from: HTMLElement, to: HTMLElement | undefined, decimal: boolean): number {
  const doc = pel.ownerDocument
  const range = doc.createRange()
  const walker = doc.createTreeWalker(pel, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  let top: number | undefined
  let a = Infinity
  let b = -Infinity
  const add = (rects: Iterable<DOMRect>) => {
    for (const r of rects) {
      if (!r.width) continue
      top ??= r.top
      // (what goes on on the next line is not what stands at the stop)
      if (Math.abs(r.top - top) > r.height / 2) continue
      a = Math.min(a, r.left)
      b = Math.max(b, r.right)
    }
  }
  let text = ''
  let started = false
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === from) started = true
    if (n === to) break
    if (!started || from.contains(n)) continue
    if (n.nodeType === 1) {
      // a picture, an equation: its box
      if ((n as Element).matches('img, math, svg')) add([(n as Element).getBoundingClientRect()])
      continue
    }
    const t = n.textContent ?? ''
    let upTo = t.length
    if (decimal) {
      // up to the first decimal point (a number without one ends at the stop)
      const at = (text + t).search(/[.,]\d|[.,]$/)
      if (at >= 0) upTo = Math.max(0, at - text.length)
      text += t
    }
    range.setStart(n, 0)
    range.setEnd(n, upTo)
    add(range.getClientRects())
    if (upTo < t.length) break
  }
  return b > a ? b - a : 0
}

function layoutPara(pel: HTMLElement) {
  const tabs = Array.from(pel.querySelectorAll<HTMLElement>('.de-tabchar')).filter((t) => t.closest('.de-p') === pel)
  if (!tabs.length) return
  const stops = stopsOf(pel.dataset.tabs ?? '')
  for (const t of tabs) {
    t.dataset.on = ''
    t.style.paddingLeft = '0'
  }
  const cs = (pel.ownerDocument.defaultView ?? window).getComputedStyle(pel)
  const px = (v: string) => parseFloat(v) || 0
  const edge = px(cs.borderLeftWidth)
  // the text margins, and the paragraph's indents inside them (px of the page, before its zoom)
  const width = pel.clientWidth
  const indL = px(cs.paddingLeft)
  const indR = px(cs.paddingRight)
  tabs.forEach((t, i) => {
    const box = pel.getBoundingClientRect()
    const scale = pel.offsetWidth ? box.width / pel.offsetWidth : 1
    const x = (t.getBoundingClientRect().left - box.left) / (scale || 1) - edge
    let stop: Stop
    const abs = t.dataset.ptab
    if (abs) {
      const [a, b] = t.dataset.rel === 'indent' ? [indL, width - indR] : [0, width]
      stop = { pos: abs === 'center' ? (a + b) / 2 : abs === 'right' ? b : a, a: abs, ld: t.dataset.ld }
    } else {
      // (a hanging indent is a stop too: the text after a tab on the first line starts where the other lines do)
      stop = stops.find((s) => s.pos > x + 0.5) ?? { pos: x < indL - 0.5 ? indL : (Math.floor((x + 0.5) / DEFAULT_STOP) + 1) * DEFAULT_STOP, a: 'left' }
      if (stop.ld) t.dataset.ld = stop.ld
      else delete t.dataset.ld
    }
    let w = stop.pos - x
    if (stop.a === 'center' || stop.a === 'right' || stop.a === 'decimal') {
      const seg = widthBetween(pel, t, tabs[i + 1], stop.a === 'decimal') / (scale || 1)
      w -= stop.a === 'center' ? seg / 2 : seg
    }
    t.style.paddingLeft = `${Math.max(0, w).toFixed(2)}px`
  })
}

/** lays out the tabs of every paragraph under `root` that sets tab stops */
export function layoutTabs(root: ParentNode | null | undefined) {
  if (!root) return
  for (const pel of root.querySelectorAll<HTMLElement>('.de-p[data-tabs]')) layoutPara(pel)
}
