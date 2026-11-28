/**
 * XLSX collaboration (main thread): turns the view's worker calls into shared operations.
 * Cell edits, formatting, layout, fill / sort / replace are applied optimistically; inserting /
 * deleting rows or columns and sheet-list changes wait for the hub's order. Undo / redo only
 * touch the local user's own operations (shared as `revert` operations).
 */
import type { DocumentClient } from '../core/worker/client'
import type { Methods } from '../core/worker/protocol'
import type { BookOp, Range, SetOptions, SheetOp, WorkbookMeta } from '../core/xlsx/types'
import { inputLocale } from '../core/number-input'
import { onLocal, setLocalHistory } from './hosts'
import type { Adapter, ApplyResult } from './session'
import { conflictsX, isStructural, STRUCTURAL, transformX, type PBookOp, type XOp } from './xlsx-ops'
import { applyComment, revertComment, type CommentOp } from './comments'

const CAPTURED = new Set<keyof Methods>(['comments.set', 'xlsx.set', 'xlsx.format', 'xlsx.sheetOp', 'xlsx.replace', 'xlsx.bookOp', 'xlsx.undo', 'xlsx.redo'])

type UndoEntry = { kind: 'op'; id: string } | { kind: 'inverse'; sheet: string; undo: SheetOp; redo: SheetOp }

export interface XlsxPresence {
  k: 'xlsx'
  /** sheet part path */
  sheet: string
  /** selected range and active cell */
  range: Range
  ar: number
  ac: number
}

/** what XlsxView publishes about the local selection */
export interface XlsxLocalSel {
  sheet: number
  range: Range
  ar: number
  ac: number
}

export class XlsxCollab implements Adapter<XOp> {
  submit?: (op: XOp) => Promise<unknown>
  nextId?: () => string
  onPresence?: (p: XlsxPresence) => void
  private undoStack: UndoEntry[] = []
  private redoStack: UndoEntry[] = []
  private offLocal: () => void

  constructor(private client: DocumentClient) {
    this.publishHistory()
    this.offLocal = onLocal(client, (d) => {
      const s = d as XlsxLocalSel
      const sheet = this.path(s.sheet)
      if (sheet) this.onPresence?.({ k: 'xlsx', sheet, range: s.range, ar: s.ar, ac: s.ac })
    })
  }

  dispose() {
    this.offLocal()
    setLocalHistory(this.client)
  }

  private publishHistory() {
    setLocalHistory(this.client, { undo: this.undoStack.length, redo: this.redoStack.length })
  }

  private get meta() {
    return this.client.info.xlsx as WorkbookMeta
  }

  private path(i: number): string {
    return this.meta.sheets[i]?.path ?? ''
  }

  private id() {
    return this.nextId!()
  }

  captures(method: keyof Methods): boolean {
    return CAPTURED.has(method)
  }

  intercept(method: keyof Methods, args: unknown[]): Promise<unknown> | undefined {
    if (!this.submit) return undefined
    const a = args as never[]
    switch (method) {
      case 'comments.set':
        return this.submit({ t: 'comment', id: this.id(), cid: a[0], c: a[1] as CommentOp['c'] })
      case 'xlsx.set': {
        // (the locale goes with the op: each replica, and a server replaying the log, reads the numbers as typed)
        const locale = inputLocale((a[2] as SetOptions | undefined)?.locale)
        return this.local({ t: 'set', id: this.id(), sheet: this.path(a[0]), cells: a[1], ...(locale ? { locale } : {}) })
      }
      case 'xlsx.format':
        return this.local({ t: 'fmt', id: this.id(), sheet: this.path(a[0]), range: a[1], patch: a[2] })
      case 'xlsx.sheetOp': {
        const o = a[1] as SheetOp
        // (rows / columns moving: the name the sheet goes by here, for the formulas others type meanwhile)
        const name = STRUCTURAL.has(o.op) ? this.meta.sheets[a[0]]?.name : undefined
        return this.local({ t: 'sheet', id: this.id(), sheet: this.path(a[0]), op: o, ...(name !== undefined ? { name } : {}) })
      }
      case 'xlsx.replace':
        return this.local({ t: 'replace', id: this.id(), sheet: this.path(a[0]), query: a[1], by: a[2], opts: a[3], at: a[4] })
      case 'xlsx.bookOp':
        return this.local({ t: 'book', id: this.id(), op: this.pbook(a[0]) })
      case 'xlsx.undo':
        return this.history(this.undoStack, this.redoStack, 'prev')
      case 'xlsx.redo':
        return this.history(this.redoStack, this.undoStack, 'next')
    }
    return undefined
  }

