import { cssFont } from '../../core/fonts'
import type { PParaSpec, PRunSet, SlideModel, TextBody, TPara, TRun } from '../../core/pptx/types'
import type { DocumentClient } from '../../core/worker/client'
import { ordered, RichInput, type ReplaceOpts, type RichHost } from '../edit/input'
import { collapsed, formatRange, normalize, plen, runAt, type RRun, type Sel } from '../edit/rich'

type RunStyle = Omit<TRun, 'text' | 'br' | 'fld' | 'src' | 'href'>

export interface EPara {
  runs: RRun[]
  base: TPara
  algn: TPara['algn']
  algnSet?: boolean
  /** paragraph changes made here (written back) */
  pp?: { lvl?: number; bullet?: 'none' | 'bullet' | 'number'; lnPct?: number }
  k?: number
  caret?: RRun
}

interface Entry {
  before: EPara[]
  after: EPara[]
  selBefore: Sel
  selAfter: Sel
  label: string
  t: number
}

export interface PptxFormat {
  b: boolean
  i: boolean
  u: boolean
  strike: boolean
  sz?: number
  color?: string
  font?: string
  algn?: string
  hl?: string
  baseline?: number
  bullet?: 'none' | 'bullet' | 'number'
  lvl: number
  lnPct?: number
}

const styleOf = (r: TRun): RunStyle => ({ sz: r.sz, b: r.b, i: r.i, u: r.u, strike: r.strike, color: r.color, font: r.font, baseline: r.baseline, caps: r.caps, hl: r.hl })

function toEdit(p: TPara): EPara {
  const runs: RRun[] = p.runs.map((r) =>
    r.fld ? { t: 'fld', text: r.text, s: styleOf(r), src: r.src } : { t: 'text', text: r.br ? '\n' : r.text, s: styleOf(r), src: r.src },
  )
  return { runs: normalize(runs), base: p, algn: p.algn, k: p.k }
}

const bulletOf = (p: EPara) => p.pp?.bullet ?? p.base.buKind ?? 'none'
const lvlOf = (p: EPara) => p.pp?.lvl ?? p.base.lvl ?? 0

export function toTPara(p: EPara, num = 0): TPara {
  const kind = bulletOf(p)
  const lvl = lvlOf(p)
  const sz = (p.runs.find((r) => r.t === 'text')?.s as RunStyle | undefined)?.sz ?? p.base.endSz
  // approximate the look of edited bullets / levels until the slide is re-rendered
  const bullet = !p.pp?.bullet ? p.base.bullet : kind === 'none' ? undefined : { text: kind === 'bullet' ? '•' : `${num}.`, sz, color: p.base.bullet?.color }
  const shift = (lvl - (p.base.lvl ?? 0)) * 48
  const hang = p.pp?.bullet && kind !== 'none' && !p.base.bullet ? 27 : 0
  return {
    ...p.base,
    bullet,
    marL: Math.max(0, p.base.marL + shift + hang),
    indent: hang ? -hang : p.base.indent,
    lnPct: p.pp?.lnPct ?? p.base.lnPct,
    algn: p.algn,
    runs: p.runs.map((r) => (r.t === 'fld' ? { ...(r.s as RunStyle), text: r.text ?? '', fld: true } : { ...(r.s as RunStyle), text: r.text ?? '' })) as TRun[],
  }
}

/** Text editing of one shape on one slide. */
/** times an edit the worker refused is sent again (at the next commit or save) before it is given up */
const MAX_COMMIT_TRIES = 3

export class PptxEditor implements RichHost<EPara> {
  readonly input: RichInput
  paras: EPara[] = []
  body?: TextBody
  slide = -1
  sid = -1
  /** [row, column] when the text is a table cell's (`sid` is then the table's id) */
  cell?: [number, number]
  pendingSel: Sel | null = null
  pendingNoRefocus = false
  private history: Entry[] = []
  private future: Entry[] = []
  private pend: { s: Partial<RunStyle>; d: PRunSet; at: { pa: string; o: number } } | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private changedSinceCommit = false
  private commits: { slide: number; sid: number; cell?: [number, number]; specs: PParaSpec[]; failed?: number; step: boolean }[] = []
  /** the next edit written begins an undo step of its own: the text was just entered */
  private step = true
  private committing?: Promise<void>
  onChange?: () => void
  onCommitted?: (slide: number, model: SlideModel) => void
  onDirty?: () => void
  onState?: (s: PptxFormat | null) => void
  /** Tab / Shift+Tab in a table cell: go to the next / previous cell */
  onCellMove?: (d: 1 | -1) => void
  private stateSubs = new Set<(s: PptxFormat | null) => void>()
  /** hears the current formatting state, then every one `onState` does (the viewer's controller, beside the toolbar) */
  subscribeState(fn: (s: PptxFormat | null) => void): () => void {
    this.stateSubs.add(fn)
    fn(this.state())
    return () => {
      this.stateSubs.delete(fn)
    }
  }
  private emitState(s: PptxFormat | null) {
    this.onState?.(s)
    for (const fn of this.stateSubs) fn(s)
  }

