import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useStrings } from '../strings'
import { DefaultDialog, DefaultToast, useHostUI, type DialogAction } from '../ui'

export interface PromptSpec {
  title: string
  label?: string
  initial?: string
  placeholder?: string
  ok?: string
  /** multi-line input */
  area?: boolean
  onOk: (value: string) => void
  /** extra button (e.g. "Remove link") */
  extra?: { label: string; run: () => void }
  note?: ReactNode
}

/** Small modal prompt (no window.prompt: works in sandboxed / embedded pages). */
export function PromptDialog({ spec, onClose }: { spec: PromptSpec; onClose: () => void }) {
  const t = useStrings()
  const Dialog = useHostUI().Dialog ?? DefaultDialog
  const [v, setV] = useState(spec.initial ?? '')
  const ref = useCallback((el: HTMLInputElement | HTMLTextAreaElement | null) => {
    el?.focus()
    el?.select()
  }, [])
  const done = () => {
    onClose()
    spec.onOk(v)
  }
  const actions: DialogAction[] = [
    ...(spec.extra
      ? [
          {
            label: spec.extra.label,
            extra: true,
            onClick: () => {
              onClose()
              spec.extra!.run()
            },
          },
        ]
      : []),
    { label: t.common.cancel, onClick: onClose },
    { label: spec.ok ?? t.common.ok, primary: true, submit: true, onClick: done },
  ]
  return (
    <Dialog title={spec.title} onClose={onClose} onSubmit={done} actions={actions}>
      {spec.label && <label className="de-dialog-label">{spec.label}</label>}
      {spec.area ? (
        <textarea ref={ref} rows={3} value={v} placeholder={spec.placeholder} onChange={(e) => setV(e.target.value)} />
      ) : (
        <input ref={ref} value={v} placeholder={spec.placeholder} onChange={(e) => setV(e.target.value)} />
      )}
      {spec.note && <div className="de-dialog-note">{spec.note}</div>}
    </Dialog>
  )
}

/** Yes / no question (no window.confirm: works in sandboxed / embedded pages). */
export function ConfirmDialog(props: { title: string; message: ReactNode; ok: string; onOk: () => void; onClose: () => void }) {
  const t = useStrings()
  const Dialog = useHostUI().Dialog ?? DefaultDialog
  const actions: DialogAction[] = [
    { label: t.common.cancel, onClick: props.onClose },
    {
      label: props.ok,
      primary: true,
      autoFocus: true,
      onClick: () => {
        props.onClose()
        props.onOk()
      },
    },
  ]
  return (
    <Dialog title={props.title} kind="alert" onClose={props.onClose} actions={actions}>
      <div className="de-dialog-note">{props.message}</div>
    </Dialog>
  )
}

/** Short-lived message at the bottom of the viewer. */
export function Toast({ text, onDone }: { text: string; onDone: () => void }) {
  const Shown = useHostUI().Toast ?? DefaultToast
  useEffect(() => {
    const id = setTimeout(onDone, 3500)
    return () => clearTimeout(id)
  }, [text, onDone])
  return <Shown text={text} />
}
