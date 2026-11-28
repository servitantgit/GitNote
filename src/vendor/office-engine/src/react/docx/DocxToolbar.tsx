import { useEffect, useState, type CSSProperties } from 'react'
import type { CanonStyle, StyleInfo } from '../../core/docx/types'
import { MOD } from '../common/ContextMenu'
import { EditorBar } from '../common/Slots'
import { Btn, ColorBtn, Dropdown, fontName, fontOptions, GridPicker, Icon, Menu, pickFiles, Pop, Select, Sep, SizeBox, type DropOption, type IconName } from '../edit/Toolbar'
import type { BorderPreset } from './tables'
import type { DocxEditor, FormatState } from './DocxEditor'
import { formatNumber, useStrings, type Strings } from '../strings'

const HIGHLIGHTS = ['#ffff00', '#00ff00', '#00ffff', '#ff00ff', '#0000ff', '#ff0000', '#000080', '#008080', '#008000', '#800080', '#800000', '#808000', '#808080', '#c0c0c0', '#000000']

const CELL_BORDERS: { k: BorderPreset; icon: IconName }[] = [
  { k: 'all', icon: 'bAll' },
  { k: 'inner', icon: 'bInner' },
  { k: 'outer', icon: 'bOuter' },
  { k: 'none', icon: 'bNone' },
  { k: 'top', icon: 'bTop' },
  { k: 'bottom', icon: 'bBottom' },
  { k: 'left', icon: 'bLeft' },
  { k: 'right', icon: 'bRight' },
]
/** cell border lines: value is the CSS width + style */
export const cellLines = (t: Strings) => [
  { value: '0.5pt solid', label: t.format.lines.thin, hint: '───' },
  { value: '1.5pt solid', label: t.format.lines.medium, hint: '━━━' },
  { value: '3pt solid', label: t.format.lines.thick, hint: '▬▬▬' },
  { value: '0.5pt dashed', label: t.format.lines.dashed, hint: '- - -' },
  { value: '0.5pt dotted', label: t.format.lines.dotted, hint: '·····' },
  { value: '2.25pt double', label: t.format.lines.double, hint: '═══' },
]
const VALIGN = [
  { value: 'top', icon: 'vTop' },
  { value: 'middle', icon: 'vMiddle' },
  { value: 'bottom', icon: 'vBottom' },
] as const

const LINE_SPACING: { value: number; k?: keyof Strings['format']['spacings'] }[] = [
  { value: 1, k: 'single' },
  { value: 1.15 },
  { value: 1.5 },
  { value: 2, k: 'double' },
  { value: 2.5 },
  { value: 3, k: 'triple' },
]

/** built-in styles always offered (created in the document on first use) */
const CANON: { k: CanonStyle; look: CSSProperties }[] = [
  { k: 'normal', look: {} },
  { k: 'title', look: { fontSize: 22 } },
  { k: 'subtitle', look: { fontSize: 15, color: '#5a5a5a' } },
  { k: 'h1', look: { fontSize: 18, color: '#2f5496' } },
  { k: 'h2', look: { fontSize: 16, color: '#2f5496' } },
  { k: 'h3', look: { fontSize: 14, color: '#1f3763' } },
  { k: 'h4', look: { fontSize: 13, color: '#2f5496', fontStyle: 'italic' } },
  { k: 'h5', look: { fontSize: 13, color: '#2f5496' } },
  { k: 'h6', look: { fontSize: 13, color: '#1f3763', fontStyle: 'italic' } },
]

const SYMBOLS = [
  '©', '®', '™', '§', '¶', '†', '‡', '•', '…', '–', '—', '‰',
  '€', '£', '¥', '¢', '₫', '$', '°', '±', '×', '÷', '≈', '≠',
  '≤', '≥', '∞', '√', '∑', '∏', '∫', 'π', 'µ', 'Ω', 'α', 'β',
  '←', '→', '↑', '↓', '↔', '⇒', '✓', '✗', '★', '☆', '♥', '♦',
  '«', '»', '“', '”', '‘', '’', '¼', '½', '¾', '¹', '²', '³',
]

