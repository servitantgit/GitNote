import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import './core/default-worker'
import { DocViewer, type DocViewerProps } from './react/DocViewer'
import type { Icons } from './react/edit/Toolbar'
import type { StringsOverride } from './react/strings'
import { createViewerController, type ViewerController } from './react/controller'
import type { FontSource } from './core/fonts'

export type MountOptions = Omit<DocViewerProps, 'styleTarget'>

const THEMES = ['light', 'dark', 'auto'] as const

export interface MountedViewer {
  /** the viewer's state and commands (the one passed in `options.controller`, else its own) */
  controller: ViewerController
  update(next: Partial<MountOptions>): void
  destroy(): void
}

/** Framework-free embedding: renders the viewer into `el`. */
export function mount(el: HTMLElement, options: MountOptions): MountedViewer {
  let root: Root | null = createRoot(el)
  let props = options
  const ownController = createViewerController()
  let controller = options.controller ?? ownController
  const shadow = el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot) : undefined
  const render = () => root?.render(createElement(DocViewer, { ...props, controller, styleTarget: shadow }))
  render()
  return {
    get controller() { return controller },
    update(next) {
      props = { ...props, ...next }
      controller = props.controller ?? ownController
      render()
    },
    destroy() {
      root?.unmount()
      root = null
    },
  }
}

/**
 * Where there is no DOM (a server that imports the module to render the page it is used on) the class is still
 * defined, on a stand-in: importing must not throw. It is never constructed there (`defineElement` registers nothing).
 */
const ElementBase: typeof HTMLElement = typeof HTMLElement === 'undefined' ? (class {} as unknown as typeof HTMLElement) : HTMLElement

/**
 * `<office-viewer src="/file.xlsx" style="height:600px"></office-viewer>`
 * Rendered inside a shadow root so host page CSS cannot leak in.
 * Attributes: src, name, language (a source file's: "typescript", "py"…), editable, toolbar / thumbnails / save / download /
 * file-menu / open / capture-select-all ("false" to turn off), theme ("light" | "dark" | "auto"),
 * locale (BCP 47 tag for number/date formatting and numeric input: "de-DE" reads 1,5), fonts (a JSON list of `{ family, src, weight?, style?, unicodeRange? }` with URLs);
 * real-time collaboration: collab (hub WebSocket URL), room, user (display name), base (snapshot seq `src` was opened at).
 * Properties: `file` (File/Blob/ArrayBuffer) for local data; `icons` (map or resolver, as DocViewer's `icons`);
 * `fonts` (as DocViewer's `fonts`, bytes too; over the attribute); `strings` (texts replacing the optional enclosing table or English).
 * `controller` (ViewerController) for state and commands; `headless` displays the document alone.
 */
export class OfficeViewerElement extends ElementBase {
  static observedAttributes = ['src', 'name', 'language', 'toolbar', 'thumbnails', 'editable', 'save', 'download', 'file-menu', 'open', 'capture-select-all', 'theme', 'collab', 'room', 'user', 'base', 'comments', 'locale', 'fonts', 'headless']
  private viewer?: MountedViewer
  private _file?: Blob | ArrayBuffer
  private _icons?: Icons
  private _strings?: StringsOverride
  private _fonts?: readonly FontSource[]
  // one function each for the element's life: a new one with every update would run the viewer's load effect again (a `load` event per update)
  private readonly onLoad: NonNullable<MountOptions['onLoad']> = (client) => this.dispatchEvent(new CustomEvent('load', { detail: { kind: client.kind, name: client.name } }))
  private readonly onError: NonNullable<MountOptions['onError']> = (error) => this.dispatchEvent(new CustomEvent('error', { detail: error }))
  private readonly onComment = (e: unknown) => this.dispatchEvent(new CustomEvent('comment', { detail: e }))
  /** the viewer's state and commands, the same object for the element's whole life */
  readonly controller = createViewerController()

  get file() {
    return this._file
  }
  set file(v: Blob | ArrayBuffer | undefined) {
    this._file = v
    this.sync()
  }

  get icons() {
    return this._icons
  }
  set icons(v: Icons | undefined) {
    this._icons = v
    this.sync()
  }
  get strings() {
    return this._strings
  }
  set strings(v: StringsOverride | undefined) {
    this._strings = v
    this.sync()
  }

  get fonts() {
    return this._fonts
  }
  set fonts(v: readonly FontSource[] | undefined) {
    this._fonts = v
    this.sync()
  }

  connectedCallback() {
    if (this.viewer) return
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: 'open' })
    const host = document.createElement('div')
    host.style.cssText = 'width:100%;height:100%'
    shadow.innerHTML = '<style>:host{display:block;height:480px;position:relative}</style>'
    shadow.appendChild(host)
    this.viewer = mount(host, this.props())
  }

  disconnectedCallback() {
    this.viewer?.destroy()
    this.viewer = undefined
    if (this.shadowRoot) this.shadowRoot.innerHTML = ''
  }

  attributeChangedCallback() {
    this.sync()
  }

  private props(): MountOptions {
    return {
      src: this._file ?? this.getAttribute('src'),
      name: this.getAttribute('name') ?? undefined,
      language: this.getAttribute('language') || undefined,
      toolbar: this.hasAttribute('toolbar') ? this.getAttribute('toolbar') !== 'false' : undefined,
      thumbnails: this.getAttribute('thumbnails') !== 'false',
      editable: this.hasAttribute('editable') && this.getAttribute('editable') !== 'false',
      allowSave: this.getAttribute('save') !== 'false',
      allowDownload: this.getAttribute('download') !== 'false',
      fileMenu: this.getAttribute('file-menu') !== 'false',
      allowOpen: this.getAttribute('open') !== 'false',
      captureSelectAll: this.getAttribute('capture-select-all') !== 'false',
      theme: THEMES.find((t) => t === this.getAttribute('theme')),
      icons: this._icons,
      locale: this.getAttribute('locale') ?? undefined,
      strings: this._strings,
      headless: this.hasAttribute('headless') && this.getAttribute('headless') !== 'false',
      controller: this.controller,
      fonts: this._fonts ?? fontsAttr(this.getAttribute('fonts')),
      collab:
        this.getAttribute('collab') && this.getAttribute('room')
          ? {
              transport: this.getAttribute('collab')!,
              room: this.getAttribute('room')!,
              base: Number(this.getAttribute('base')) || 0,
              user: { name: this.getAttribute('user') || 'Guest' },
            }
          : undefined,
      comments:
        this.getAttribute('comments') === 'false'
          ? false
          : {
              user: this.getAttribute('user') ? { name: this.getAttribute('user')! } : undefined,
              onEvent: this.onComment,
            },
      onLoad: this.onLoad,
      onError: this.onError,
    }
  }

  private sync() {
    this.viewer?.update(this.props())
  }
}

/** the `fonts` attribute: a JSON list of fonts by URL; anything else is ignored, with a warning */
function fontsAttr(v: string | null): FontSource[] | undefined {
  if (!v) return undefined
  try {
    const list = JSON.parse(v) as unknown
    if (Array.isArray(list)) return list.filter((f): f is FontSource => !!f && typeof f.family === 'string' && typeof f.src === 'string')
  } catch {
    // reported below
  }
  console.warn('[office-engine] the fonts attribute is not a JSON list of { family, src } objects; it is ignored')
  return undefined
}

export function defineElement(tag = 'office-viewer') {
  if (typeof customElements !== 'undefined' && !customElements.get(tag)) customElements.define(tag, OfficeViewerElement)
}

defineElement()

export { DocViewer }
