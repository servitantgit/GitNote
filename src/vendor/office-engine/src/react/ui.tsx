import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ComponentType, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react'
import type { DropOption, IconName, Icons } from './edit/Toolbar'
import { IconsProvider } from './edit/Toolbar'
import { StringsProvider, type Locale, type StringsOverride } from './strings'

/**
 * A toolbar button. `onMouseDown` must reach the rendered element: it prevents the default so the document keeps
 * the focus and its selection while the button is clicked.
 */
export interface ButtonProps {
  title: string
  /** the icon, already resolved through the host's `icons` */
  icon?: ReactNode
  /** the icon's name, for a host that draws its own */
  iconName?: IconName
  /** text instead of (or after) the icon */
  label?: ReactNode
  /** content after the icon and label: a color swatch, a chevron */
  children?: ReactNode
  active?: boolean
  /** a popup this button opens is open */
  expanded?: boolean
  disabled?: boolean
  /** sized to its label rather than square */
  wide?: boolean
  onClick: () => void
  onMouseDown: (e: MouseEvent) => void
  /** the engine's own class names, for a host that keeps the engine's CSS for some buttons */
  className: string
}

/**
 * A dropdown: a value picker (`value` set: the chosen option is checked) or a command menu (`value` undefined).
 * A host's version must not move the focus out of the document while it is open, or editing commands lose their
 * selection: open it on mouse down with the default prevented, and handle its keys without focusing it.
 */
export interface SelectProps<T extends string | number = string | number> {
  title: string
  options: DropOption<T>[]
  onChange: (v: T) => void
  value?: T | ''
  placeholder?: string
  /** fixed trigger content (menus); null = icon only */
  label?: ReactNode
  /** Icon name, rendered by the host with `<Icon name={icon} />` (unlike Button's resolved node). */
  icon?: IconName
  width?: number
  menuWidth?: number
  disabled?: boolean
  /** popup aligned to the trigger's right edge */
  alignRight?: boolean
  /** extra class of the trigger button */
  className?: string
}

export interface DialogAction {
  label: string
  onClick?: () => void
  /** an auxiliary action, placed at the start of the built-in dialog's action row */
  extra?: boolean
  /** the main action: styled as such; with `submit`, also what Enter does */
  primary?: boolean
  /** submits the dialog's form (`onSubmit`); hosts with an external footer can call `onClick` instead */
  submit?: boolean
  autoFocus?: boolean
}

/** A modal dialog. Escape and a click on the backdrop call `onClose`; with `onSubmit` the body is a form. */
export interface DialogProps {
  title: string
  /** 'alert' for a question that needs an answer (role alertdialog) */
  kind?: 'dialog' | 'alert'
  onClose: () => void
  onSubmit?: () => void
  children: ReactNode
  actions: DialogAction[]
}

export interface ToastProps {
  text: string
}

/** The UI components a host can replace; each one left out keeps the engine's own. */
export interface UIComponents {
  Button: ComponentType<ButtonProps>
  Select: ComponentType<SelectProps>
  Separator: ComponentType
  Dialog: ComponentType<DialogProps>
  Toast: ComponentType<ToastProps>
}

const UIContext = createContext<Partial<UIComponents>>({})

/** Replaces UI components for everything below it; an outer provider's components stay for those left out. */
export function UIComponentsProvider({ components, children }: { components?: Partial<UIComponents>; children?: ReactNode }) {
  const outer = useContext(UIContext)
  const value = useMemo(() => {
    if (!components) return outer
    const defined = Object.fromEntries(Object.entries(components).filter(([, component]) => component !== undefined))
    return { ...outer, ...defined }
  }, [outer, components])
  return <UIContext.Provider value={value}>{children}</UIContext.Provider>
}

/** The host's components; undefined where the engine's own apply. */
export const useHostUI = (): Partial<UIComponents> => useContext(UIContext)

/** Everything a host customizes besides the theme, in one provider: for views mounted without `DocViewer`. */
export function OfficeUIProvider(props: { icons?: Icons; components?: Partial<UIComponents>; locale?: Locale | string; strings?: StringsOverride; children?: ReactNode }) {
  return (
    <StringsProvider locale={props.locale} strings={props.strings}>
      <IconsProvider icons={props.icons}>
        <UIComponentsProvider components={props.components}>{props.children}</UIComponentsProvider>
      </IconsProvider>
    </StringsProvider>
  )
}

