import { useEffect, useState } from 'react'
import type { ShapeKind } from '../../core/pptx/types'
import { MOD } from '../common/ContextMenu'
import { EditorBar } from '../common/Slots'
import { Btn, ColorBtn, Dropdown, fontName, fontOptions, Menu, Select, Sep, SizeBox, type IconName } from '../edit/Toolbar'
import type { PptxEditor, PptxFormat } from './PptxEditor'
import { formatNumber, useStrings, type Strings } from '../strings'

const HIGHLIGHTS = ['#ffff00', '#00ff00', '#00ffff', '#ff00ff', '#ff0000', '#0000ff', '#ffc000', '#92d050', '#c0c0c0', '#000000']

const SHAPES: { value: keyof Strings['pptx']['shapes']; icon?: IconName; sep?: boolean }[] = [
  { value: 'text', icon: 'textbox' },
  { value: 'image', icon: 'image' },
  { value: 'line', icon: 'line' },
  { value: 'rect', icon: 'rect', sep: true },
  { value: 'roundRect', icon: 'roundRect' },
  { value: 'ellipse', icon: 'ellipse' },
  { value: 'triangle', icon: 'triangle' },
  { value: 'rtTriangle' },
  { value: 'diamond' },
  { value: 'parallelogram' },
  { value: 'trapezoid' },
  { value: 'pentagon' },
  { value: 'hexagon' },
  { value: 'octagon' },
  { value: 'donut' },
  { value: 'can' },
  { value: 'heart' },
  { value: 'plus' },
  { value: 'rightArrow', icon: 'arrow', sep: true },
  { value: 'leftArrow' },
  { value: 'upArrow' },
  { value: 'downArrow' },
  { value: 'leftRightArrow' },
  { value: 'chevron' },
  { value: 'homePlate' },
  { value: 'star4', sep: true },
  { value: 'star5', icon: 'star' },
  { value: 'star6' },
  { value: 'wedgeRectCallout', sep: true },
  { value: 'wedgeRoundRectCallout' },
]

const LINE_W = [0.75, 1, 1.5, 2.25, 3, 4.5, 6]
const DASHES = [
  { value: 'solid', hint: '────' },
  { value: 'sysDot', hint: '········' },
  { value: 'dash', hint: '- - - -' },
  { value: 'lgDash', hint: '— — —' },
  { value: 'dashDot', hint: '-·-·-·' },
] as const
const SPACING = [1, 1.15, 1.5, 2]
const VALIGN = [
  { value: 't', k: 'top', icon: 'vTop' },
  { value: 'ctr', k: 'middle', icon: 'vMiddle' },
  { value: 'b', k: 'bottom', icon: 'vBottom' },
] as const

export type Arrange = 'front' | 'forward' | 'backward' | 'back'
export type Rotate = 'cw' | 'ccw' | 'flipH' | 'flipV'
export type AlignTo = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'
export type SlideCmd = 'add' | 'duplicate' | 'delete' | 'up' | 'down' | 'hide'

