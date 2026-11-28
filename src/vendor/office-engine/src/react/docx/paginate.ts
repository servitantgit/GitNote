import type { Block, DocxMeta, HFKind, Paragraph } from '../../core/docx/types'

/**
 * The header and footer a page shows (`index`: 0-based) and the editable kind each is: the first page's when "different
 * first page" is on, else the even pages' when the file has different odd / even ones, else the default. An even page
 * without an even part shows none, as in Word.
 */
export function pageHF(meta: DocxMeta | undefined, index: number): { header?: Block[]; footer?: Block[]; hk: HFKind; fk: HFKind } {
  if (index === 0 && meta?.titlePg) return { header: meta.firstHeader, footer: meta.firstFooter, hk: 'firstHeader', fk: 'firstFooter' }
  if (meta?.evenOdd && index % 2 === 1) return { header: meta.evenHeader, footer: meta.evenFooter, hk: 'header', fk: 'footer' }
  return { header: meta?.header, footer: meta?.footer, hk: 'header', fk: 'footer' }
}

/**
 * Where a block can be split, as the measure pass read it: its lines (a paragraph) or rows (a table). A block without
 * one is placed whole.
 */
export interface Lines {
  /** the top of each line / row and the bottom of the last, from the top of the block (px) */
  ys: number[]
  /** paragraph: the offset each line starts at, read once a page ends inside the paragraph (undefined: not read yet) */
  at?: (number | undefined)[]
  /** table: how many leading rows repeat at the top of each following page (w:tblHeader) */
  head?: number
  /** table: row boundaries it does not break at (a merged cell going on below them would not fit above) */
  keep?: number[]
}

/**
 * The blocks [start, end) of a page and the height they take. The first may have begun on an earlier page (`from`),
 * the last may go on on the next one (`to`): lines of a paragraph, rows of a table.
 */
export interface PageSlice {
  start: number
  end: number
  used: number
  /** the line / row block `start` starts at on this page (0: its start) */
  from: number
  /** the line / row block `end - 1` stops before on this page; undefined: it ends here */
  to?: number
  /** text columns: where each column after the first starts, as [block, line / row] */
  cols?: [number, number][]
}

const EPS = 0.01

/** the header rows a table repeats at the top of the pages it goes on on: none when they leave no room for a row */
export function headOf(l: Lines | undefined, avail: number): number {
  const n = l ? l.ys.length - 1 : 0
  return l?.head && l.head < n && l.ys[l.head] - l.ys[0] < avail ? l.head : 0
}

/** the lines / rows a block is cut into: its measured lines, or one unit as tall as the block */
function unitsOf(h: number, l: Lines | undefined): { ys: number[]; n: number } {
  if (l && l.ys.length >= 2) return { ys: l.ys, n: l.ys.length - 1 }
  return { ys: [0, h], n: 1 }
}

/**
 * Cuts the blocks into pages. A paragraph that does not fit what is left of a page is split between two lines, a table
 * between two rows, its header rows repeated at the top of the next page; a block with no line or row that fits
 * starts the next page, and one that does not fit an empty page either (one line or one row taller than the page) is
 * placed anyway: its page grows (`used` > `avail`). The space after the last paragraph of a page needs no room.
 * Keep rules choose the cut: widow / orphan control, keep lines together, keep with next (see `kept`, `chain`).
 * With text columns (`cols` > 1) a page holds `cols` columns of `avail`, filled the same way one after the other;
 * `used` is the tallest.
 */
