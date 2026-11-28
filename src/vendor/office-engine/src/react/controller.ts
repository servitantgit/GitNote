/**
 * A viewer's controller: what the shown document's view is doing (zoom, page, outline, editing, unsaved changes) and the
 * commands that drive it, for a host that draws its own controls around a headless viewer
 * (`<DocViewer controller={ctl} headless />`). Framework-free: `subscribe` + `snapshot` (for `useSyncExternalStore` or any
 * store), state replaced as a whole on every change (`rev` counts them). The viewer and its mounted view publish their
 * state and register the commands they can run; a command with nobody to run it does nothing.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { formatCommand } from './edit/format-values'
import type { DocKind } from '../core/opc'
import { stepZoom, type Zoom } from './common/ZoomControl'
import { useLatest } from './common/hooks'

/** an entry of the outline: a document's heading, a workbook's sheet, a presentation's slide */
export interface OutlineItem {
  id: string
  title: string
  /** 0 for the top level (headings only go deeper) */
  level: number
  /** the one in view */
  current: boolean
}

export interface ViewerOutline {
  kind: 'headings' | 'sheets' | 'slides'
  items: OutlineItem[]
}

export interface ViewerState {
  /** counts the changes */
  rev: number
  /** the open document's kind, null before one is open */
  kind: DocKind | null
  /** loading or downloading */
  loading: boolean
  editing: boolean
  /** whether editing is possible (allowed, and the file is not view only) */
  canEdit: boolean
  /** unsaved changes */
  dirty: boolean
  saving: boolean
  canUndo: boolean
  canRedo: boolean
  /** `value` as set ('fit' or a factor), `effective` the factor it comes to; null where the view has no zoom (spreadsheets) */
  zoom: { value: Zoom; effective: number } | null
  /** the page or slide in view, from 1, and how many there are (0 while a document is still being laid out) */
  page: { current: number; count: number } | null
  outline: ViewerOutline | null
  /** the view's status line ("Page 2 of 7 · 1,204 words") */
  status: string
  /** the formatting at the selection while editing (document text, the active cell, slide text being edited), else null */
  format: TextFormat | null
  /**
   * a spreadsheet formula being typed can take a cell reference here (`=SUM(`): a sheet tab clicked now keeps the
   * edit open on the other sheet, for a reference to it, and must not take the focus from the grid
   */
  pointing: boolean
}

/** Formatting at the selection, the same for documents, cells and slide text. */
export interface TextFormat {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  font?: string
  /** points */
  size?: number
  /** CSS color of the text */
  color?: string
  /** text highlight; in a spreadsheet, the cell's fill */
  highlight?: string
  align?: 'left' | 'center' | 'right' | 'justify'
  /** the paragraph's list; null for no list, undefined where unsupported (cells). Mixed selections are not aggregated. */
  list?: 'bullet' | 'number' | null
}

/** A formatting command for the selection (`ViewerController.format`); one a view does not support does nothing. */
export type FormatCommand =
  | { op: 'toggle'; mark: 'bold' | 'italic' | 'underline' | 'strike' }
  | { op: 'font'; name: string }
  /** 1–400 points, rounded to half points; invalid sizes do nothing */
  | { op: 'size'; pt: number }
  /** Opaque #rgb, #rrggbb or #rrggbbff; null removes the color. Other CSS colors do nothing. */
  | { op: 'color'; color: string | null }
  | { op: 'highlight'; color: string | null }
  | { op: 'align'; align: 'left' | 'center' | 'right' | 'justify' }
  /** Sets every selected paragraph to this kind; null explicitly removes lists. Repeating is idempotent. */
  | { op: 'list'; list: 'bullet' | 'number' | null }
  | { op: 'clear' }

/** the editors' names for the marks */
export const MARK_KEY = { bold: 'b', italic: 'i', underline: 'u', strike: 'strike' } as const

/** commands a mounted view runs (each optional: a spreadsheet has no zoom) */
export interface ViewCommands {
  setZoom?(z: Zoom): void
  goto?(id: string): void
  gotoPage?(n: number): void
  undo?(): void
  redo?(): void
  present?(): void
  format?(cmd: FormatCommand): void
}

/** commands the viewer runs */
export interface ViewerCommands {
  setEditing(on: boolean): void
  save(): Promise<void>
  fileAction(id: string): void
  toggleComments(open?: boolean): void
}