export function PptxToolbar(props: {
  editor: PptxEditor
  /** selected shape (not editing its text) */
  shape: { canText: boolean; anchor?: 't' | 'ctr' | 'b' } | null
  /** anchor of the text box being edited */
  textAnchor?: 't' | 'ctr' | 'b'
  canUndo: boolean
  canRedo: boolean
  onUndo: (redo: boolean) => void
  onInsert: (k: ShapeKind) => void
  onFill: (c: string | null) => void
  onLine: (p: { color?: string | null; w?: number; dash?: string }) => void
  onArrange: (k: Arrange) => void
  onRotate: (k: Rotate) => void
  onAlign: (k: AlignTo) => void
  onAnchor: (a: 't' | 'ctr' | 'b') => void
  onDuplicate: () => void
  onDelete: () => void
  onBackground: (c: string | null) => void
  onSlide: (k: SlideCmd) => void
  onPresent: (fromStart: boolean) => void
}) {
  const { editor } = props
  const [st, setSt] = useState<PptxFormat | null>(null)
  useEffect(() => {
    editor.onState = setSt
    return () => {
      editor.onState = undefined
    }
  }, [editor])
  const text = !!st && editor.active
  const font = fontName(st?.font)
  const sz = st?.sz ? Math.round(st.sz * 2) / 2 : undefined
  const anchor = text ? props.textAnchor : props.shape?.anchor
  const t = useStrings()
  const kb = (label: string, keys: string) => t.edit.keyed(label, keys)
  const valign = VALIGN.map(({ k, ...x }) => ({ ...x, label: t.format.vAligns[k] }))
  return (
    <EditorBar>
      <Btn icon="undo" title={kb(t.edit.undo, `${MOD}Z`)} disabled={!text && !props.canUndo} onClick={() => (text ? editor.undo() : props.onUndo(false))} />
      <Btn icon="redo" title={kb(t.edit.redo, `${MOD}Y`)} disabled={!text && !props.canRedo} onClick={() => (text ? editor.redo() : props.onUndo(true))} />
      <Sep />
      <Menu title={t.pptx.insert} label={t.pptx.insert} icon="plus" items={SHAPES.map((x) => ({ ...x, label: t.pptx.shapes[x.value] }))} onPick={(v) => props.onInsert(v as ShapeKind)} />
      <Menu
        title={t.pptx.slide}
        label={t.pptx.slide}
        icon="slideAdd"
        items={[
          { value: 'add', label: t.pptx.newSlide, icon: 'slideAdd', hint: `${MOD}M` },
          { value: 'duplicate', label: t.pptx.duplicateSlide, icon: 'copy' },
          { value: 'delete', label: t.pptx.deleteSlide, icon: 'trash' },
          { value: 'up', label: t.pptx.moveUp, icon: 'up', sep: true },
          { value: 'down', label: t.pptx.moveDown, icon: 'down' },
          { value: 'hide', label: t.pptx.hideShow, icon: 'hide', sep: true },
        ]}
        onPick={(v) => props.onSlide(v as SlideCmd)}
      />
      <Sep />
      {text ? (
        <>
          <Select title={t.edit.font} width={112} menuWidth={200} value={font} placeholder={t.edit.font} options={fontOptions(font)} onChange={(v) => editor.setFont(v)} />
          <Sep />
          <SizeBox value={sz} onChange={(v) => editor.setSize(v)} />
          <Sep />
          <Btn icon="bold" title={kb(t.edit.bold, `${MOD}B`)} active={st?.b} onClick={() => editor.toggle('b')} />
          <Btn icon="italic" title={kb(t.edit.italic, `${MOD}I`)} active={st?.i} onClick={() => editor.toggle('i')} />
          <Btn icon="underline" title={kb(t.edit.underline, `${MOD}U`)} active={st?.u} onClick={() => editor.toggle('u')} />
          <Btn icon="strike" title={t.edit.strike} active={st?.strike} onClick={() => editor.toggle('strike')} />
          <ColorBtn icon="color" title={t.edit.textColor} value={st?.color} onPick={(c) => editor.setColor(c)} noneLabel={t.edit.automatic} />
          <ColorBtn icon="highlight" title={t.edit.highlight} value={st?.hl} palette={HIGHLIGHTS} onPick={(c) => editor.setHighlight(c)} />
          <Btn icon="sup" title={t.edit.sup} active={(st?.baseline ?? 0) > 0} onClick={() => editor.toggleBaseline('sup')} />
          <Btn icon="sub" title={t.edit.sub} active={(st?.baseline ?? 0) < 0} onClick={() => editor.toggleBaseline('sub')} />
          <Sep />
          <Btn icon="alignLeft" title={t.edit.alignLeft} active={st?.algn === 'left'} onClick={() => editor.setAlign('left')} />
          <Btn icon="alignCenter" title={t.edit.center} active={st?.algn === 'center'} onClick={() => editor.setAlign('center')} />
          <Btn icon="alignRight" title={t.edit.alignRight} active={st?.algn === 'right'} onClick={() => editor.setAlign('right')} />
          <Btn icon="justify" title={t.edit.justify} active={st?.algn === 'justify'} onClick={() => editor.setAlign('justify')} />
          <Dropdown title={t.format.vAlign} icon={VALIGN.find((x) => x.value === anchor)?.icon ?? 'vTop'} label={null} menuWidth={140} value={anchor ?? 't'} options={valign} onChange={props.onAnchor} />
          <Dropdown
            title={t.pptx.lineSpacing}
            icon="lineSpacing"
            label={null}
            menuWidth={140}
            value={st?.lnPct ? Math.round(st.lnPct * 100) / 100 : ''}
            options={SPACING.map((v) => ({ value: v, label: v === 1 ? t.format.spacings.single : v === 2 ? t.format.spacings.double : formatNumber(t, v) }))}
            onChange={(v) => editor.setLineSpacing(v)}
          />
          <Sep />
          <Btn icon="bullets" title={t.edit.bullets} active={st?.bullet === 'bullet'} onClick={() => editor.toggleBullet('bullet')} />
          <Btn icon="numbers" title={t.edit.numbers} active={st?.bullet === 'number'} onClick={() => editor.toggleBullet('number')} />
          <Btn icon="outdent" title={kb(t.edit.indentLess, 'Shift+Tab')} disabled={!st?.lvl} onClick={() => editor.indentLevel(-1)} />
          <Btn icon="indent" title={t.edit.indentMore} onClick={() => editor.indentLevel(1)} />
          <Btn icon="clear" title={t.edit.clearFormat} onClick={() => editor.clearFormat()} />
        </>
      ) : props.shape ? (
        <>
          <ColorBtn icon="fill" title={t.pptx.fillColor} onPick={props.onFill} noneLabel={t.pptx.transparent} />
          <ColorBtn icon="borders" title={t.pptx.borderColor} onPick={(c) => props.onLine({ color: c })} noneLabel={t.pptx.transparent} />
          <Dropdown title={t.pptx.borderWeight} icon="lineWeight" label={null} menuWidth={120} options={LINE_W.map((w) => ({ value: w, label: t.pptx.points(formatNumber(t, w)) }))} onChange={(w) => props.onLine({ w })} />
          <Dropdown title={t.pptx.borderDash} icon="lineStyle" label={null} menuWidth={170} options={DASHES.map((x) => ({ ...x, label: t.pptx.dashes[x.value] }))} onChange={(dash) => props.onLine({ dash })} />
          <Sep />
          <Menu
            title={t.pptx.arrange}
            label={t.pptx.arrange}
            icon="front"
            items={[
              { value: 'front', label: t.pptx.front, icon: 'front', hint: `${MOD}⇧↑` },
              { value: 'forward', label: t.pptx.forward, hint: `${MOD}↑` },
              { value: 'backward', label: t.pptx.backward, hint: `${MOD}↓` },
              { value: 'back', label: t.pptx.back, icon: 'back', hint: `${MOD}⇧↓` },
            ]}
            onPick={(v) => props.onArrange(v as Arrange)}
          />
          <Dropdown
            title={t.pptx.rotate}
            icon="rotate"
            label={null}
            menuWidth={220}
            options={[
              { value: 'cw', label: t.pptx.cw, icon: 'rotate' },
              { value: 'ccw', label: t.pptx.ccw, icon: 'rotateCcw' },
              { value: 'flipH', label: t.pptx.flipH, icon: 'flipH', sep: true },
              { value: 'flipV', label: t.pptx.flipV, icon: 'flipV' },
            ]}
            onChange={(v) => props.onRotate(v as Rotate)}
          />
          <Dropdown
            title={t.pptx.alignOnSlide}
            icon="alignObj"
            label={null}
            menuWidth={150}
            options={[
              { value: 'left', label: t.pptx.aligns.left, icon: 'alignLeft' },
              { value: 'center', label: t.pptx.aligns.center, icon: 'alignCenter' },
              { value: 'right', label: t.pptx.aligns.right, icon: 'alignRight' },
              { value: 'top', label: t.pptx.aligns.top, icon: 'vTop', sep: true },
              { value: 'middle', label: t.pptx.aligns.middle, icon: 'vMiddle' },
              { value: 'bottom', label: t.pptx.aligns.bottom, icon: 'vBottom' },
            ]}
            onChange={(v) => props.onAlign(v as AlignTo)}
          />
          {props.shape.canText && (
            <Dropdown title={t.pptx.textAlign} icon={VALIGN.find((x) => x.value === anchor)?.icon ?? 'vTop'} label={null} menuWidth={140} value={anchor ?? 't'} options={valign} onChange={props.onAnchor} />
          )}
          <Sep />
          <Btn icon="copy" title={kb(t.pptx.duplicate, `${MOD}D`)} onClick={props.onDuplicate} />
          <Btn icon="trash" title={t.pptx.deleteTitle} onClick={props.onDelete} />
        </>
      ) : (
        <>
          <ColorBtn icon="fill" title={t.pptx.background} onPick={props.onBackground} noneLabel={t.pptx.layoutDefault} />
          <span className="de-tb-hint">{t.pptx.clickToEdit}</span>
        </>
      )}
      <Sep />
      <Dropdown
        title={t.pptx.present}
        icon="play"
        label={t.pptx.present}
        menuWidth={200}
        options={[
          { value: 'cur', label: t.pptx.fromCurrent, hint: 'F5' },
          { value: 'start', label: t.pptx.fromStart, hint: '⇧F5' },
        ]}
        onChange={(v) => props.onPresent(v === 'start')}
      />
    </EditorBar>
  )
}
