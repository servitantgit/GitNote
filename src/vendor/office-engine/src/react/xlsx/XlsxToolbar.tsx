import { useRef, useState } from 'react'
import { cellFormat } from '../edit/format'
import type { BorderKind, FmtPatch } from '../../core/xlsx/types'
import { MOD } from '../common/ContextMenu'
import { EditorBar } from '../common/Slots'
import { Btn, ColorBtn, Dropdown, fontOptions, Icon, Menu, Pop, PromptBox, Select, Sep, SizeBox, useDismiss, type DropOption, type IconName } from '../edit/Toolbar'
import { useStrings, type Strings } from '../strings'

type FormatName = keyof Strings['xlsx']['formats']
/** number formats offered; the hints show them on a sample value */
const FORMATS: { value: string; k: FormatName; hint: string; sep?: boolean }[] = [
  { value: 'General', k: 'automatic', hint: '1000.12' },
  { value: '@', k: 'text', hint: 'abc' },
  { value: '0', k: 'number', hint: '1000', sep: true },
  { value: '0.00', k: 'number', hint: '1000.12' },
  { value: '#,##0', k: 'number', hint: '1,000' },
  { value: '#,##0.00', k: 'number', hint: '1,000.12' },
  { value: '0.00E+00', k: 'scientific', hint: '1.01E+03' },
  { value: '0%', k: 'percent', hint: '10%', sep: true },
  { value: '0.00%', k: 'percent', hint: '10.12%' },
  { value: '"$"#,##0.00', k: 'currency', hint: '$1,000.12', sep: true },
  { value: '"$"#,##0', k: 'currencyRounded', hint: '$1,000' },
  { value: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)', k: 'accounting', hint: '$ (1,000.12)' },
  { value: '#,##0 "₫"', k: 'currency', hint: '1,000 ₫' },
  { value: '# ?/?', k: 'fraction', hint: '1000 1/8' },
  { value: 'yyyy-mm-dd', k: 'date', hint: '2026-09-26', sep: true },
  { value: 'dd/mm/yyyy', k: 'date', hint: '26/09/2026' },
  { value: 'd mmmm yyyy', k: 'longDate', hint: '26 September 2026' },
  { value: 'h:mm', k: 'time', hint: '15:59' },
  { value: 'h:mm:ss AM/PM', k: 'time', hint: '3:59:00 PM' },
  { value: 'yyyy-mm-dd h:mm', k: 'dateTime', hint: '2026-09-26 15:59' },
  { value: '[h]:mm:ss', k: 'duration', hint: '24:01:00' },
]
const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48]
const BORDERS: { k: BorderKind; icon: IconName }[] = [
  { k: 'all', icon: 'bAll' },
  { k: 'inner', icon: 'bInner' },
  { k: 'outer', icon: 'bOuter' },
  { k: 'none', icon: 'bNone' },
  { k: 'top', icon: 'bTop' },
  { k: 'bottom', icon: 'bBottom' },
  { k: 'left', icon: 'bLeft' },
  { k: 'right', icon: 'bRight' },
]
const BORDER_STYLES = [
  { value: 'thin', hint: '───' },
  { value: 'medium', hint: '━━━' },
  { value: 'thick', hint: '▬▬▬' },
  { value: 'dashed', hint: '- - -' },
  { value: 'dotted', hint: '·····' },
  { value: 'double', hint: '═══' },
] as const
const HALIGN = [
  { value: 'left', icon: 'alignLeft' },
  { value: 'center', icon: 'alignCenter' },
  { value: 'right', icon: 'alignRight' },
] as const
const VALIGN = [
  { value: 'top', k: 'top', icon: 'vTop' },
  { value: 'center', k: 'middle', icon: 'vMiddle' },
  { value: 'bottom', k: 'bottom', icon: 'vBottom' },
] as const
const ROTATE = [
  { value: 0, k: 'none', icon: 'rotNone' },
  { value: 45, k: 'tiltUp', icon: 'rotUp' },
  { value: -45, k: 'tiltDown', icon: 'rotDown' },
  { value: 255, k: 'stack', icon: 'rotStack' },
  { value: 90, k: 'up', icon: 'rotUp90' },
  { value: -90, k: 'down', icon: 'rotDown90' },
] as const
const FUNCS = ['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN']