  private pbook(b: BookOp): PBookOp {
    switch (b.op) {
      case 'add':
        return { op: 'add', name: b.name, after: b.after !== undefined ? this.path(b.after) : undefined }
      case 'rename':
        return { op: 'rename', path: this.path(b.index), name: b.name, was: this.meta.sheets[b.index]?.name }
      case 'delete':
        return { op: 'delete', path: this.path(b.index) }
      case 'move':
        return { op: 'move', path: this.path(b.from), to: b.to }
      case 'duplicate':
        return { op: 'duplicate', path: this.path(b.index) }
    }
  }

  private local(op: XOp): Promise<unknown> {
    if (op.t === 'sheet' && (op.op.op === 'insertRows' || op.op.op === 'insertCols')) {
      const del: SheetOp = { op: op.op.op === 'insertRows' ? 'deleteRows' : 'deleteCols', at: op.op.at, n: op.op.n }
      this.undoStack.push({ kind: 'inverse', sheet: op.sheet, undo: del, redo: op.op })
    } else if (!isStructural(op)) this.undoStack.push({ kind: 'op', id: op.id })
    if (this.undoStack.length > 200) this.undoStack.shift()
    this.redoStack = []
    this.publishHistory()
    return this.submit!(op)
  }

  private history(from: UndoEntry[], to: UndoEntry[], which: 'prev' | 'next'): Promise<unknown> {
    const e = from.pop()
    if (!e) return Promise.resolve(null)
    to.push(e)
    this.publishHistory()
    if (e.kind === 'op') return this.submit!({ t: 'revert', id: this.id(), target: e.id, which })
    return this.submit!({ t: 'sheet', id: this.id(), sheet: e.sheet, op: which === 'prev' ? e.undo : e.redo })
  }

  // ---------------------------------------------------------------- adapter

  transform(op: XOp, prior: XOp): XOp | null {
    return transformX(op, prior)
  }

  conflicts(pending: XOp[], remote: XOp[]): boolean {
    return conflictsX(pending, remote)
  }

  pessimistic(op: XOp): boolean {
    return isStructural(op)
  }

  async apply(op: XOp, kind: 'local' | 'replay' | 'remote'): Promise<ApplyResult> {
    if (op.t === 'comment') return applyComment(this.client, op)
    const { res, rec } = await this.client.direct('collab.xlsx.apply', op)
    // a sort goes to the room with the order it made here: the same rows move for everyone (see `transformX`)
    if (kind === 'local' && op.t === 'sheet' && op.op.op === 'sort' && !op.op.order && res?.sorted) op.op = { ...op.op, order: res.sorted }
    // the view follows a collaborator's rows / columns with its selection and the cell being typed in
    let seen = res
    if (kind === 'remote' && res && op.t === 'sheet' && STRUCTURAL.has(op.op.op)) {
      const o = op.op as { op: string; at: number; n: number }
      seen = { ...res, moved: { axis: o.op.endsWith('Rows') ? 'row' : 'col', at: o.at, n: o.op.startsWith('insert') ? o.n : -o.n } }
    } else if (kind !== 'remote' && res?.sorted) seen = { ...res, sorted: undefined }
    if (isStructural(op)) {
      // the worker dropped its records: older entries can't be reverted any more
      const keep = (e: UndoEntry) => e.kind === 'inverse' && kind === 'local'
      this.undoStack = this.undoStack.filter(keep)
      this.redoStack = this.redoStack.filter(keep)
      this.publishHistory()
    }
    if (kind !== 'local' && seen) this.client.notify('collab:xlsx', seen)
    return { result: res, undo: rec }
  }

  async revert(undo: unknown) {
    const cm = revertComment(this.client, undo)
    if (cm) return cm
    if (typeof undo !== 'number') return
    const res = await this.client.direct('collab.xlsx.revert', undo)
    if (res) this.client.notify('collab:xlsx', res)
  }
}