type ViewState = Pick<ViewerState, 'canUndo' | 'canRedo' | 'zoom' | 'page' | 'outline' | 'status' | 'format' | 'pointing'>
type ViewerPublication = Omit<ViewerState, keyof ViewState | 'rev'>

/** Internal, document-scoped publication and command registration. Never part of the host API. */
export interface ViewController {
  activate(): () => void
  update(state: Partial<ViewState>): void
  attachView(commands: ViewCommands): () => void
  publishFormat(commands: ViewCommands, format: TextFormat | null): void
  readonly observed: boolean
  watchObserved(fn: () => void): () => void
}

/** the view's part of the state, cleared when a view goes */
const VIEW_STATE = { canUndo: false, canRedo: false, zoom: null, page: null, outline: null, status: '', format: null, pointing: false } as const

/** the viewer's part of the state, cleared when the viewer goes, so a controller that outlives it shows no document */
const VIEWER_STATE = { kind: null, loading: false, editing: false, canEdit: false, dirty: false, saving: false } as const

const EMPTY: ViewerState = { rev: 0, ...VIEWER_STATE, ...VIEW_STATE }

/** equal for the state's purposes: the same primitive, or the same JSON (small objects and the outline) */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  return JSON.stringify(a) === JSON.stringify(b)
}

const controllerBrand: unique symbol = Symbol('ViewerController')

export class InternalViewerController {
  readonly [controllerBrand] = true as const
  private state: ViewerState = EMPTY
  private subs = new Set<() => void>()
  private watchers = new Set<() => void>()
  private view: ViewCommands | null = null
  private viewer: ViewerCommands | null = null
  private owner: object | null = null
  private viewOwner: object | null = null

  subscribe = (fn: () => void) => {
    const first = this.subs.size === 0
    const listener = () => fn()
    this.subs.add(listener)
    if (first) for (const w of this.watchers) w()
    return () => {
      if (this.subs.delete(listener) && this.subs.size === 0) for (const w of this.watchers) w()
    }
  }

  /** whether a host reads the state: views skip work that only the controller's state needs while nobody does */
  get observed(): boolean {
    return this.subs.size > 0
  }

  /** calls `fn` when observation starts or stops */
  watchObserved(fn: () => void): () => void {
    this.watchers.add(fn)
    return () => {
      this.watchers.delete(fn)
    }
  }

  snapshot = () => this.state

  // ---------------------------------------------------------------- commands

  setEditing = (on: boolean) => {
    this.viewer?.setEditing(on)
  }

  /** builds the edited file and hands it to `onSave` (or downloads it) */
  save = (): Promise<void> => {
    return this.viewer?.save() ?? Promise.resolve()
  }

  undo = () => {
    this.view?.undo?.()
  }

  redo = () => {
    this.view?.redo?.()
  }

  setZoom = (z: Zoom) => {
    if (z === 'fit') this.view?.setZoom?.(z)
    else if (Number.isFinite(z)) this.view?.setZoom?.(Math.min(3, Math.max(0.25, z)))
  }

  zoomIn = () => {
    this.zoomStep(1)
  }

  zoomOut = () => {
    this.zoomStep(-1)
  }

  /** shows an outline entry: scrolls to a heading, shows a sheet or a slide */
  goto = (id: string) => {
    this.view?.goto?.(id)
  }

  /** scrolls to a page or slide, from 1 */
  gotoPage = (n: number) => {
    this.view?.gotoPage?.(n)
  }

  /** a presentation as a slideshow, from the slide in view */
  present = () => {
    this.view?.present?.()
  }

  /** formats the selection while editing: `format({ op: 'toggle', mark: 'bold' })`, `format({ op: 'size', pt: 14 })` */
  format = (cmd: FormatCommand) => {
    const command = formatCommand(cmd)
    if (command) this.view?.format?.(command)
  }

  print = () => {
    this.fileAction('print')
  }

  /** a File menu action by its id: 'pdf', 'html', 'text:md', 'details', 'rename'… (see FileMenu) */
  fileAction = (id: string) => {
    this.viewer?.fileAction(id)
  }

  /** the comments panel open (true), closed (false) or the other way round */
  toggleComments = (open?: boolean) => {
    this.viewer?.toggleComments(open)
  }

  private zoomStep(dir: 1 | -1) {
    const z = this.state.zoom
    const next = z && stepZoom(z.effective, dir)
    if (next) this.setZoom(next)
  }

  // ---------------------------------------------------------------- published by the viewer and its view