/** the paragraph styles offered: the built-in ones first (in the document or not: `@kind` then), then the document's other quick styles */
export function styleChoices(styles: StyleInfo[], t: Strings) {
  const out: { value: string; label: string; k?: CanonStyle; s?: StyleInfo; look?: CSSProperties; sep: boolean }[] = CANON.map(({ k, look }, i) => {
    const s = styles.find((x) => x.canon === k)
    return { value: s?.id ?? `@${k}`, label: t.docx.styles[k], k, s, look, sep: i === 1 }
  })
  styles.filter((s) => !s.canon).forEach((s, i) => out.push({ value: s.id, label: s.name, s, sep: i === 0 }))
  return out
}

/** how a style looks in the picker (size clamped to fit the menu) */
function stylePreview(s: StyleInfo | undefined): CSSProperties | undefined {
  const p = s?.preview
  if (!p) return undefined
  return {
    fontSize: p.sz ? Math.max(12, Math.min(22, p.sz)) : undefined,
    fontWeight: p.b ? 700 : undefined,
    fontStyle: p.i ? 'italic' : undefined,
    color: p.color && !/^#?f{6}$/i.test(p.color.replace('#', '')) ? p.color : undefined,
    fontFamily: p.font,
    lineHeight: 1.25,
  }
}

export interface ImageActions {
  original: () => void
  replace: () => void
  alt: () => void
  /** undefined when downloads are disabled */
  download?: () => void
}

