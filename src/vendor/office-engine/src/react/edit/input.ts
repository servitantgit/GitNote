/**
 * Controlled contentEditable: the DOM is only a view. Every mutation is taken from
 * `beforeinput` (cancelled) and applied to the model through a RichHost; IME
 * composition (Vietnamese Telex/VNI, CJK…) is committed on `compositionend`.
 */
import {
  collapsed, deleteRange, insertText, marksAt, nextBoundary, normalize, plen, prevBoundary, runAt, runsText, shiftPa, splitRuns, withMarks,
  type Pos, type RRun, type Sel,
} from './rich'

export interface RichPara {
  runs: RRun[]
}

export interface ReplaceOpts {
  label?: string
  /** rebuild paragraph DOM (after IME composition mutated it) */
  remount?: boolean
}

export interface RichHost<P extends RichPara = RichPara> {
  para(pa: string): P | undefined
  /** inclusive list of paragraph addresses from a to b in one container, or null */
  span(a: string, b: string): string[] | null
  prev(pa: string): string | undefined
  next(pa: string): string | undefined
  cmp(a: string, b: string): number
  /** replace contiguous paragraphs; `sel` is the selection afterwards */
  replace(pas: string[], next: P[], sel: Sel, opts?: ReplaceOpts): void
  withRuns(p: P, runs: RRun[]): P
  split(p: P, left: RRun[], right: RRun[], atEnd: boolean): [P, P]
  join(a: P, b: P, runs: RRun[]): P
  /** Backspace at offset 0 (e.g. leave a list); true when handled */
  backspaceAtStart?(pa: string, p: P): boolean
  /** Tab inside a paragraph (e.g. indent list); true when handled */
  tab?(sel: Sel, shift: boolean): boolean
  /** Enter in an empty paragraph (e.g. leave a list); true when handled */
  enterAtEmpty?(pa: string, p: P): boolean
  /** line breaks stay inside this paragraph (a code block): Enter and pasted lines make "\n", not paragraphs */
  keepsLines?(p: P): boolean
  /** Enter on the empty last line of such a paragraph: leave it for a new paragraph; true when handled */
  leaveLines?(pa: string, p: P): boolean
  /** ArrowRight / ArrowLeft with a caret that may have to leave a container (a table); true when handled */
  arrow?(sel: Sel, dir: 1 | -1): boolean
  /** copy / cut: puts the selection on the clipboard from the model; true when handled (the browser's own copy is skipped) */
  copy?(sel: Sel, data: DataTransfer, cut: boolean): boolean
  undo(): void
  redo(): void
  toggle?(key: 'b' | 'i' | 'u'): void
  shortcut?(e: KeyboardEvent): boolean
  /** style for text typed into an empty paragraph */
  defaultRun?(p: P): Partial<RRun> | undefined
  /** paste with formatting / files; true when handled */
  pasteRich?(sel: Sel, data: DataTransfer): boolean
  /** caret style for the next typed text (set after formatting a collapsed selection) */
  pendingStyle?(): Partial<RRun> | undefined
  clearPending?(): void
  onSelection?(sel: Sel | null): void
  /** the whole document (select all); null when there is nothing to select */
  all?(): Sel | null
  /** deletes a range that spans other blocks (tables): applies the change and returns the caret, or null when unsupported */
  deleteAcross?(s: Pos, e: Pos): Pos | null
  /** an IME composition ended and its text was put in: what waited for the end of it can be applied */
  composed?(): void
}

const NAV = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])

export function ordered(host: RichHost, s: Sel): [Pos, Pos] {
  const c = host.cmp(s.a.pa, s.f.pa)
  if (c < 0 || (c === 0 && s.a.o <= s.f.o)) return [s.a, s.f]
  return [s.f, s.a]
}

const caret = (p: Pos): Sel => ({ a: p, f: p })
const sameSel = (a: Sel, b: Sel) => a.a.pa === b.a.pa && a.a.o === b.a.o && a.f.pa === b.f.pa && a.f.o === b.f.o

// ---------------------------------------------------------------- model operations

interface Plan<P extends RichPara> {
  pas: string[]
  paras: P[]
  at: Pos
  /** the deletion is already applied (block-level, see RichHost.deleteAcross) */
  applied?: boolean
}

/** Removes the selected content (in memory); null when the selection spans containers. */
function planDelete<P extends RichPara>(host: RichHost<P>, sel: Sel): Plan<P> | null {
  const [s, e] = ordered(host, sel)
  if (s.pa === e.pa) {
    const p = host.para(s.pa)
    if (!p) return null
    return { pas: [s.pa], paras: [host.withRuns(p, deleteRange(p.runs, s.o, e.o))], at: s }
  }
  const list = host.span(s.pa, e.pa)
  if (!list) {
    const at = host.deleteAcross?.(s, e)
    const p = at && host.para(at.pa)
    return at && p ? { pas: [at.pa], paras: [p], at, applied: true } : null
  }
  const first = host.para(list[0])!
  const last = host.para(list[list.length - 1])!
  const runs = normalize([...splitRuns(first.runs, s.o)[0], ...splitRuns(last.runs, e.o)[1]])
  return { pas: list, paras: [host.join(first, last, runs)], at: s }
}