export function paginate(blocks: Block[], heights: WeakMap<Block, number>, count: number, avail: number, cols = 1, lastKind = 'nextPage', lines?: WeakMap<Block, Lines>): PageSlice[] {
  // a section's type says how it starts: the break after a section is the next section's ('continuous': no new page);
  // the last section's is the body's (known once loaded)
  const breakAfter = new Map<number, string>()
  let nextKind = lastKind
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.t !== 'sect') continue
    breakAfter.set(i, nextKind)
    nextKind = b.kind
  }
  const pages: PageSlice[] = []
  let cur: PageSlice = { start: 0, end: 0, used: 0, from: 0 }
  let col = 0
  /** height used in the column, and the same without the space after its last paragraph */
  let y = 0
  let ink = 0
  const colEnd = () => {
    cur.used = Math.max(cur.used, y <= avail + EPS ? y : Math.max(avail, ink))
    y = 0
    ink = 0
  }
  const newPage = (start: number, from: number) => {
    colEnd()
    pages.push(cur)
    cur = { start, end: start, used: 0, from }
    col = 0
  }
  /** the rest of the page or column is left empty; what comes next starts at line / row `k` of block `bi` */
  const advance = (bi: number, k: number) => {
    if (col + 1 < cols) {
      colEnd()
      col++
      ;(cur.cols ??= []).push([bi, k])
    } else newPage(bi, k)
  }
  /** what pagination needs to know of a block: where it can be cut, and the paragraph's keep rules */
  const shape = (b: Block) => {
    const h = heights.get(b) ?? 0
    const l = lines?.get(b)
    const { ys, n } = unitsOf(h, l)
    const table = b.t === 'tbl'
    const head = table ? headOf(l, avail) : 0
    // the last line of a paragraph ends before its space after; a table's bottom border is part of it
    return { h, ys, n, head, headH: head ? ys[head] - ys[0] : 0, keep: table && l?.keep?.length ? new Set(l.keep) : undefined, inkEnd: table ? h : ys[n], ps: b.t === 'p' ? b.ps : undefined }
  }
  type Shape = ReturnType<typeof shape>
  /** a cut before line / row `j` the block allows: a table below its header rows, not inside a merged cell kept whole */
  const cuts = (s: Shape, j: number) => j > 0 && j < s.n && j > s.head && !s.keep?.has(j)
  /**
   * the keep rules of a paragraph allow a part [k, j): it is not split when it keeps its lines together (and fits a
   * page); widow / orphan control (on unless turned off) leaves neither its first nor its last line alone on a page
   */
  const kept = (s: Shape, k: number, j: number) =>
    !s.ps || !((s.ps.keepLines && s.inkEnd <= avail + EPS) || (s.ps.widowControl !== false && ((k === 0 && j < 2) || s.n - j < 2)))
  /** the height of the smallest first part of a block (whole when it cannot be cut) */
  const firstPart = (s: Shape) => {
    for (let j = 1; j < s.n; j++) if (cuts(s, j) && kept(s, 0, j)) return s.ys[j]
    return s.inkEnd
  }
  /**
   * Keep with next: what block `i` needs on its page, with the paragraphs after it that keep with the next one too and
   * the first part of the block after them; `end`: that block. Infinity when that would not fit a page either: such a
   * chain is let go, its paragraphs are cut like the others (no page is pushed on forever).
   */
  const chain = (i: number): { need: number; end: number } => {
    let need = 0
    for (let m = i; m < count; m++) {
      const b = blocks[m]
      // a page break comes before the next block anyway
      if (b.t === 'sect' || (m > i && b.t === 'p' && b.pb)) return { need: 0, end: m }
      const s = shape(b)
      if (m > i && !s.ps?.keepNext) {
        need += firstPart(s)
        return { need: need > avail + EPS ? Infinity : need, end: m }
      }
      need += s.h
      if (need > avail + EPS) {
        let end = m + 1
        while (end < count && blocks[end].t === 'p' && (blocks[end] as Paragraph).ps.keepNext) end++
        return { need: Infinity, end }
      }
    }
    // what comes next is not measured yet
    return { need: 0, end: count }
  }
  /** blocks before this one belong to a chain let go */
  let loose = 0
  for (let i = 0; i < count; i++) {
    const b = blocks[i]
    if (b.t === 'sect') {
      cur.end = i + 1
      cur.to = undefined
      if (breakAfter.get(i) !== 'continuous') newPage(i + 1, 0)
      continue
    }
    if (b.t === 'p' && b.pb && cur.end > cur.start) newPage(i, 0)
    // most blocks fit whole: placed without working out where they could be cut (thousands of pages, every update)
    const bh = heights.get(b) ?? 0
    const free = !(b.t === 'p' && b.ps.keepNext && i >= loose)
    // (its lines are looked at only when the space after it may not fit)
    const bys = free && bh > avail - y + EPS && b.t === 'p' ? lines?.get(b)?.ys : undefined
    const bInk = !bys || bys.length < 2 ? bh : bys[bys.length - 1]
    if (free && bInk <= avail - y + EPS) {
      cur.end = i + 1
      cur.to = undefined
      y += bh
      ink = y - (bh - bInk)
      continue
    }
    const s = shape(b)
    const { h, ys, n, headH, inkEnd } = s
    const pieceH = (k: number, j: number) => (k > 0 ? headH - ys[k] : 0) + (j === n ? h : ys[j])
    const pieceInk = (k: number, j: number) => (k > 0 ? headH - ys[k] : 0) + (j === n ? inkEnd : ys[j])
    const place = (k: number, j: number) => {
      cur.end = i + 1
      cur.to = j < n ? j : undefined
      y += pieceH(k, j)
      ink = y - (j === n ? h - inkEnd : 0)
    }
    /** the last cut where the part from `k` fits `room` and `ok` allows */
    const best = (k: number, room: number, ok: (j: number) => boolean) => {
      let j = -1
      for (let x = k + 1; x < n && pieceInk(k, x) <= room + EPS; x++) if (ok(x)) j = x
      return j
    }
    for (let k = 0; ; ) {
      const room = avail - y
      // a paragraph kept with the next one starts the next page (or column) when they do not fit together here
      if (k === 0 && i >= loose && s.ps?.keepNext) {
        const c = chain(i)
        if (c.need === Infinity) loose = c.end
        else if (y > 0 && c.need > room + EPS) {
          advance(i, 0)
          continue
        }
      }
      if (pieceInk(k, n) <= room + EPS) {
        place(k, n)
        break
      }
      // the most lines / rows that fit
      let j = best(k, room, (x) => cuts(s, x) && kept(s, k, x))
      if (j < 0 && y > 0) {
        advance(i, k)
        continue
      }
      // at the top of a page or column the keep rules give way; when not even one line / row fits there, the smallest
      // part there is goes on it and its page grows
      if (j < 0) j = best(k, room, (x) => cuts(s, x))
      if (j < 0) {
        j = k + 1
        while (j < n && !cuts(s, j)) j++
      }
      place(k, j)
      if (j === n) break
      advance(i, j)
      k = j
    }
  }
  if (cur.end > cur.start || !pages.length) {
    colEnd()
    pages.push(cur)
  }
  return pages
}