// ---------------------------------------------------------------- the engine's own dialog and toast

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

/**
 * A dialog keeps the keyboard while it is open and gives it back when it closes: Tab goes round inside it (behind it
 * Escape would no longer reach it), and the focus returns to where it was, else to the document, so that the
 * viewer's keys (Ctrl+S, Ctrl+F…) work again without a click.
 */
function useDialogFocus(back: RefObject<HTMLDivElement | null>) {
  // what has the focus as the dialog is first drawn: before a field of it takes it
  const before = useRef<Element | null | undefined>(undefined)
  if (before.current === undefined) before.current = typeof document === 'undefined' ? null : document.activeElement
  useLayoutEffect(() => {
    const el = back.current
    if (!el) return
    const scope = el.getRootNode() as Document | ShadowRoot
    const root = el.closest<HTMLElement>('.de-root')
    return () => {
      // once the dialog is gone: unless what closed it put the focus somewhere itself
      setTimeout(() => {
        const now = scope.activeElement
        if (now && now !== el.ownerDocument.body && now.isConnected) return
        const was = before.current
        // (inside a shadow root the page only knows the host: the document is looked for instead)
        const back = was instanceof HTMLElement && was.isConnected && root?.contains(was) ? was : null
        const doc = (q: string) => root?.querySelector<HTMLElement>(q)
        ;(back ?? doc('.de-pages[contenteditable="true"]') ?? doc('.de-grid') ?? doc('.de-scroll'))?.focus({ preventScroll: true })
      }, 0)
    }
  }, [back])
  return (e: KeyboardEvent<HTMLElement>) => {
    const el = back.current
    if (e.key !== 'Tab' || !el) return
    const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.getClientRects().length > 0)
    if (!items.length) return e.preventDefault()
    const active = (el.getRootNode() as Document | ShadowRoot).activeElement
    const edge = items[e.shiftKey ? 0 : items.length - 1]
    if (active !== edge && el.contains(active)) return
    e.preventDefault()
    items[e.shiftKey ? items.length - 1 : 0].focus()
  }
}

/** what a dialog is drawn over: closes it (a press beside it, Escape) and keeps the keyboard in it */
function DialogBack(props: { onClose: () => void; children: ReactNode }) {
  const back = useRef<HTMLDivElement>(null)
  const onTab = useDialogFocus(back)
  return (
    <div
      ref={back}
      className="de-dialog-back"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          props.onClose()
        } else onTab(e)
      }}
    >
      {props.children}
    </div>
  )
}

export function DefaultDialog(props: DialogProps) {
  const body = (
    <>
      <div className="de-dialog-title">{props.title}</div>
      {props.children}
      <div className="de-dialog-btns">
        {props.actions.map((a, i) => (
          <button
            key={i}
            type={a.submit ? 'submit' : 'button'}
            className={'de-btn' + (a.primary ? ' de-btn-primary' : '') + (a.extra ? ' de-dialog-extra' : '')}
            autoFocus={a.autoFocus}
            onClick={a.submit && props.onSubmit ? undefined : a.onClick}
          >
            {a.label}
          </button>
        ))}
      </div>
    </>
  )
  const submit = (e: FormEvent) => {
    e.preventDefault()
    props.onSubmit?.()
  }
  return (
    <DialogBack onClose={props.onClose}>
      {props.onSubmit ? (
        <form className="de-dialog" role={props.kind === 'alert' ? 'alertdialog' : 'dialog'} aria-modal="true" aria-label={props.title} onSubmit={submit}>
          {body}
        </form>
      ) : (
        <div className="de-dialog" role={props.kind === 'alert' ? 'alertdialog' : 'dialog'} aria-modal="true" aria-label={props.title}>
          {body}
        </div>
      )}
    </DialogBack>
  )
}

export function DefaultToast({ text }: ToastProps) {
  return (
    <div className="de-toast" role="status">
      {text}
    </div>
  )
}