export function opDelete(host: RichHost, sel: Sel, opts?: ReplaceOpts) {
  const plan = planDelete(host, sel)
  if (!plan || plan.applied) return
  host.replace(plan.pas, plan.paras, caret(plan.at), opts)
}

function planAt(host: RichHost, sel: Sel): Plan<RichPara> | null {
  if (!collapsed(sel)) return planDelete(host, sel)
  const p = host.para(sel.a.pa)
  return p ? { pas: [sel.a.pa], paras: [p], at: sel.a } : null
}

/**
 * Inserts runs at the selection; `lines[i]` (i > 0) start new paragraphs.
 * `props[i]` can adjust the paragraph created for line i (e.g. heading style from pasted HTML).
 */
export function opInsertRuns(host: RichHost, sel: Sel, lines: RRun[][], opts: ReplaceOpts = {}, props?: ((p: RichPara) => RichPara)[]) {
  const plan = planAt(host, sel)
  if (!plan) return
  const p = plan.paras[0]
  const o = plan.at.o
  const [left, right] = splitRuns(p.runs, o)
  const near = runAt(p.runs, o) ?? (host.defaultRun?.(p) as RRun | undefined)
  // the look of the neighbouring run, not its tracked change
  const fallback = near?.tc ? (({ tc: _tc, ...rest }) => rest as RRun)(near) : near
  // pasted runs join the comment threads covering both sides of the paste, nothing else
  const cm = marksAt(p.runs, o)
  const fill = (runs: RRun[]) => runs.map((r) => withMarks(r.t === 'text' && !r.s && fallback ? { ...fallback, ...r, s: fallback.s, src: fallback.src } : r, cm))
  if (lines.length === 1) {
    const ins = fill(lines[0])
    const runs = normalize([...left, ...ins, ...right])
    host.replace(plan.pas, [host.withRuns(p, runs)], caret({ pa: plan.at.pa, o: o + plen(ins) }), { label: 'paste', ...opts })
    return
  }
  const out: RichPara[] = []
  let cur = host.withRuns(p, normalize([...left, ...fill(lines[0])]))
  if (props?.[0]) cur = props[0](cur)
  for (let i = 1; i < lines.length; i++) {
    const isLast = i === lines.length - 1
    const body = fill(lines[i])
    const [a, b0] = host.split(cur, cur.runs, normalize([...body, ...(isLast ? right : [])]), !isLast)
    out.push(a)
    cur = props?.[i] ? props[i](b0) : b0
  }
  out.push(cur)
  host.replace(plan.pas, out, caret({ pa: shiftPa(plan.at.pa, out.length - 1), o: plen(fill(lines[lines.length - 1])) }), { label: 'paste', ...opts })
}

export function opInsert(host: RichHost, sel: Sel, text: string, opts?: ReplaceOpts) {
  const plan = planAt(host, sel)
  if (!plan) return
  const style = host.pendingStyle?.()
  host.clearPending?.()
  const p = plan.paras[0]
  const o = plan.at.o
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length === 1 || opts?.label === 'linebreak' || host.keepsLines?.(p)) {
    // (a code block keeps pasted lines as its own)
    const t = lines.length > 1 ? lines.join('\n') : text
    const runs = insertText(p.runs, o, t, style, host.defaultRun?.(p))
    host.replace(plan.pas, [host.withRuns(p, runs)], caret({ pa: plan.at.pa, o: o + t.length }), { label: 'type', ...opts })
    return
  }
  const base = (style ? { ...(runAt(p.runs, o) ?? host.defaultRun?.(p) ?? {}), ...style } : undefined) as RRun | undefined
  opInsertRuns(host, sel, lines.map((l) => (l ? [{ ...(base ?? {}), t: 'text', text: l } as RRun] : [])), opts)
}

export function opEnter(host: RichHost, sel: Sel) {
  const plan = collapsed(sel) ? (() => {
    const p = host.para(sel.a.pa)
    return p ? { pas: [sel.a.pa], paras: [p], at: sel.a } : null
  })() : planDelete(host, sel)
  if (!plan) return
  const p = plan.paras[0]
  // Enter in an empty paragraph of a list ends the list (Word, Docs)
  if (collapsed(sel) && !plen(p.runs) && host.enterAtEmpty?.(sel.a.pa, p)) return
  if (host.keepsLines?.(p)) {
    // a code block: a new line, indented as the one before; on an empty last line, out of the block
    const text = runsText(p.runs)
    const o = plan.at.o
    if (collapsed(sel) && o === text.length && text.endsWith('\n') && host.leaveLines?.(sel.a.pa, p)) return
    const start = text.lastIndexOf('\n', o - 1) + 1
    const indent = collapsed(sel) ? /^[ \t]*/.exec(text.slice(start, o))![0] : ''
    opInsert(host, sel, '\n' + indent, { label: 'linebreak' })
    return
  }
  const [l, r] = splitRuns(p.runs, plan.at.o)
  const [a, b] = host.split(p, l, r, plan.at.o >= plen(p.runs))
  host.replace(plan.pas, [a, b], caret({ pa: shiftPa(plan.at.pa, 1), o: 0 }), { label: 'enter' })
}