  constructor(private client: DocumentClient) {
    this.input = new RichInput(this)
  }

  get active() {
    return this.sid >= 0
  }

  begin(slide: number, sid: number, body: TextBody, cell?: [number, number]) {
    this.end()
    this.slide = slide
    this.sid = sid
    this.cell = cell
    this.body = body
    this.paras = (body.paras.length ? body.paras : [{ algn: 'left', marL: 0, indent: 0, spcBef: 0, spcAft: 0, runs: [], endSz: 18 } as TPara]).map(toEdit)
    this.history = []
    this.future = []
    this.pend = null
    this.step = true
  }

  /** the slide list changed under the text (a collaborator's edit): it goes on in its slide, now the one at `slide` */
  moveSlide(slide: number) {
    this.slide = slide
    // the slides are drawn again: the caret returns to where it was
    this.pendingSel = this.input.lastSel ?? this.pendingSel
  }

  end() {
    clearTimeout(this.timer)
    if (this.sid >= 0 && this.changedSinceCommit) this.commitInBackground()
    this.input.detach()
    this.input.clearSelection()
    this.sid = -1
    this.slide = -1
    this.cell = undefined
    this.body = undefined
    this.emitState(null)
  }

  text(): TextBody | undefined {
    if (!this.body) return undefined
    const counters: number[] = []
    const paras = this.paras.map((p) => {
      const lvl = lvlOf(p)
      if (bulletOf(p) === 'number') counters[lvl] = (counters[lvl] ?? 0) + 1
      else counters[lvl] = 0
      counters.length = lvl + 1
      return toTPara(p, counters[lvl])
    })
    return { ...this.body, empty: false, paras }
  }

  // ---------------------------------------------------------------- RichHost

  para(pa: string) {
    return this.paras[Number(pa)]
  }
  span(a: string, b: string) {
    const out: string[] = []
    for (let i = Number(a); i <= Number(b); i++) out.push(String(i))
    return out
  }
  prev(pa: string) {
    return Number(pa) > 0 ? String(Number(pa) - 1) : undefined
  }
  next(pa: string) {
    return Number(pa) < this.paras.length - 1 ? String(Number(pa) + 1) : undefined
  }
  cmp(a: string, b: string) {
    return Number(a) - Number(b)
  }
  withRuns(p: EPara, runs: RRun[]): EPara {
    return { ...p, runs }
  }
  split(p: EPara, left: RRun[], right: RRun[]): [EPara, EPara] {
    return [
      { ...p, runs: left },
      { ...p, runs: right, caret: right.length ? undefined : runAt(left, plen(left)) ?? p.caret },
    ]
  }
  join(a: EPara, _b: EPara, runs: RRun[]): EPara {
    return { ...a, runs }
  }
  defaultRun(p: EPara): Partial<RRun> | undefined {
    if (p.caret) return { ...p.caret, text: '' }
    const last = [...p.runs].reverse().find((r) => r.t === 'text')
    return last ? { ...last, text: '' } : { t: 'text', s: { sz: p.base.endSz } }
  }
  pendingStyle() {
    return this.pend ? ({ s: this.pend.s, d: this.pend.d } as Partial<RRun>) : undefined
  }
  clearPending() {
    this.pend = null
  }