export function DocxToolbar(props: {
  editor: DocxEditor
  styles: StyleInfo[]
  onFind: () => void
  outline: boolean
  /** the outline panel opened / closed; no button without it (a headless viewer: the host shows the outline) */
  onOutline?: () => void
  painter: boolean
  onLink: () => void
  image: ImageActions
  /** opens the page setup dialog */
  onPageSetup?: () => void
  /** opens the header / footer dialog */
  onHeaderFooter?: () => void
  /** a short message for the user (toast) */
  onNotice?: (text: string) => void
}) {
  const { editor, styles, image } = props
  const t = useStrings()
  const kb = (label: string, keys: string) => t.edit.keyed(label, keys)
  const [st, setSt] = useState<FormatState | null>(null)
  const [bColor, setBColor] = useState('#000000')
  const [bLine, setBLine] = useState('0.5pt solid')
  useEffect(() => {
    editor.onState = setSt
    return () => {
      editor.onState = undefined
    }
  }, [editor])
  const font = fontName(st?.font)
  const dis = !st
  const sz = st?.sz ? Math.round(st.sz * 2) / 2 : undefined
  const line = st?.line ? Math.round(st.line * 100) / 100 : ''

  // style picker: built-ins first (with shortcuts), then the document's other quick styles
  const alt = /Mac|iPhone|iPad/.test(typeof navigator !== 'undefined' ? navigator.platform : '') ? '⌥' : 'Alt+'
  const styleOpts: DropOption<string>[] = styleChoices(styles, t).map(({ value, label, k, s, look, sep }) => {
    const hint = k === 'normal' ? `${MOD}${alt}0` : k?.startsWith('h') ? `${MOD}${alt}${k.slice(1)}` : undefined
    return { value, label, hint, style: k ? { lineHeight: 1.25, ...(k === 'normal' ? {} : (stylePreview(s) ?? look)) } : stylePreview(s), sep }
  })
  const styleValue = st?.style && styleOpts.some((o) => o.value === st.style) ? st.style : st && !st.style ? (styles.find((x) => x.canon === 'normal')?.id ?? '') : ''

  return (
    <EditorBar>
      <Btn icon="undo" title={kb(t.edit.undo, `${MOD}Z`)} disabled={!editor.canUndo} onClick={() => editor.undo()} />
      <Btn icon="redo" title={kb(t.edit.redo, `${MOD}Y`)} disabled={!editor.canRedo} onClick={() => editor.redo()} />
      <Btn icon="paint" title={t.docx.paint} active={props.painter} disabled={dis} onClick={() => editor.copyFormat()} />
      {st?.inTable && (
        <>
          <Sep />
          <Menu
            title={t.table.menu}
            label={t.table.menu}
            icon="table"
            items={[
              { value: 'rowAbove', label: t.table.rowAbove, icon: 'rowAbove' },
              { value: 'rowBelow', label: t.table.rowBelow, icon: 'rowBelow' },
              { value: 'colLeft', label: t.table.colLeft, icon: 'colLeft' },
              { value: 'colRight', label: t.table.colRight, icon: 'colRight' },
              { value: 'delRow', label: t.table.delRow, icon: 'delRow', sep: true },
              { value: 'delCol', label: t.table.delCol, icon: 'delCol' },
              { value: 'delTable', label: t.table.delTable, icon: 'trash' },
              { value: 'distribute', label: t.table.distribute, icon: 'colAdd', sep: true },
            ]}
            onPick={(v) => (v === 'distribute' ? editor.distributeColumns() : editor.tableOp(v as Parameters<DocxEditor['tableOp']>[0]))}
          />
          <Btn
            icon="merge"
            title={st.cells?.merged && (st.cells?.n ?? 0) < 2 ? t.table.unmerge : t.table.merge}
            active={st.cells?.merged && (st.cells?.n ?? 0) < 2}
            disabled={!st.cells || (st.cells.n < 2 && !st.cells.merged)}
            onClick={() => ((st.cells?.n ?? 0) > 1 ? editor.mergeCells() : editor.unmergeCell())}
          />
          <ColorBtn icon="fill" title={t.docx.cellColor} value={st.cells?.shd} onPick={(c) => editor.setCellShade(c)} noneLabel={t.format.noFill} />
          <Pop icon="borders" title={t.docx.cellBorders} chevron>
            {(close) => (
              <div className="de-borders-pop">
                <div className="de-borders" role="group" aria-label={t.docx.cellBorders}>
                  {CELL_BORDERS.map((x) => (
                    <button key={x.k} type="button" className="de-tb" title={t.format.borders[x.k]} aria-label={t.format.borders[x.k]} onClick={() => (close(), editor.setCellBorders(x.k, `${bLine} ${bColor}`))}>
                      <Icon name={x.icon} />
                    </button>
                  ))}
                </div>
                <div className="de-borders-side">
                  <ColorBtn icon="color" title={t.format.borderColor} value={bColor} onPick={(c) => setBColor(c ?? '#000000')} noneLabel={t.format.black} />
                  <Dropdown title={t.format.borderStyle} icon="lineStyle" label={null} menuWidth={150} value={bLine} options={cellLines(t)} onChange={(v) => setBLine(v)} />
                </div>
              </div>
            )}
          </Pop>
          <Dropdown
            title={t.format.vAlign}
            icon={VALIGN.find((x) => x.value === st.cells?.vAlign)?.icon ?? 'vTop'}
            label={null}
            menuWidth={130}
            value={st.cells?.vAlign ?? 'top'}
            options={VALIGN.map((x) => ({ ...x, label: t.format.vAligns[x.value] }))}
            onChange={(v) => editor.setCellVAlign(v as 'top' | 'middle' | 'bottom')}
          />
        </>
      )}
      {st?.img && (
        <>
          <Sep />
          <Btn icon="minus" title={t.docx.smaller} onClick={() => editor.resizeImage(0.8)} />
          <span className="de-tb-hint" style={{ margin: 0 }}>
            {Math.round(st.img.w)}×{Math.round(st.img.h)}pt
          </span>
          <Btn icon="plus" title={t.docx.larger} onClick={() => editor.resizeImage(1.25)} />
          <Btn icon="fit" title={t.docx.fitWidth} onClick={() => editor.resizeImage('fit')} />
          <Btn icon="imgOrig" title={t.docx.originalSize} onClick={image.original} />
          <Btn icon="imgReplace" title={t.docx.replaceImage} onClick={image.replace} />
          <Btn icon="alt" title={t.edit.altText} active={!!st.img.alt} onClick={image.alt} />
          {image.download && <Btn icon="save" title={t.docx.downloadImage} onClick={image.download} />}
          <Btn icon="trash" title={t.docx.deleteImage} onClick={() => editor.deleteSelection()} />
        </>
      )}
      <Sep />
      <Select
        title={t.docx.style}
        width={118}
        menuWidth={250}
        disabled={dis}
        value={styleValue}
        placeholder={t.docx.stylePlaceholder}
        options={styleOpts}
        onChange={(v) => (v.startsWith('@') ? void editor.applyCanon(v.slice(1) as CanonStyle) : editor.setPara({ style: v }))}
      />
      <Sep />
      <Select title={t.edit.font} width={118} menuWidth={200} disabled={dis} value={font} placeholder={t.edit.font} options={fontOptions(font)} onChange={(v) => editor.setFont(v)} />
      <Sep />
      <SizeBox value={sz} disabled={dis} onChange={(v) => editor.setSize(v)} />
      <Sep />
      <Btn icon="bold" title={kb(t.edit.bold, `${MOD}B`)} active={st?.b} disabled={dis} onClick={() => editor.toggle('b')} />
      <Btn icon="italic" title={kb(t.edit.italic, `${MOD}I`)} active={st?.i} disabled={dis} onClick={() => editor.toggle('i')} />
      <Btn icon="underline" title={kb(t.edit.underline, `${MOD}U`)} active={st?.u} disabled={dis} onClick={() => editor.toggle('u')} />
      <Btn icon="strike" title={t.edit.strike} active={st?.strike} disabled={dis} onClick={() => editor.toggle('strike')} />
      <ColorBtn icon="color" title={t.edit.textColor} value={st?.color} onPick={(c) => editor.setColor(c)} noneLabel={t.edit.automatic} />
      <ColorBtn icon="highlight" title={t.edit.highlight} value={st?.hl} palette={HIGHLIGHTS} onPick={(c) => editor.setHighlight(c)} />
      <Sep />
      <Btn icon="link" title={kb(t.edit.link, `${MOD}K`)} active={!!st?.link} disabled={dis} onClick={props.onLink} />
      <Btn icon="image" title={t.edit.image} disabled={dis} onClick={() => void pickFiles().then((f) => void (f.length && editor.insertImages(f)))} />
      <Pop icon="table" title={t.table.insert} disabled={dis || st?.inTable}>
        {(close) => <GridPicker onPick={(r, c) => (close(), editor.insertTable(r, c))} />}
      </Pop>
      <Btn icon="pageSetup" title={t.docx.pageSetup} disabled={!props.onPageSetup} onClick={() => props.onPageSetup?.()} />
      <Btn icon="track" title={t.docx.track} active={!!st?.tracking} disabled={dis} onClick={() => editor.setTracking(!editor.tracking)} />
      <Menu
        title={t.docx.reviewTitle}
        label={t.docx.review}
        icon="review"
        items={[
          { value: 'next', label: t.docx.nextChange, icon: 'down' },
          { value: 'prev', label: t.docx.prevChange, icon: 'up' },
          { value: 'accept', label: t.docx.accept, icon: 'check', sep: true, disabled: !st?.inChange },
          { value: 'reject', label: t.docx.reject, icon: 'close', disabled: !st?.inChange },
          { value: 'acceptAll', label: t.docx.acceptAll, icon: 'check', sep: true },
          { value: 'rejectAll', label: t.docx.rejectAll, icon: 'close' },
        ]}
        onPick={(v) => {
          if (v === 'next' || v === 'prev') {
            if (!editor.gotoChange(v === 'next' ? 1 : -1)) props.onNotice?.(v === 'next' ? t.docx.noMoreAfter : t.docx.noneBefore)
            return
          }
          const n = editor.review(v.startsWith('accept'), v.endsWith('All'))
          props.onNotice?.(n ? (v.startsWith('accept') ? t.docx.accepted(n) : t.docx.rejected(n)) : t.docx.noChanges)
        }}
      />
      <Btn icon="headerFooter" title={t.docx.headerFooter} disabled={!props.onHeaderFooter} onClick={() => props.onHeaderFooter?.()} />
      <Pop icon="omega" title={t.docx.symbols} disabled={dis}>
        {(close) => (
          <div className="de-symbols">
            {SYMBOLS.map((c) => (
              <button key={c} type="button" title={`U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`} onClick={() => (close(), editor.insertText(c))}>
                {c}
              </button>
            ))}
          </div>
        )}
      </Pop>
      <Sep />
      <Btn icon="alignLeft" title={t.edit.alignLeft} active={st?.align === 'left'} disabled={dis} onClick={() => editor.setPara({ align: 'left' }, { align: 'left' })} />
      <Btn icon="alignCenter" title={t.edit.center} active={st?.align === 'center'} disabled={dis} onClick={() => editor.setPara({ align: 'center' }, { align: 'center' })} />
      <Btn icon="alignRight" title={t.edit.alignRight} active={st?.align === 'right'} disabled={dis} onClick={() => editor.setPara({ align: 'right' }, { align: 'right' })} />
      <Btn icon="justify" title={t.edit.justify} active={st?.align === 'justify'} disabled={dis} onClick={() => editor.setPara({ align: 'justify' }, { align: 'justify' })} />
      <Dropdown
        title={t.docx.spacing}
        icon="lineSpacing"
        label={null}
        menuWidth={150}
        disabled={dis}
        value={line}
        options={LINE_SPACING.map((x) => ({ value: x.value, label: x.k ? t.format.spacings[x.k] : formatNumber(t, x.value) }))}
        onChange={(v) => editor.setPara({ line: v }, { line: v, lineRule: 'auto' })}
      />
      <Sep />
      <Btn icon="bullets" title={t.edit.bullets} active={st?.lst === 'bullet'} disabled={dis} onClick={() => editor.toggleList('bullet')} />
      <Btn icon="numbers" title={t.edit.numbers} active={st?.lst === 'number'} disabled={dis} onClick={() => editor.toggleList('number')} />
      <Btn icon="outdent" title={kb(t.edit.indentLess, 'Shift+Tab')} disabled={dis} onClick={() => editor.indent(-1)} />
      <Btn icon="indent" title={kb(t.edit.indentMore, 'Tab')} disabled={dis} onClick={() => editor.indent(1)} />
      <Sep />
      <Btn icon="sup" title={t.edit.sup} active={st?.va === 'sup'} disabled={dis} onClick={() => editor.format({ va: st?.va === 'sup' ? undefined : 'sup' }, { va: st?.va === 'sup' ? null : 'sup' })} />
      <Btn icon="sub" title={t.edit.sub} active={st?.va === 'sub'} disabled={dis} onClick={() => editor.format({ va: st?.va === 'sub' ? undefined : 'sub' }, { va: st?.va === 'sub' ? null : 'sub' })} />
      <Btn icon="pagebreak" title={kb(t.docx.pageBreak, `${MOD}Enter`)} disabled={dis || st?.inTable} onClick={() => editor.insertPageBreak()} />
      <Btn icon="clear" title={kb(t.edit.clearFormat, `${MOD}\\`)} disabled={dis} onClick={() => editor.clearFormat()} />
      <Sep />
      {props.onOutline && <Btn icon="outline" title={t.docx.outline} active={props.outline} onClick={props.onOutline} />}
      <Btn icon="search" title={kb(t.edit.findReplace, `${MOD}F`)} onClick={props.onFind} />
    </EditorBar>
  )
}