export function opBackspace(host: RichHost, sel: Sel, word = false) {
  if (!collapsed(sel)) return opDelete(host, sel)
  const { pa, o } = sel.a
  const p = host.para(pa)
  if (!p) return
  if (o > 0) {
    const text = runsText(p.runs)
    let from = prevBoundary(text, o)
    if (word) {
      const m = /(\S+\s*|\s+)$/.exec(text.slice(0, o))
      if (m) from = o - m[0].length
    }
    host.replace([pa], [host.withRuns(p, deleteRange(p.runs, from, o))], caret({ pa, o: from }), { label: 'delete' })
    return
  }
  if (host.backspaceAtStart?.(pa, p)) return
  const prev = host.prev(pa)
  const pp = prev ? host.para(prev) : undefined
  if (!prev || !pp) return
  const merged = host.join(pp, p, normalize([...pp.runs, ...p.runs]))
  host.replace([prev, pa], [merged], caret({ pa: prev, o: plen(pp.runs) }), { label: 'merge' })
}

export function opDeleteForward(host: RichHost, sel: Sel, word = false) {
  if (!collapsed(sel)) return opDelete(host, sel)
  const { pa, o } = sel.a
  const p = host.para(pa)
  if (!p) return
  const len = plen(p.runs)
  if (o < len) {
    const text = runsText(p.runs)
    let to = nextBoundary(text, o)
    if (word) {
      const m = /^(\s*\S+|\s+)/.exec(text.slice(o))
      if (m) to = o + m[0].length
    }
    host.replace([pa], [host.withRuns(p, deleteRange(p.runs, o, to))], caret({ pa, o }), { label: 'delete' })
    return
  }
  const next = host.next(pa)
  const np = next ? host.para(next) : undefined
  if (!next || !np) return
  const merged = host.join(p, np, normalize([...p.runs, ...np.runs]))
  host.replace([pa, next], [merged], caret({ pa, o }), { label: 'merge' })
}

// ---------------------------------------------------------------- DOM mapping

/** the object span (a text box) a run span is inside of, within `stop` */
const objAbove = (s: Element, stop: Element): HTMLElement | null => {
  const up = s.parentElement?.closest<HTMLElement>('[data-o]')
  return up && up !== stop && stop.contains(up) ? up : null
}

function runSpan(n: Node | null, stop: Element): HTMLElement | null {
  const el = n && (n.nodeType === 1 ? (n as Element) : n.parentElement)
  let s = el?.closest('[data-o]') as HTMLElement | null
  if (!s || !stop.contains(s)) return null
  // inside a text box (its paragraphs have runs of their own): the box is the run of this paragraph
  for (let up = objAbove(s, stop); up; up = objAbove(s, stop)) s = up
  return s
}

function spanEnd(s: HTMLElement): number {
  const o = Number(s.dataset.o)
  if (s.hasAttribute('data-obj')) return o + 1
  if (s.hasAttribute('data-empty')) return o
  return o + (s.textContent?.length ?? 0)
}

/** the run spans of a paragraph element itself: not those of the paragraphs inside a text box anchored in it */
const ownSpans = (pel: HTMLElement): HTMLElement[] => Array.from(pel.querySelectorAll<HTMLElement>('[data-o]')).filter((s) => !objAbove(s, pel))

/** the offsets [from, to] a paragraph element shows: all of them, or those of its part when the paragraph is split */
const partOf = (el: HTMLElement): [number, number] => [Number(el.dataset.from ?? 0), el.dataset.to === undefined ? Infinity : Number(el.dataset.to)]

/**
 * The element of paragraph `pa` that shows offset `o`. A paragraph split across pages has one element per part, each
 * with the offsets it holds (`data-from`, `data-to`: absent for the first and the last). Where two parts meet the
 * offset is in both: the later one (the start of its first line), or with `upstream` the earlier one (the end of its
 * last line). Null when no element of the paragraph shows `o` (its page is not rendered).
 */
export function paraEl(root: ParentNode, pa: string, o: number, upstream = false): HTMLElement | null {
  let pick: HTMLElement | null = null
  for (const el of root.querySelectorAll<HTMLElement>(`[data-pa="${pa}"]`)) {
    const [from, to] = partOf(el)
    if (o >= from && o <= to && !(upstream && pick)) pick = el
  }
  return pick
}

/** the caret at a place is at the end of a part of its paragraph (the next part starts there) */
function atPartEnd(root: HTMLElement, node: Node | null, pos: Pos | null): boolean {
  const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest<HTMLElement>('[data-pa]')
  return !!el && !!pos && root.contains(el) && el.dataset.to !== undefined && pos.o === Number(el.dataset.to)
}

/**
 * DOM ranges over the offsets [a, b) of paragraph `pa`: one for each part of it shown, so that a range over the end of
 * a page does not take in what is between the parts (footer, header).
 */
export function paraRanges(root: HTMLElement, pa: string, a: number, b: number): Range[] {
  const out: Range[] = []
  for (const el of root.querySelectorAll<HTMLElement>(`[data-pa="${pa}"]`)) {
    const [from, to] = partOf(el)
    const x = Math.max(a, from)
    const y = Math.min(b, to)
    if (y < x || (y === x && b > a)) continue
    const s = domIn(el, x)
    const e = domIn(el, y)
    const r = document.createRange()
    r.setStart(s[0], s[1])
    r.setEnd(e[0], e[1])
    out.push(r)
  }
  return out
}