  /** @internal the state changed: only what differs counts as a change */
  private update(p: Partial<Omit<ViewerState, 'rev'>>) {
    let changed = false
    for (const k of Object.keys(p) as (keyof typeof p)[]) {
      if (!same(this.state[k], p[k])) {
        changed = true
        break
      }
    }
    if (!changed) return
    this.state = { ...this.state, ...p, rev: this.state.rev + 1 }
    for (const fn of this.subs) fn()
  }

  /** A viewer claims ownership when it mounts, before any async document can finish loading.
   * A later document attach/update can only use that claim; it cannot take ownership back.
   * Each document also gets a separate publication scope, invalidated on replacement.
   */
  createBinding() {
    const controller = this
    const owner = {}
    const owns = () => this.owner === owner
    return {
      attachViewer: (commands: ViewerCommands) => {
        this.owner = owner
        this.viewer = commands
        this.viewOwner = null
        this.view = null
        this.update({ ...VIEWER_STATE, ...VIEW_STATE })
        return () => {
          if (!owns() || this.viewer !== commands) return
          this.owner = this.viewOwner = null
          this.viewer = this.view = null
          this.update({ ...VIEWER_STATE, ...VIEW_STATE })
        }
      },
      update: (state: Partial<ViewerPublication>) => {
        if (owns()) this.update(state)
      },
      createView: (): ViewController => {
        const viewOwner = {}
        const current = () => owns() && this.viewOwner === viewOwner
        return {
          activate: () => {
            if (!owns()) return () => {}
            this.viewOwner = viewOwner
            this.view = null
            this.update(VIEW_STATE)
            return () => {
              if (!current()) return
              this.viewOwner = null
              this.view = null
              this.update(VIEW_STATE)
            }
          },
          update: (state) => { if (current()) this.update(state) },
          attachView: (commands) => {
            if (!current()) return () => {}
            this.view = commands
            return () => {
              if (!current() || this.view !== commands) return
              this.view = null
              this.update({ format: null })
            }
          },
          publishFormat: (commands, format) => { if (current() && this.view === commands) this.update({ format }) },
          get observed() { return controller.observed },
          watchObserved: (fn) => this.watchObserved(fn),
        }
      },
    }
  }
}

/** Host API; publishing and lifecycle methods belong to the engine. */
export type ViewerController = { readonly [controllerBrand]: true } & Pick<InternalViewerController,
  'subscribe' | 'snapshot' | 'setEditing' | 'save' | 'undo' | 'redo' | 'setZoom' | 'zoomIn' | 'zoomOut' |
  'goto' | 'gotoPage' | 'present' | 'format' | 'print' | 'fileAction' | 'toggleComments'>

export const createViewerController = (): ViewerController => new InternalViewerController()
/** @internal controllers supplied to viewers originate from createViewerController(). */
export const internalController = (ctl: ViewerController): InternalViewerController => {
  if (!(ctl instanceof InternalViewerController)) throw new TypeError('DocViewer controller must be created by createViewerController()')
  return ctl
}

/** @internal follows both subscription transitions, including a replacement controller. */
export function useControllerObserved(ctl: ViewController | null): boolean {
  return useSyncExternalStore(
    (fn) => ctl?.watchObserved(fn) ?? (() => {}),
    () => !!ctl?.observed,
    () => false,
  )
}

/** The controller's state, rendering again whenever it changes: for a host's own controls in React. */
export function useViewerState(ctl: ViewerController): ViewerState {
  return useSyncExternalStore(ctl.subscribe, ctl.snapshot, ctl.snapshot)
}

/** Registers a view's commands (the latest closures each render) while it is mounted. */
export function useViewCommands(ctl: ViewController | null, commands: ViewCommands) {
  const latest = useLatest(commands)
  const registration = useMemo(() => {
    const call = <K extends keyof ViewCommands>(k: K) => ((...a: unknown[]) => (latest.current[k] as ((...x: unknown[]) => void) | undefined)?.(...a)) as ViewCommands[K]
    const view = { setZoom: call('setZoom'), goto: call('goto'), gotoPage: call('gotoPage'), undo: call('undo'), redo: call('redo'), present: call('present'), format: call('format') }
    return { view, publishFormat: (format: TextFormat | null) => ctl?.publishFormat(view, format) }
  }, [ctl, latest])
  useEffect(() => ctl?.attachView(registration.view), [ctl, registration])
  return registration.publishFormat
}
