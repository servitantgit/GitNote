import type { CSSProperties } from 'react'
import { useViewerState, type ViewerController } from './controller'
import { Btn, Sep, SizeBox, ToolbarRow } from './edit/Toolbar'
import { formatNumber, useStrings } from './strings'

// Controls for a headless viewer, each driven by its controller alone: a host places them where it likes, around a
// `<DocViewer controller={ctl} headless />`. They render through the host's components, icons, texts and theme
// (UIComponentsProvider, IconsProvider, StringsProvider, the tokens on a `.de-root` around them), as the built-in
// toolbars do.

interface Props {
  controller: ViewerController
  className?: string
  style?: CSSProperties
}

/** Zoom out, the zoom (a click switches between fitting the width and 100 %), zoom in; nothing for spreadsheets. */
export function ZoomBar({ controller: ctl, className, style }: Props) {
  const { zoom } = useViewerState(ctl)
  const t = useStrings()
  if (!zoom) return null
  const fit = zoom.value === 'fit'
  return (
    <div className={'de-ctl-zoom' + (className ? ` ${className}` : '')} style={style} role="group" aria-label={t.zoom.group}>
      <Btn icon="zoomOut" title={t.zoom.out} onClick={() => ctl.zoomOut()} />
      <Btn wide title={fit ? t.zoom.fitTitle : t.zoom.toFit} label={fit ? t.zoom.fit : formatNumber(t, zoom.effective, { style: 'percent' })} onClick={() => ctl.setZoom(fit ? 1 : 'fit')} />
      <Btn icon="zoomIn" title={t.zoom.in} onClick={() => ctl.zoomIn()} />
    </div>
  )
}

/** The outline as a list: a document's headings (indented by level), a workbook's sheets, a presentation's slides. */
export function OutlineList({ controller: ctl, className, style }: Props) {
  const { outline, pointing } = useViewerState(ctl)
  const t = useStrings()
  if (!outline) return null
  const label = outline.kind === 'headings' ? t.docx.outline : outline.kind === 'sheets' ? t.xlsx.sheets : t.pptx.slides
  return (
    <nav className={'de-ctl-outline' + (className ? ` ${className}` : '')} style={style} aria-label={label}>
      {outline.items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={item.current ? 'de-outline-item on' : 'de-outline-item'}
          aria-current={item.current || undefined}
          style={{ paddingLeft: 10 + item.level * 14 }}
          title={item.title}
          // a workbook's sheets: as with SheetTabs, a formula that can take a reference stays open across the switch
          onMouseDown={(e) => pointing && e.preventDefault()}
          onClick={() => ctl.goto(item.id)}
        >
          {item.title}
        </button>
      ))}
    </nav>
  )
}

/** A workbook's visible sheets as tabs; nothing for other documents. */
export function SheetTabs({ controller: ctl, className, style }: Props) {
  const { outline, pointing } = useViewerState(ctl)
  const t = useStrings()
  if (outline?.kind !== 'sheets') return null
  return (
    <div className={'de-tabs' + (className ? ` ${className}` : '')} style={style} role="tablist" aria-label={t.xlsx.sheets}>
      {outline.items.map((item) => (
        // while a formula being typed can take a reference, the grid keeps the focus, so the click does not commit it
        // and the reference can point at the sheet switched to; any other edit is committed by the click, as with the
        // built-in tabs
        <button key={item.id} type="button" role="tab" className="de-tab" aria-selected={item.current} onMouseDown={(e) => pointing && e.preventDefault()} onClick={() => ctl.goto(item.id)}>
          {item.title}
        </button>
      ))}
    </div>
  )
}

/** The view's status line: "Page 2 of 7 · 1,204 words", "Slide 3 of 12". */
export function StatusText({ controller: ctl, className, style }: Props) {
  const { status } = useViewerState(ctl)
  return (
    <span className={'de-ctl-status' + (className ? ` ${className}` : '')} style={style} aria-live="polite">
      {status}
    </span>
  )
}

/**
 * Undo, redo and the formatting every kind shares (marks, size, alignment, lists where there are lists), through
 * `ViewerController.format`. Disabled while there is no selection to format, but kept in place, so the bar does not
 * change its width as the focus moves; nothing while viewing.
 */
export function FormatBar({ controller: ctl, className, style }: Props) {
  const s = useViewerState(ctl)
  const t = useStrings()
  if (!s.editing) return null
  const f = s.format
  const off = !f
  // documents and slides have justified text and lists; cells have neither
  const paragraphs = s.kind === 'docx' || s.kind === 'pptx'
  // a list button that shows as pressed removes the list, as in the built-in toolbars
  const list = (kind: 'bullet' | 'number') => ctl.format({ op: 'list', list: f?.list === kind ? null : kind })
  const mark = (m: 'bold' | 'italic' | 'underline' | 'strike', icon: 'bold' | 'italic' | 'underline' | 'strike', title: string) => (
    <Btn icon={icon} title={title} active={!!f?.[m]} disabled={off} onClick={() => ctl.format({ op: 'toggle', mark: m })} />
  )
  const align = (a: 'left' | 'center' | 'right' | 'justify', icon: 'alignLeft' | 'alignCenter' | 'alignRight' | 'justify', title: string) => (
    <Btn icon={icon} title={title} active={f?.align === a} disabled={off} onClick={() => ctl.format({ op: 'align', align: a })} />
  )
  return (
    <div className={'de-ctl-format' + (className ? ` ${className}` : '')} style={style}>
      <ToolbarRow>
      <Btn icon="undo" title={t.edit.undo} disabled={!s.canUndo} onClick={() => ctl.undo()} />
      <Btn icon="redo" title={t.edit.redo} disabled={!s.canRedo} onClick={() => ctl.redo()} />
      <Sep />
      <SizeBox value={f?.size} disabled={off} onChange={(pt) => ctl.format({ op: 'size', pt })} />
      <Sep />
      {mark('bold', 'bold', t.edit.bold)}
      {mark('italic', 'italic', t.edit.italic)}
      {mark('underline', 'underline', t.edit.underline)}
      {mark('strike', 'strike', t.edit.strike)}
      <Sep />
      {align('left', 'alignLeft', t.edit.alignLeft)}
      {align('center', 'alignCenter', t.edit.center)}
      {align('right', 'alignRight', t.edit.alignRight)}
      {paragraphs && align('justify', 'justify', t.edit.justify)}
      {paragraphs && <Sep />}
      {paragraphs && <Btn icon="bullets" title={t.edit.bullets} active={f?.list === 'bullet'} disabled={off || f.list === undefined} onClick={() => list('bullet')} />}
      {paragraphs && <Btn icon="numbers" title={t.edit.numbers} active={f?.list === 'number'} disabled={off || f.list === undefined} onClick={() => list('number')} />}
      <Sep />
      <Btn icon="clear" title={t.edit.clearFormat} disabled={off} onClick={() => ctl.format({ op: 'clear' })} />
      </ToolbarRow>
    </div>
  )
}