export function posFromDom(root: HTMLElement, node: Node, offset: number): Pos | null {
  const start = node.nodeType === 1 ? (node as Element) : node.parentElement
  const pel = start?.closest('[data-pa]') as HTMLElement | null
  if (!pel && node === root) {
    // A point counted in the editing root itself, before or after its paragraphs: what Firefox gives for "select all"
    // (Chromium puts the ends inside the text). The start of the paragraph it is before, the end of the last one.
    let p: HTMLElement | null = null
    for (let c: Node | null = root.childNodes[offset] ?? null; c && !p; c = c.nextSibling) {
      if (c.nodeType === 1) p = (c as Element).matches('[data-pa]') ? (c as HTMLElement) : (c as Element).querySelector<HTMLElement>('[data-pa]')
    }
    if (p) return { pa: p.dataset.pa!, o: Number(p.dataset.from ?? 0) }
    const all = root.querySelectorAll<HTMLElement>('[data-pa]')
    const last = all[all.length - 1]
    if (!last) return null
    const spans = ownSpans(last)
    return { pa: last.dataset.pa!, o: spans.length ? spanEnd(spans[spans.length - 1]) : Number(last.dataset.from ?? 0) }
  }
  if (!pel || !root.contains(pel)) return null
  const pa = pel.dataset.pa!
  if (!runSpan(node, pel)) {
    // boundary between runs: end of the last run span before the point (the start of the part when none is)
    const r = document.createRange()
    r.setStart(node, offset)
    r.collapse(true)
    let o = Number(pel.dataset.from ?? 0)
    for (const sp of ownSpans(pel)) {
      if (r.comparePoint(sp, sp.childNodes.length) < 0) o = spanEnd(sp)
      else break
    }
    return { pa, o }
  }
  const span = runSpan(node, pel)!
  const base = Number(span.dataset.o)
  if (span.hasAttribute('data-empty')) return { pa, o: base }
  if (span.hasAttribute('data-obj')) return { pa, o: offset > 0 || node !== span ? base + 1 : base }
  if (node.nodeType === 3) {
    let o = 0
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT)
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (t === node) return { pa, o: base + o + Math.min(offset, (t.textContent ?? '').length) }
      o += t.textContent?.length ?? 0
    }
    return { pa, o: base + o }
  }
  // an element inside the run (a code block's colored token): the text of the run before that point
  if (node !== span) {
    const r = (node.ownerDocument ?? document).createRange()
    r.setStart(span, 0)
    r.setEnd(node, offset)
    return { pa, o: base + r.toString().length }
  }
  // offset is a child index inside the span
  let o = 0
  for (let i = 0; i < Math.min(offset, span.childNodes.length); i++) o += span.childNodes[i].textContent?.length ?? 0
  return { pa, o: base + o }
}

export function domFromPos(root: HTMLElement, pos: Pos, upstream = false): [Node, number] | null {
  const pel = paraEl(root, pos.pa, pos.o, upstream)
  return pel && domIn(pel, pos.o)
}

/** the DOM place of offset `o` in a paragraph element (or the part of one that holds it) */
function domIn(pel: HTMLElement, at: number): [Node, number] {
  const pos = { o: at }
  const spans = ownSpans(pel)
  if (!spans.length) return [pel, pel.childNodes.length]
  let pick: HTMLElement | undefined
  for (const s of spans) {
    const o = Number(s.dataset.o)
    const end = spanEnd(s)
    if (pos.o >= o && pos.o <= end) {
      pick = s
      // prefer the left run at boundaries unless it is an object
      if (pos.o < end || !s.hasAttribute('data-obj')) break
    }
  }
  pick ??= spans[spans.length - 1]
  const o = Number(pick.dataset.o)
  if (pick.hasAttribute('data-obj') || pick.hasAttribute('data-empty')) {
    const parent = pick.parentNode!
    const idx = Array.prototype.indexOf.call(parent.childNodes, pick)
    if (pick.hasAttribute('data-empty')) {
      const t = pick.firstChild
      return t ? [t, 0] : [parent, idx]
    }
    return [parent, pos.o > o ? idx + 1 : idx]
  }
  let rem = Math.max(0, pos.o - o)
  const walker = document.createTreeWalker(pick, NodeFilter.SHOW_TEXT)
  let last: Node | null = null
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const n = t.textContent?.length ?? 0
    if (rem <= n) return [t, rem]
    rem -= n
    last = t
  }
  return last ? [last, last.textContent?.length ?? 0] : [pick, 0]
}

/** Selection object that can see into the shadow root containing `node` (web component embeds). */
export function getSel(node: Node): Selection | null {
  const rn = node.getRootNode() as (ShadowRoot & { getSelection?: () => Selection | null }) | Document
  if (typeof ShadowRoot !== 'undefined' && rn instanceof ShadowRoot && typeof rn.getSelection === 'function') return rn.getSelection()
  return (node.ownerDocument ?? document).getSelection()
}

interface SelPoints {
  anchorNode: Node | null
  anchorOffset: number
  focusNode: Node | null
  focusOffset: number
}

