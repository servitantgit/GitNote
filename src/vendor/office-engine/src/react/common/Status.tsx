import { createContext, useContext, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useViewer } from './Slots'

/** Toolbar slot provided by DocViewer; views portal their status text into it (no parent re-render). */
export const StatusContext = createContext<HTMLElement | null>(null)

/** The view's status line: in the viewer's top bar, and in its controller's state (a headless viewer has no bar). */
export function Status({ text, onStatus }: { text: string; onStatus?: (s: string) => void }) {
  const el = useContext(StatusContext)
  const { ctl } = useViewer()
  useEffect(() => {
    onStatus?.(text)
    ctl?.update({ status: text })
  }, [text, onStatus, ctl])
  return el ? createPortal(text, el) : null
}