export type MergeMode = 'all' | 'across' | 'down' | 'unmerge'

/** number format with one decimal place more / less (Google Sheets .0 / .00 buttons) */
function decimals(fmt: string, d: number): string {
  const base = fmt === 'General' || fmt === '@' ? '0' : fmt
  const m = /0(\.0*)?/.exec(base)
  if (!m) return d > 0 ? '0.0' : '0'
  const n = Math.max(0, (m[1] ? m[1].length - 1 : 0) + d)
  return base.slice(0, m.index) + '0' + (n ? '.' + '0'.repeat(n) : '') + base.slice(m.index + m[0].length)
}

const CUSTOM = '\u0000custom'

/** the number formats, the one of the cell first when it is none of them, and a field for a format code typed by hand */
function NumberFormat({ format, onPick }: { format: string; onPick: (code: string) => void }) {
  const [typing, setTyping] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useDismiss(ref, typing, () => setTyping(false))
  const t = useStrings()
  const known = FORMATS.find((x) => x.value === format)
  const options: DropOption<string>[] = [
    ...(known ? [] : [{ value: format, label: t.xlsx.formats.custom, hint: format }]),
    ...FORMATS.map(({ k, ...x }) => ({ ...x, label: t.xlsx.formats[k] })),
    { value: CUSTOM, label: t.xlsx.customFormat, sep: true },
  ]
  return (
    <span ref={ref} className="de-tb-color">
      <Select title={t.xlsx.numberFormat(t.xlsx.formats[known?.k ?? 'custom'])} width={96} menuWidth={270} value={format} options={options} onChange={(v) => (v === CUSTOM ? setTyping(true) : onPick(v))} />
      {typing && (
        <div className="de-tb-pop" role="dialog" aria-label={t.xlsx.customFormatTitle} onKeyDown={(e) => e.key === 'Escape' && setTyping(false)}>
          <PromptBox
            placeholder={t.xlsx.formatCode}
            initial={format === 'General' ? '' : format}
            ok={t.common.apply}
            onOk={(v) => {
              setTyping(false)
              // (a format code holds 255 characters at most)
              onPick(v.trim().slice(0, 255) || 'General')
            }}
          />
        </div>
      )}
    </span>
  )
}