/** both ends of the selection, as nodes inside the shadow root containing `root` when there is one */
export function selPoints(root: HTMLElement): SelPoints | null {
  const rn = root.getRootNode()
  const s = getSel(root)
  if (!s) return null
  if (typeof ShadowRoot !== 'undefined' && rn instanceof ShadowRoot && s.anchorNode && !root.contains(s.anchorNode)) {
    // standard path for shadow trees (Safari / Firefox / new Chrome)
    const gc = (s as Selection & { getComposedRanges?: (o: { shadowRoots: ShadowRoot[] }) => StaticRange[] }).getComposedRanges
    const r = gc?.call(s, { shadowRoots: [rn] })[0]
    if (r) return { anchorNode: r.startContainer, anchorOffset: r.startOffset, focusNode: r.endContainer, focusOffset: r.endOffset }
  }
  // Firefox selects the cells of a table dragged over as cells: a range around each one, counted in its row. Read as
  // the selection from the start of the first cell to the end of the last one.
  const row = (n: Node | null) => n?.nodeType === 1 && (n as Element).tagName === 'TR'
  if (s.rangeCount > 1 || row(s.anchorNode) || row(s.focusNode)) {
    const first = s.getRangeAt(0)
    const last = s.getRangeAt(s.rangeCount - 1)
    const [anchorNode, anchorOffset] = intoCell(first.startContainer, first.startOffset, false)
    const [focusNode, focusOffset] = intoCell(last.endContainer, last.endOffset, true)
    return { anchorNode, anchorOffset, focusNode, focusOffset }
  }
  return s
}

/** a point counted in a table row (before / after a cell of it): the start of the cell's first paragraph, the end of its last */
function intoCell(node: Node, offset: number, end: boolean): [Node, number] {
  if (node.nodeType !== 1 || (node as Element).tagName !== 'TR') return [node, offset]
  const cell = node.childNodes[end ? offset - 1 : offset] as Element | undefined
  const paras = cell?.querySelectorAll?.('[data-pa]')
  const p = paras?.length ? paras[end ? paras.length - 1 : 0] : undefined
  return p ? [p, end ? p.childNodes.length : 0] : [node, offset]
}

// ---------------------------------------------------------------- controller

const attachedInputs = new WeakMap<HTMLElement, RichInput>()

/** Return keyboard focus from a toolbar field to the editor's current model selection. */
export function focusWithSelection(element: HTMLElement) {
  const input = attachedInputs.get(element)
  const selection = input?.formatSelection()
  element.focus({ preventScroll: true })
  if (selection) input?.restore(selection)
}

export class RichInput {
  root: HTMLElement | null = null
  private composing: Sel | null = null
  private justComposed = ''
  private raf = 0
  private last: Sel | null = null
  /** the last selection known; assigning it makes it the selection (what an edit asked for no longer holds) */
  get lastSel(): Sel | null {
    return this.last
  }
  set lastSel(sel: Sel | null) {
    this.last = sel
    this.expected = null
  }
  /** A live formatting target remains valid while a focused host control owns DOM focus. */
  private formatTarget: Sel | null = null
  private attachedRoot: HTMLElement | null = null
  private commandSelection: Sel | null = null
  formatting = false
  /** select all: the model selection covers every paragraph, the DOM one only what is rendered */
  private override: { model: Sel; dom: Sel } | null = null
  /**
   * The caret an edit asked for, until the DOM shows it: the next key press can come before the view is rebuilt, and
   * the DOM caret is then still where the edit was made (typing without a pause across a paragraph break).
   */
  private expected: Sel | null = null
  /** where the DOM selection last was in a paragraph: a view update that removes this node leaves the caret on the page element */
  private seen: Node | null = null
  /** a selection change was not followed yet when the input was detached: the next attach reads the selection */
  private missedSel = false
  /**
   * The caret was last seen at the end of a part of a paragraph split across pages (the end of a page), not at the
   * start of the next part, which is the same offset: a caret put back there (after typing) stays on that side.
   */
  private upstream = false

  constructor(private host: RichHost) {}

  attach(root: HTMLElement) {
    if (this.root === root) return
    this.detach()
    if (this.attachedRoot !== root) this.clearSelection()
    this.attachedRoot = root
    this.root = root
    attachedInputs.set(root, this)
    root.addEventListener('beforeinput', this.onBeforeInput)
    root.addEventListener('compositionstart', this.onCompStart)
    root.addEventListener('compositionend', this.onCompEnd)
    root.addEventListener('keydown', this.onKeyDown)
    root.addEventListener('mousedown', this.onMouseDown)
    root.addEventListener('focus', this.onFocus)
    root.addEventListener('copy', this.onCopy)
    root.addEventListener('cut', this.onCopy)
    document.addEventListener('selectionchange', this.onSelChange)
    // a selection change whose frame a detach cancelled (a re-render re-attaching in between) is followed now
    if (this.missedSel) {
      this.missedSel = false
      this.onSelChange()
    }
  }

  detach() {
    const r = this.root
    if (!r) return
    if (attachedInputs.get(r) === this) attachedInputs.delete(r)
    r.removeEventListener('beforeinput', this.onBeforeInput)
    r.removeEventListener('compositionstart', this.onCompStart)
    r.removeEventListener('compositionend', this.onCompEnd)
    r.removeEventListener('keydown', this.onKeyDown)
    r.removeEventListener('mousedown', this.onMouseDown)
    r.removeEventListener('focus', this.onFocus)
    r.removeEventListener('copy', this.onCopy)
    r.removeEventListener('cut', this.onCopy)
    document.removeEventListener('selectionchange', this.onSelChange)
    if (this.raf) this.missedSel = true
    cancelAnimationFrame(this.raf)
    this.raf = 0 // or the next selection change waits forever for a frame that was cancelled
    this.root = null
    this.expected = null
    this.seen = null
  }