  replace(pas: string[], next: EPara[], sel: Sel, opts: ReplaceOpts & { history?: boolean } = {}) {
    const before = this.paras
    const i0 = Number(pas[0])
    this.paras = [...before.slice(0, i0), ...next, ...before.slice(i0 + pas.length)]
    if (opts.history !== false) {
      const now = Date.now()
      const last = this.history[this.history.length - 1]
      const label = opts.label ?? 'edit'
      if (label === 'type' && last?.label === 'type' && now - last.t < 1500) {
        last.after = this.paras
        last.selAfter = sel
        last.t = now
      } else this.history.push({ before, after: this.paras, selBefore: this.input.lastSel ?? sel, selAfter: sel, label, t: now })
      this.future = []
    }
    this.pendingSel = sel
    this.pendingNoRefocus = this.input.formatting
    this.changedSinceCommit = true
    this.onDirty?.()
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.commitInBackground(), 400)
    this.onChange?.()
    this.emitState(this.state(sel))
  }

  undo() {
    const e = this.history.pop()
    if (!e) return
    this.future.push(e)
    this.restore(e.before, e.selBefore)
  }
  redo() {
    const e = this.future.pop()
    if (!e) return
    this.history.push(e)
    this.restore(e.after, e.selAfter)
  }
  private restore(paras: EPara[], sel: Sel) {
    this.paras = paras
    this.pendingSel = sel
    this.pendingNoRefocus = this.input.formatting
    this.changedSinceCommit = true
    this.onDirty?.()
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.commitInBackground(), 400)
    this.onChange?.()
    this.emitState(this.state(sel))
  }

  private commitInBackground() {
    void this.commit().catch((e) => console.error('[office-engine] slide edit failed', e))
  }

  /** Flush the debounce and any edits made while an earlier commit was in flight. */
  async flush() {
    do {
      await this.commit()
    } while (this.changedSinceCommit || this.commits.length)
  }

  commit(): Promise<void> {
    clearTimeout(this.timer)
    if (this.sid >= 0 && this.changedSinceCommit) {
      this.changedSinceCommit = false
      const specs: PParaSpec[] = this.paras.map((p) => ({
        k: p.k,
        algn: p.algnSet ? p.algn : undefined,
        ...p.pp,
        runs: p.runs.map((r) =>
          r.t === 'fld' ? { text: '', src: r.src as [number, number], fld: true } : { text: r.text ?? '', src: r.src as [number, number] | undefined, set: r.d as PRunSet | undefined },
        ),
      }))
      this.commits.push({ slide: this.slide, sid: this.sid, cell: this.cell, specs, step: this.step })
      this.step = false
    }
    if (!this.committing) {
      this.committing = this.drainCommits().finally(() => {
        this.committing = undefined
      })
    }
    return this.committing
  }

  private async drainCommits() {
    while (this.commits.length) {
      const c = this.commits[0]
      let model: SlideModel
      try {
        model = await this.client.call('pptx.setText', c.slide, c.sid, c.specs, c.cell, c.step)
      } catch (e) {
        // Retain a failed snapshot for retry, including after the active shape changes: but not for ever. An edit the
        // worker refuses every time would fail every save from here on, the edits made after it never written.
        c.failed = (c.failed ?? 0) + 1
        if (c.failed >= MAX_COMMIT_TRIES) this.commits.shift()
        throw e
      }
      this.commits.shift()
      this.onCommitted?.(c.slide, model)
    }
  }

  // ---------------------------------------------------------------- formatting

  format(s: Partial<RunStyle>, d: PRunSet) {
    const sel = this.input.sel()
    if (!sel) return
    if (collapsed(sel)) {
      this.pend = { s: { ...(this.pend?.s ?? {}), ...s }, d: { ...(this.pend?.d ?? {}), ...d }, at: sel.a }
      this.input.restore(sel)
      this.emitState(this.state(sel))
      return
    }
    const [a, b] = ordered(this, sel)
    const pas = this.span(a.pa, b.pa)
    const next = pas.map((pa, i) => {
      const p = this.para(pa)
      const from = i === 0 ? a.o : 0
      const to = i === pas.length - 1 ? b.o : plen(p.runs)
      return this.withRuns(p, formatRange(p.runs, from, to, s, d))
    })
    this.replace(pas, next, sel, { label: 'format' })
  }

  toggle(key: 'b' | 'i' | 'u' | 'strike') {
    const st = this.state()
    const on = !(st && st[key])
    this.format({ [key]: on }, { [key]: on })
  }

  setSize(sz: number) {
    this.format({ sz }, { sz })
  }
  setColor(c: string | null) {
    this.format({ color: c ?? undefined }, { color: c })
  }
  setFont(name: string) {
    this.format({ font: cssFont(name) }, { font: name })
  }

  setAlign(algn: TPara['algn']) {
    const sel = this.input.sel()
    if (!sel) return
    const [a, b] = ordered(this, sel)
    const pas = this.span(a.pa, b.pa)
    this.replace(pas, pas.map((pa) => ({ ...this.para(pa), algn, algnSet: true })), sel, { label: 'align' })
  }

  /** applies a paragraph-level change to the selected paragraphs */
  private paraOp(fn: (p: EPara) => EPara, label: string, list?: 'bullet' | 'number' | 'none') {
    const sel = this.input.sel()
    if (!sel) return
    const [a, b] = ordered(this, sel)
    const pas = this.span(a.pa, b.pa)
    if (list && pas.every((pa) => bulletOf(this.para(pa)) === list)) return
    this.replace(pas, pas.map((pa) => fn(this.para(pa))), sel, { label })
  }

  /** Host API setter; the built-in toolbar retains toggleBullet. */
  setList(kind: 'bullet' | 'number' | null) {
    const next = kind ?? 'none'
    this.paraOp((p) => ({ ...p, pp: { ...p.pp, bullet: next } }), 'bullet', next)
  }

  toggleBullet(kind: 'bullet' | 'number') {
    const st = this.state()
    const next = st?.bullet === kind ? 'none' : kind
    this.paraOp((p) => ({ ...p, pp: { ...p.pp, bullet: next } }), 'bullet')
  }

  indentLevel(d: 1 | -1) {
    this.paraOp((p) => ({ ...p, pp: { ...p.pp, lvl: Math.max(0, Math.min(8, lvlOf(p) + d)) } }), 'indent')
  }

  /**
   * Tab / Shift+Tab: the level of a list item (the keys of the Increase / Decrease indent buttons), the next / previous
   * cell in a table. Anywhere else Tab types a tab and Shift+Tab does nothing.
   */
  tab(sel: Sel, shift: boolean): boolean {
    if (this.cell) {
      this.onCellMove?.(shift ? -1 : 1)
      return true
    }
    const [a, b] = ordered(this, sel)
    const items = this.span(a.pa, b.pa).filter((pa) => bulletOf(this.para(pa)) !== 'none')
    if (!items.length) return shift
    this.indentLevel(shift ? -1 : 1)
    return true
  }

  setLineSpacing(x: number) {
    this.paraOp((p) => ({ ...p, pp: { ...p.pp, lnPct: x } }), 'spacing')
  }

  setHighlight(c: string | null) {
    this.format({ hl: c ?? undefined }, { hl: c })
  }

  toggleBaseline(kind: 'sup' | 'sub') {
    const cur = this.state()?.baseline ?? 0
    const v = kind === 'sup' ? (cur > 0 ? 0 : 30) : cur < 0 ? 0 : -25
    this.format({ baseline: v || undefined }, { baseline: v || null })
  }

  clearFormat() {
    this.format({ b: false, i: false, u: false, strike: false, hl: undefined, baseline: undefined }, { b: false, i: false, u: false, strike: false, hl: null, baseline: null })
  }

  state(sel = this.input.sel()): PptxFormat | null {
    if (!sel || this.sid < 0) return null
    const [a] = ordered(this, sel)
    const p = this.para(a.pa)
    if (!p) return null
    const run = runAt(p.runs, collapsed(sel) ? a.o : a.o + 1)
    const s = { ...((run?.s ?? {}) as RunStyle), ...(collapsed(sel) ? this.pend?.s ?? {} : {}) }
    return {
      b: !!s.b,
      i: !!s.i,
      u: !!s.u,
      strike: !!s.strike,
      sz: s.sz,
      color: s.color,
      font: s.font,
      algn: p.algn,
      hl: s.hl,
      baseline: s.baseline,
      bullet: bulletOf(p),
      lvl: lvlOf(p),
      lnPct: p.pp?.lnPct ?? p.base.lnPct,
    }
  }

  onSelection(sel: Sel | null) {
    if (sel && this.pend && (sel.a.pa !== this.pend.at.pa || sel.a.o !== this.pend.at.o)) this.pend = null
    this.emitState(sel ? this.state(sel) : null)
  }

  shortcut?: (e: KeyboardEvent) => boolean
}
