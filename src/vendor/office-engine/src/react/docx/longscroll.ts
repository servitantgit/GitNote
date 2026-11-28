import { useEffect, useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import { useIsoLayoutEffect } from '../common/hooks'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * A scroll farther than this in one event (and than the box is high) may be a jump, not a step. Past the cap the
 * scrollbar's thumb moves the box by thousands of pixels for each of its own; the wheel and the keys stay under it.
 */
const JUMP = 2000
/** at each end of a long document, this much scrolls pixel for pixel: the box's range ends where the document does */
const EDGE = 1_000_000
/** the box rests after this long without a scroll (ms) */
const REST = 150

/**
 * Where a document taller than a browser lets a box scroll is, by the box's scroll position.
 *
 * The box scrolls over `maxTop` pixels, the document over `maxY`: more, past the cap. The place shown is the scroll
 * position plus `off`, and the pages are drawn `off` higher in the box than they are in the document.
 *
 * - A step (the wheel, a key, a selection dragged past an edge) leaves `off` alone: the browser moves the pages as far
 *   as it scrolls the box, once, as in a short document. So does a scroll of any length that ends on a page that is
 *   drawn: the browser brought something of it into view (the caret, what took the focus, `scrollIntoView`).
 * - A jump to where nothing is drawn (the scrollbar's thumb, Home, End) goes where the thumb says: `place()`.
 * - Steps add up to a box that is not where its thumb belongs for the place it shows, and that can reach an end of
 *   its range before the document ends. So when it rests, or cannot go on, it is scrolled to `home()` and `off`
 *   changed by as much (`settle`): nothing moves on screen.
 *
 * Pure numbers: the element is scrolled, and the pages are drawn, by `useLongScroll`.
 */
export class ScrollMap {
  /** the place shown minus the scroll position */
  off = 0
  /** the scroll position last seen or set */
  top = 0
  /** how far the document scrolls */
  maxY = 0
  /** how far the box scrolls */
  maxTop = 0
  private view = 0
  private zoom = 0
  /** a place to go to once the pages are drawn for the new range: the same one at another zoom, or in a document that fits the box again */
  private pending: number | null = null

  /** true when the document is longer than the box scrolls over */
  get capped(): boolean {
    return this.maxTop > 0 && this.maxY > this.maxTop
  }

  /** the last whole scroll position */
  private get last(): number {
    return Math.floor(this.maxTop)
  }

  private get edge(): number {
    return Math.min(EDGE, this.maxTop / 4)
  }

  /** The range, as the pages are laid out now. Called while rendering: what follows from a change of it is done by `refit`. */
  fit(maxY: number, maxTop: number, view: number, zoom: number) {
    const was = this.capped
    const y = this.top + (was ? this.off : 0)
    this.maxY = maxY
    this.maxTop = maxTop
    this.view = view
    // at another zoom, the place is as much farther down as the pages are taller; a shorter document keeps its scroll position, as it always did
    if (this.zoom && zoom !== this.zoom && (was || this.capped)) this.pending = ((this.pending ?? y) * zoom) / this.zoom
    // no longer capped (pages removed): the place it showed, by the scroll position alone
    else if (was && !this.capped && this.off) this.pending ??= y
    this.zoom = zoom
    if (!this.capped && this.pending === null) this.off = 0
  }

  /** the scroll position to set after a change of range, null when the place did not move */
  refit(): number | null {
    const y = this.pending
    this.pending = null
    return y === null ? null : this.to(y, true)
  }

  /** the place shown at the scroll position `top` */
  at(top = this.top): number {
    return this.capped ? clamp(top + this.off, 0, this.maxY) : top
  }

  /**
   * Where the box belongs for the place `y`: pixel for pixel near both ends of the document, in between as far along
   * its range as `y` is along the document's. One line through both, so `place` is its inverse.
   */
  home(y: number): number {
    const { edge, last, maxY } = this
    if (y <= edge) return Math.max(0, y)
    if (y >= maxY - edge) return Math.min(last, last - (maxY - y))
    return edge + ((y - edge) * (last - 2 * edge)) / (maxY - 2 * edge)
  }

  /** the place a box scrolled to `top` by a jump shows */
  place(top: number): number {
    const { edge, last, maxY } = this
    if (top <= edge) return Math.max(0, top)
    if (top >= last - edge) return Math.min(maxY, maxY - (last - top))
    return edge + ((top - edge) * (maxY - 2 * edge)) / (last - 2 * edge)
  }

  /**
   * The box was scrolled to `top` by the reader or the browser; `end`: it is as far down as it goes; `drawn`: it
   * shows a page that is drawn (asked after a long scroll only).
   * True when it cannot go on where the document does: it has to be settled now.
   */
  scrolled(top: number, end = top >= this.last, drawn: () => boolean = () => false): boolean {
    const d = top - this.top
    this.top = top
    if (!this.capped) return false
    // (a whole pixel of the document: the pages are not drawn at a fraction of one for it)
    if (Math.abs(d) > Math.max(this.view, JUMP) && !drawn()) this.off = (end ? this.maxY : Math.round(this.place(top))) - top
    const y = top + this.off
    return (top <= 0 && y > 0.5) || (end && y < this.maxY - 0.5)
  }

  /**
   * The scroll position to set for the place `y`. A place close by and in the box's reach is a step: the pages stay
   * where they are in the box. Any other one (and every one with `far`) is where the box belongs for it.
   */
  to(y: number, far = false): number {
    if (!this.capped) {
      this.off = 0
      return (this.top = clamp(y, 0, this.maxY))
    }
    y = clamp(y, 0, this.maxY)
    const step = y - this.off
    if (!far && Math.abs(y - this.at()) <= Math.max(this.view, JUMP) && step >= 0 && step <= this.last) return (this.top = step)
    this.top = Math.round(this.home(y))
    this.off = y - this.top
    return this.top
  }

  /** The scroll position the element took, after it was set: the place stays the one asked for. */
  landed(top: number) {
    if (this.capped && Math.abs(top - this.top) >= 1) this.off += this.top - top
    this.top = top
  }

  /** The scroll position that puts the box where it belongs for the place it shows; null when it is there. */
  settle(): number | null {
    if (!this.capped) return null
    const y = clamp(this.top + this.off, 0, this.maxY)
    const top = Math.round(this.home(y))
    // (a place out of the document, after pages were removed, is put back in it even when the box stays)
    if (Math.abs(top - this.top) < 1 && y === this.top + this.off) return null
    this.top = top
    this.off = y - top
    return top
  }
}

export interface LongScroll {
  x: number
  /** the scroll position the view was last drawn for */
  y: number
  /** how much higher the pages are drawn in the box than they are in the document: 0 until the document is longer than the box scrolls over */
  off: number
  map: ScrollMap
  /** scrolls to the place `y` of the document */
  to(y: number): void
  /** scrolls by `delta` pixels of the document */
  by(delta: number): void
  /** the place shown now, by the element's own scroll position (the view may not be drawn for it yet) */
  now(): number
}

/**
 * The scroll position of the box a document is paged in, batched to animation frames like `useScroll`, and the place
 * of the document it shows: the same number until the document is longer than a browser lets a box scroll (`ScrollMap`).
 * `pages`: a selector of the pages drawn in the box.
 */
export function useLongScroll(ref: React.RefObject<HTMLElement | null>, pages: string): LongScroll {
  const map = useMemo(() => new ScrollMap(), [])
  const [pos, setPos] = useState({ x: 0, y: 0, off: 0 })
  const [el, setEl] = useState<HTMLElement | null>(null)
  const read = () => {
    const e = ref.current
    if (e) setPos((p) => (p.x === e.scrollLeft && p.y === map.top && p.off === map.off ? p : { x: e.scrollLeft, y: map.top, off: map.off }))
  }
  /** scrolls the element to `top`, a position the map gave */
  const set = (e: HTMLElement, top: number) => {
    if (e.scrollTop !== top) e.scrollTop = top
    map.landed(e.scrollTop)
  }
  useIsoLayoutEffect(() => {
    const e = ref.current
    if (e !== el) setEl(e)
    // the range changed under the place shown (another zoom): the pages were drawn for it, the box follows before they are painted
    const top = e && map.refit()
    if (e && top !== null) {
      set(e, top)
      read()
    }
  })
  useEffect(() => {
    if (!el) return
    let raf = 0
    let rest: ReturnType<typeof setTimeout> | undefined
    const settle = () => {
      const top = map.settle()
      if (top === null) return
      // the box first, then the pages, drawn at once: both before the next paint, and nothing moves on screen
      set(el, top)
      flushSync(read)
    }
    /** true when a page that is drawn is in the box */
    const drawn = () => {
      const box = el.getBoundingClientRect()
      for (const p of el.querySelectorAll(pages)) {
        const r = p.getBoundingClientRect()
        if (r.bottom > box.top && r.top < box.bottom) return true
      }
      return false
    }
    const on = () => {
      const stuck = map.scrolled(el.scrollTop, el.scrollTop >= el.scrollHeight - el.clientHeight - 1, drawn)
      clearTimeout(rest)
      if (stuck) settle()
      else if (map.capped) rest = setTimeout(settle, REST)
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        read()
      })
    }
    map.scrolled(el.scrollTop)
    read()
    el.addEventListener('scroll', on, { passive: true })
    return () => {
      el.removeEventListener('scroll', on)
      cancelAnimationFrame(raf)
      clearTimeout(rest)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, map])
  const to = (y: number) => {
    const e = ref.current
    if (!e) return
    // a short document: the scroll position is the place, and the view follows the scroll event
    if (!map.capped) return void (e.scrollTop = clamp(y, 0, map.maxY))
    set(e, map.to(y))
    read()
  }
  const now = () => map.at(ref.current?.scrollTop ?? map.top)
  const by = (delta: number) => {
    const e = ref.current
    if (!e) return
    if (!map.capped) e.scrollTop += delta
    else to(now() + delta)
  }
  return { ...pos, map, to, by, now }
}