  clearSelection() {
    this.override = null
    this.formatTarget = null
    this.lastSel = null
    this.expected = null
    this.seen = null
  }

  get focused() {
    const root = this.root
    const active = (root?.getRootNode() as Document | ShadowRoot | undefined)?.activeElement
    return !!root && (active === root || !!active && root.contains(active))
  }

  get isComposing() {
    return !!this.composing
  }

  readSel(): Sel | null {
    const root = this.root
    const s = root ? selPoints(root) : null
    if (!root || !s || !s.anchorNode || !s.focusNode) return null
    if (!root.contains(s.anchorNode) || !root.contains(s.focusNode)) return null
    const a = posFromDom(root, s.anchorNode, s.anchorOffset)
    const f = posFromDom(root, s.focusNode, s.focusOffset)
    if (a && f) {
      this.seen = s.anchorNode
      this.upstream = atPartEnd(root, s.focusNode, f)
    }
    return a && f ? { a, f } : null
  }

  /** the caret an edit asked for, which key presses go by until the view shows it (see `expected`) */
  expect(sel: Sel) {
    this.expected = sel
  }

  /** where the caret is going to be: the one an edit asked for, else the last known */
  get caret(): Sel | null {
    return this.expected ?? this.last
  }

  /** the selection a key press acts on */
  private live(): Sel | null {
    return this.commandSelection ?? this.override?.model ?? this.expected ?? this.sel()
  }

  /**
   * After the view was rebuilt: a caret whose paragraph was removed from the DOM (it moved to another page) sits on the
   * page element, outside every paragraph. Puts it back at the last known place.
   */
  repair(): boolean {
    const root = this.root
    const seen = this.seen
    if (!root || this.composing || this.override || !seen || seen.isConnected || !this.lastSel) return false
    const s = selPoints(root)
    if (!s?.anchorNode || !root.contains(s.anchorNode) || this.readSel()) return false
    this.seen = null
    return this.restore(this.lastSel, false)
  }

  /** current selection, falling back to the last known one (e.g. after focusing a toolbar control) */
  sel(): Sel | null {
    return this.commandSelection ?? this.override?.model ?? this.readSel() ?? this.lastSel
  }

  /** Keep a logical target for any focused host element, including keyboard-operated buttons and menus. */
  private activeHost(): Element | null {
    const root = this.root
    if (!root) return null
    let active = root.ownerDocument.activeElement
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
    if (!active || root.contains(active)) return null
    // A focusable page wrapper is background, including ancestors outside a web component's shadow root.
    let scope: Node = root
    for (;;) {
      if (active.contains(scope)) return null
      const tree = scope.getRootNode()
      if (!(tree instanceof ShadowRoot)) return active
      scope = tree.host
    }
  }

  /** Use the exact published logical target for one command, without affecting later undo/navigation. */
  withFormatSelection(sel: Sel, apply: () => void) {
    this.commandSelection = sel
    this.formatting = true
    this.lastSel = sel
    try { apply() } finally {
      this.commandSelection = null
      this.formatting = false
    }
  }

  formatSelection(): Sel | null {
    // a select-all covers the whole document, though only the rendered paragraphs are selected in the DOM (and lastSel)
    const sel = this.activeHost() ? (this.override?.model ?? (this.formatTarget && this.lastSel)) : (this.override?.model ?? this.readSel())
    return sel && this.host.para(sel.a.pa) && this.host.para(sel.f.pa) ? sel : null
  }

  /**
   * Selects the whole document. The browser's own select-all is useless here: the editing host holds
   * non-editable parts (headers, read-only paragraphs) and Chromium empties a selection that crosses them;
   * pages are also virtualized, so the DOM only ever holds a part of the document.
   */
  selectAll(): boolean {
    const root = this.root
    const all = this.host.all?.()
    if (!root || !all) return false
    const paras = Array.from(root.querySelectorAll<HTMLElement>('[data-pa]')).filter((el) => {
      const ro = el.closest('[contenteditable="false"]')
      return this.host.para(el.dataset.pa!) && !(ro && root.contains(ro))
    })
    const first = paras[0]
    const last = paras[paras.length - 1]
    // (the first and last elements may be parts of paragraphs split across pages: what they show)
    const dom: Sel = first && last ? { a: { pa: first.dataset.pa!, o: partOf(first)[0] }, f: { pa: last.dataset.pa!, o: Math.min(partOf(last)[1], plen(this.host.para(last.dataset.pa!)!.runs)) } } : all
    this.restore(dom)
    this.override = { model: all, dom: this.readSel() ?? dom }
    this.host.onSelection?.(all)
    return true
  }

  /** a select-all is held: the selection is the whole document, though the DOM holds only the pages shown */
  get selectingAll(): boolean {
    return !!this.override
  }

  /** after the document changed under a held select-all (a collaborator's edit): it is the whole document as it is now */
  renewSelectAll(): Sel | null {
    const all = this.host.all?.()
    if (!this.override || !all) return null
    this.override = { ...this.override, model: all }
    return all
  }