export function XlsxToolbar(props: {
  css: Record<string, string | number>
  /** workbook default font (cells without an explicit font) */
  base: { fontFamily?: string; fontSize?: string | number }
  format: string
  merged: boolean
  frozen: boolean
  gridlines: boolean
  painter: boolean
  onToggle: (k: 'b' | 'i' | 'u' | 'strike') => void
  onFormat: (p: FmtPatch) => void
  /** there is an edit to undo / to redo (the list of sheets changing forgets them) */
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onPaint: () => void
  onMerge: (mode: MergeMode) => void
  onFreeze: (k: 'none' | 'row' | 'col' | 'sel') => void
  onGridlines: () => void
  onFunc: (fn: string | null) => void
  onSort: (desc: boolean) => void
  onRows: (k: 'rowAbove' | 'rowBelow' | 'colLeft' | 'colRight' | 'delRow' | 'delCol' | 'hideRows' | 'hideCols' | 'unhideRows' | 'unhideCols') => void
  onFind: () => void
}) {
  const { css, onFormat: f } = props
  const [bColor, setBColor] = useState('#000000')
  const [bStyle, setBStyle] = useState<(typeof BORDER_STYLES)[number]['value']>('thin')
  const look = cellFormat(css, props.base)
  const align = look.align ?? ''
  const valign = css.alignItems === 'flex-start' ? 'top' : css.alignItems === 'center' ? 'center' : 'bottom'
  const rot = Number(css.textRotate ?? 0)
  const sz = look.size
  const font = look.font ?? ''
  const t = useStrings()
  const kb = (label: string, keys: string) => t.edit.keyed(label, keys)
  const borderTitle = (k: BorderKind) => (k === 'none' ? t.xlsx.clearBorders : t.format.borders[k])
  return (
    <EditorBar>
      <Btn icon="undo" title={kb(t.edit.undo, `${MOD}Z`)} disabled={!props.canUndo} onClick={props.onUndo} />
      <Btn icon="redo" title={kb(t.edit.redo, `${MOD}Y`)} disabled={!props.canRedo} onClick={props.onRedo} />
      <Btn icon="paint" title={t.xlsx.paint} active={props.painter} onClick={props.onPaint} />
      <Sep />
      <Btn icon="currency" title={t.xlsx.currency} onClick={() => f({ numFmt: '"$"#,##0.00' })} />
      <Btn icon="percent" title={t.xlsx.percent} onClick={() => f({ numFmt: '0%' })} />
      <Btn icon="decLess" title={t.xlsx.decLess} onClick={() => f({ numFmt: decimals(props.format, -1) })} />
      <Btn icon="decMore" title={t.xlsx.decMore} onClick={() => f({ numFmt: decimals(props.format, 1) })} />
      <NumberFormat format={props.format} onPick={(v) => f({ numFmt: v })} />
      <Sep />
      <Select title={t.edit.font} width={112} menuWidth={200} value={font} placeholder={t.edit.font} options={fontOptions(font)} onChange={(v) => f({ font: v })} />
      <Sep />
      <SizeBox value={sz} sizes={SIZES} onChange={(v) => f({ sz: v })} />
      <Sep />
      <Btn icon="bold" title={kb(t.edit.bold, `${MOD}B`)} active={look.bold} onClick={() => props.onToggle('b')} />
      <Btn icon="italic" title={kb(t.edit.italic, `${MOD}I`)} active={look.italic} onClick={() => props.onToggle('i')} />
      <Btn icon="underline" title={kb(t.edit.underline, `${MOD}U`)} active={look.underline} onClick={() => props.onToggle('u')} />
      <Btn icon="strike" title={kb(t.edit.strike, `${MOD}⇧X`)} active={look.strike} onClick={() => props.onToggle('strike')} />
      <ColorBtn icon="color" title={t.edit.textColor} value={look.color} onPick={(c) => f({ color: c })} noneLabel={t.edit.automatic} />
      <Sep />
      <ColorBtn icon="fill" title={t.xlsx.fillColor} value={look.highlight} onPick={(c) => f({ fill: c })} noneLabel={t.format.noFill} />
      <Pop icon="borders" title={t.xlsx.borders} chevron>
        {(close) => (
          <div className="de-borders-pop">
            <div className="de-borders" role="group" aria-label={t.xlsx.borders}>
              {BORDERS.map((x) => (
                <button
                  key={x.k}
                  type="button"
                  className="de-tb"
                  title={borderTitle(x.k)}
                  aria-label={borderTitle(x.k)}
                  onClick={() => {
                    close()
                    f({ border: x.k, borderColor: bColor, borderStyle: bStyle })
                  }}
                >
                  <Icon name={x.icon} />
                </button>
              ))}
            </div>
            <div className="de-borders-side">
              <ColorBtn icon="color" title={t.format.borderColor} value={bColor} onPick={(c) => setBColor(c ?? '#000000')} noneLabel={t.format.black} />
              <Dropdown title={t.format.borderStyle} icon="lineStyle" label={null} menuWidth={150} value={bStyle} options={BORDER_STYLES.map((x) => ({ ...x, label: t.format.lines[x.value] }))} onChange={(v) => setBStyle(v)} />
            </div>
          </div>
        )}
      </Pop>
      <Dropdown
        title={t.xlsx.merge}
        icon="merge"
        label={null}
        menuWidth={190}
        options={[
          { value: 'all', label: t.xlsx.mergeAll },
          { value: 'across', label: t.xlsx.mergeAcross },
          { value: 'down', label: t.xlsx.mergeDown },
          { value: 'unmerge', label: t.xlsx.unmerge, disabled: !props.merged, sep: true },
        ]}
        onChange={(v) => props.onMerge(v as MergeMode)}
      />
      <Sep />
      <Dropdown
        title={t.xlsx.hAlign}
        icon={HALIGN.find((x) => x.value === align)?.icon ?? 'alignLeft'}
        label={null}
        menuWidth={140}
        value={align}
        options={HALIGN.map((x) => ({ ...x, label: t.xlsx.hAligns[x.value] }))}
        onChange={(v) => f({ align: v === align ? null : (v as 'left') })}
      />
      <Dropdown title={t.format.vAlign} icon={VALIGN.find((x) => x.value === valign)!.icon} label={null} menuWidth={140} value={valign} options={VALIGN.map(({ k, ...x }) => ({ ...x, label: t.format.vAligns[k] }))} onChange={(v) => f({ valign: v })} />
      <Btn icon="wrap" title={t.xlsx.wrap} active={css.whiteSpace === 'pre-wrap'} onClick={() => f({ wrap: css.whiteSpace !== 'pre-wrap' })} />
      <Dropdown title={t.xlsx.rotation} icon={ROTATE.find((x) => x.value === rot)?.icon ?? 'rotNone'} label={null} menuWidth={180} value={rot} options={ROTATE.map(({ k, ...x }) => ({ ...x, value: x.value as number, label: t.xlsx.rotations[k] }))} onChange={(v) => f({ rotate: v || null })} />
      <Sep />
      <Menu
        title={t.xlsx.rowsMenuTitle}
        label={t.xlsx.rowsMenu}
        icon="rowAdd"
        items={[
          { value: 'rowAbove', label: t.table.rowAbove, icon: 'rowAbove' },
          { value: 'rowBelow', label: t.table.rowBelow, icon: 'rowBelow' },
          { value: 'colLeft', label: t.table.colLeft, icon: 'colLeft' },
          { value: 'colRight', label: t.table.colRight, icon: 'colRight' },
          { value: 'delRow', label: t.xlsx.delRows, icon: 'delRow', sep: true },
          { value: 'delCol', label: t.xlsx.delCols, icon: 'delCol' },
          { value: 'hideRows', label: t.xlsx.hideRows, icon: 'hide', sep: true },
          { value: 'hideCols', label: t.xlsx.hideCols, icon: 'hide' },
          { value: 'unhideRows', label: t.xlsx.unhideRows, icon: 'view' },
          { value: 'unhideCols', label: t.xlsx.unhideCols, icon: 'view' },
        ]}
        onPick={(v) => props.onRows(v as 'rowAbove')}
      />
      <Dropdown
        title={t.xlsx.functions}
        icon="sum"
        label={null}
        menuWidth={170}
        options={[...FUNCS.map((x) => ({ value: x, label: x })), { value: '', label: t.xlsx.moreFunctions, sep: true }]}
        onChange={(v) => props.onFunc(v || null)}
      />
      <Dropdown
        title={t.xlsx.sort}
        icon="sort"
        label={null}
        menuWidth={200}
        options={[
          { value: 'asc', label: t.xlsx.sortAsc, icon: 'sortAZ' },
          { value: 'desc', label: t.xlsx.sortDesc, icon: 'sortZA' },
        ]}
        onChange={(v) => props.onSort(v === 'desc')}
      />
      <Menu
        title={t.xlsx.viewMenuTitle}
        label={t.xlsx.viewMenu}
        icon="freeze"
        items={[
          { value: 'row', label: t.xlsx.freezeRow },
          { value: 'col', label: t.xlsx.freezeCol },
          { value: 'sel', label: t.xlsx.freezeSel },
          { value: 'none', label: t.xlsx.unfreeze, disabled: !props.frozen },
          { value: 'grid', label: props.gridlines ? t.xlsx.hideGridlines : t.xlsx.showGridlines, icon: 'gridlines', sep: true },
        ]}
        onPick={(v) => (v === 'grid' ? props.onGridlines() : props.onFreeze(v as 'row'))}
      />
      <Sep />
      <Btn icon="clear" title={kb(t.edit.clearFormat, `${MOD}\\`)} onClick={() => f({ clear: true })} />
      <Btn icon="search" title={kb(t.edit.findReplace, `${MOD}F`)} onClick={props.onFind} />
    </EditorBar>
  )
}