/** the slice of each column of a page (one: the page itself) */
export function columnsOf(p: PageSlice): PageSlice[] {
  if (!p.cols?.length) return [p]
  const cuts: [number, number][] = [[p.start, p.from], ...p.cols]
  const last: [number, number] = p.to !== undefined ? [p.end - 1, p.to] : [p.end, 0]
  return cuts.map(([bi, k], c) => {
    const [eb, ek] = c + 1 < cuts.length ? cuts[c + 1] : last
    return { start: bi, from: k, end: ek > 0 ? eb + 1 : eb, to: ek > 0 ? ek : undefined, used: p.used }
  })
}

/** the lines / rows [from, to) of block `bi` that a page (or column) holds; to undefined: to its end */
export function pieceOf(p: PageSlice, bi: number): { from: number; to?: number } {
  return { from: bi === p.start ? p.from : 0, to: bi === p.end - 1 ? p.to : undefined }
}

/** the first and last page holding a part of block `bi`; [-1, -1] when none does (not laid out yet) */
export function pagesOf(pages: PageSlice[], bi: number): [number, number] {
  // pages are in block order: the first whose end is past the block
  let lo = 0
  let hi = pages.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (pages[m].end <= bi) lo = m + 1
    else hi = m
  }
  if (lo >= pages.length || pages[lo].start > bi) return [-1, -1]
  let last = lo
  while (last + 1 < pages.length && pages[last + 1].start <= bi && pages[last + 1].end > bi) last++
  return [lo, last]
}

/**
 * The page showing offset `o` of paragraph `bi` (a paragraph split across pages is on several); the first of its pages
 * when where its lines start is not read yet.
 */
export function pageAt(pages: PageSlice[], bi: number, o: number, l: Lines | undefined): number {
  const [first, last] = pagesOf(pages, bi)
  for (let pi = last; pi > first; pi--) {
    const at = l?.at?.[pieceOf(pages[pi], bi).from]
    if (at !== undefined && o >= at) return pi
  }
  return first
}