  /**
   * The paragraphs holding the selection were laid out again (a page now ends elsewhere in them): when the DOM
   * selection no longer shows the model's, it is put back.
   */
  reflow(): boolean {
    const want = this.expected ?? this.last
    // Replacing the DOM selection can focus the editor. Keep the host's focus when wrapping changes.
    if (!this.focused || this.composing || this.override || !want) return false
    const now = this.readSel()
    if (now && sameSel(now, want)) return false
    // a selection in other paragraphs is a new one (its change is not read yet), not the model's moved by the cut
    if (now && (now.a.pa !== want.a.pa || now.f.pa !== want.f.pa)) return false
    return this.restore(want, false)
  }

  /** Applies a model selection to the DOM; false when its paragraph isn't rendered. */
  restore(sel: Sel | null, focus: boolean | 'preserve' = this.formatting ? 'preserve' : true): boolean {
    const root = this.root
    if (!root || !sel) return false
    const active = (root.getRootNode() as Document | ShadowRoot).activeElement
    if (focus === 'preserve' && active !== root && !root.contains(active)) {
      this.lastSel = sel
      return true
    }
    // putting back the selection a select-all holds keeps the select-all: an edit the worker reports after the
    // select-all rebuilds its paragraph, and the view then restores the selection around it
    const ov = this.override
    const held = ov && (sameSel(sel, ov.dom) || sameSel(sel, ov.model)) ? ov : null
    if (held) sel = held.dom
    this.override = null
    const up = this.upstream && collapsed(sel)
    const a = domFromPos(root, sel.a, up)
    const f = domFromPos(root, sel.f, up)
    if (!a || !f) {
      if (held) {
        this.override = held
        return true
      }
      // not in the DOM (its page is not shown): the DOM caret is somewhere else, and key presses go by this one
      this.last = sel
      this.expected = sel
      return false
    }
    if (focus === true && active !== root && !root.contains(active)) root.focus({ preventScroll: true })
    const s = getSel(root)
    try {
      s?.setBaseAndExtent(a[0], a[1], f[0], f[1])
    } catch {
      /* node vanished */
    }
    this.lastSel = sel
    this.expected = null
    this.formatTarget = held ? held.model : sel
    this.override = held
    return true
  }

  private rangeSel(r: StaticRange | Range | undefined): Sel | null {
    if (!r || !this.root) return null
    const a = posFromDom(this.root, r.startContainer, r.startOffset)
    const f = posFromDom(this.root, r.endContainer, r.endOffset)
    return a && f ? { a, f } : null
  }

  private onBeforeInput = (e: InputEvent) => {
    const t = e.inputType
    if (this.composing || t === 'insertCompositionText') return
    if (t === 'deleteCompositionText' || t === 'insertFromComposition') {
      if (e.cancelable) e.preventDefault()
      if (t === 'insertFromComposition' && e.data && e.data !== this.justComposed) {
        const sel = this.live()
        if (sel) opInsert(this.host, sel, e.data, { remount: true })
      }
      this.justComposed = ''
      return
    }
    e.preventDefault()
    const target = this.rangeSel(e.getTargetRanges?.()[0])
    const sel = this.live()
    if (!sel) return
    const h = this.host
    switch (t) {
      case 'insertText':
      case 'insertReplacementText': {
        const text = e.data ?? e.dataTransfer?.getData('text/plain') ?? ''
        opInsert(h, t === 'insertReplacementText' && target ? target : sel, text)
        break
      }
      case 'insertParagraph':
        opEnter(h, sel)
        break
      case 'insertLineBreak':
        opInsert(h, sel, '\n', { label: 'linebreak' })
        break
      case 'insertFromPaste':
      case 'insertFromDrop':
      case 'insertFromYank': {
        if (e.dataTransfer && h.pasteRich?.(t === 'insertFromDrop' && target ? target : sel, e.dataTransfer)) break
        const text = e.dataTransfer?.getData('text/plain') ?? e.data ?? ''
        if (text) opInsert(h, sel, text)
        break
      }
      case 'deleteContentBackward':
        opBackspace(h, sel)
        break
      case 'deleteWordBackward':
        opBackspace(h, sel, true)
        break
      case 'deleteContentForward':
        opDeleteForward(h, sel)
        break
      case 'deleteWordForward':
        opDeleteForward(h, sel, true)
        break
      case 'deleteSoftLineBackward':
      case 'deleteHardLineBackward':
      case 'deleteSoftLineForward':
      case 'deleteHardLineForward':
      case 'deleteByCut':
      case 'deleteByDrag':
      case 'deleteContent':
      case 'deleteEntireSoftLine':
        if (!collapsed(sel)) opDelete(h, sel)
        else if (target && !collapsed(target)) opDelete(h, target)
        break
      case 'historyUndo':
        h.undo()
        break
      case 'historyRedo':
        h.redo()
        break
      case 'formatBold':
        h.toggle?.('b')
        break
      case 'formatItalic':
        h.toggle?.('i')
        break
      case 'formatUnderline':
        h.toggle?.('u')
        break
    }
  }

  private onCompStart = () => {
    this.composing = this.live()
  }

  private onCompEnd = (e: CompositionEvent) => {
    const sel = this.composing
    this.composing = null
    if (!sel) return
    this.justComposed = e.data ?? ''
    // always rebuild the paragraph: the IME mutated its DOM
    if (e.data) opInsert(this.host, sel, e.data, { remount: true })
    else opInsert(this.host, sel, '', { remount: true })
    setTimeout(() => (this.justComposed = ''), 0)
    this.host.composed?.()
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || this.composing) return
    const mod = e.metaKey || e.ctrlKey
    const k = e.key.toLowerCase()
    if (this.host.shortcut?.(e)) {
      e.preventDefault()
      return
    }
    if (mod && !e.altKey) {
      if (k === 'z') {
        e.preventDefault()
        if (e.shiftKey) this.host.redo()
        else this.host.undo()
        return
      }
      if (k === 'y') {
        e.preventDefault()
        this.host.redo()
        return
      }
      if (k === 'a' && !e.shiftKey) {
        if (this.selectAll()) e.preventDefault()
        return
      }
      if (k === 'b' || k === 'i' || k === 'u') {
        e.preventDefault()
        this.host.toggle?.(k)
        return
      }
    }
    if (NAV.has(e.key)) this.expected = null
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !mod && !e.altKey && this.crossPart(e.key === 'ArrowRight' ? 1 : -1, e.shiftKey)) {
      e.preventDefault()
      return
    }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !mod && !e.shiftKey && !e.altKey) {
      const sel = this.live()
      if (sel && collapsed(sel) && this.host.arrow?.(sel, e.key === 'ArrowRight' ? 1 : -1)) e.preventDefault()
      return
    }
    if (e.key === 'Tab' && !mod) {
      e.preventDefault()
      const sel = this.live()
      if (!sel) return
      if (!this.host.tab?.(sel, e.shiftKey) && !e.shiftKey) opInsert(this.host, sel, '\t')
    }
  }

  /**
   * ArrowRight at the end of a part of a paragraph split across pages, ArrowLeft at the start of one: the browser would
   * move to the other part at the same offset (the caret seems stuck). The caret moves one character into it instead,
   * as over the end of a line. `extend`: Shift, the selection grows.
   */
  private crossPart(dir: 1 | -1, extend: boolean): boolean {
    const root = this.root
    const s = root && selPoints(root)
    const el = s?.focusNode && (s.focusNode.nodeType === 1 ? (s.focusNode as Element) : s.focusNode.parentElement)?.closest<HTMLElement>('[data-pa]')
    if (!root || !el || !root.contains(el) || (el.dataset.from === undefined && el.dataset.to === undefined)) return false
    const sel = this.readSel()
    const p = sel && this.host.para(sel.f.pa)
    if (!sel || !p || (!extend && !collapsed(sel))) return false
    const [from, to] = partOf(el)
    const text = runsText(p.runs)
    let o: number
    if (dir === 1 && to !== Infinity && sel.f.o >= to) o = nextBoundary(text, to)
    else if (dir === -1 && from > 0 && sel.f.o <= from) o = prevBoundary(text, from)
    else return false
    const f = { pa: sel.f.pa, o }
    if (!this.restore(extend ? { a: sel.a, f } : caret(f))) return false
    // shown: the view scrolls to it (the browser does that for the caret it moves itself)
    const n = getSel(root)?.focusNode
    const r = n && document.createRange()
    if (r && n) {
      r.setStart(n, getSel(root)!.focusOffset)
      const box = r.getBoundingClientRect()
      let sc = root.parentElement
      while (sc && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement
      const view = sc?.getBoundingClientRect()
      if (sc && view && box.height) {
        if (box.bottom > view.bottom - 8) sc.scrollTop += box.bottom - view.bottom + 48
        else if (box.top < view.top + 8) sc.scrollTop -= view.top - box.top + 48
      }
    }
    return true
  }

  /** a click moves the caret: what an edit asked for no longer holds */
  /** when the mouse was last pressed in the text (ms) */
  private pressed = -1e9

  private onMouseDown = () => {
    this.expected = null
    this.pressed = performance.now()
  }

  /**
   * The focus is back in the text without a place for the caret: it was in a field of a dialog (which took the
   * selection with it), or a script gave it back. The caret returns to where it last was, so that what is typed next
   * lands there. Not when a press of the mouse brings the focus: the caret goes where it was pressed.
   */
  private onFocus = () => {
    if (performance.now() - this.pressed < 100 || this.composing || this.override || !this.lastSel || this.readSel()) return
    this.restore(this.lastSel, false)
  }

  private onCopy = (e: ClipboardEvent) => {
    const sel = this.live()
    if (!e.clipboardData || !sel || collapsed(sel)) return
    if (this.host.copy?.(sel, e.clipboardData, e.type === 'cut')) e.preventDefault()
  }

  private onSelChange = () => {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      const dom = this.readSel()
      const control = this.activeHost()
      const ov = this.override
      const active = (this.root?.getRootNode() as Document | ShadowRoot | undefined)?.activeElement
      // select all stays until the selection moves somewhere else (losing it to a re-render keeps it, like lastSel)
      if (ov && ((control && !!this.formatTarget) || (dom ? sameSel(dom, ov.dom) : this.root === active))) {
        this.formatTarget = ov.model
        this.host.onSelection?.(ov.model)
        return
      }
      this.override = null
      const s = control ? this.formatSelection() : dom
      if (s && this.expected && sameSel(s, this.expected)) this.expected = null
      if (s && !this.expected) this.lastSel = s
      this.formatTarget = this.expected ?? s
      this.host.onSelection?.(this.expected ?? s)
    })
  }
}
