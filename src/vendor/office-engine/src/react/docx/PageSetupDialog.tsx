import { useEffect, useRef, useState } from 'react'
import type { PageSet, PageSetup } from '../../core/docx/types'
import { formatNumber, useStrings, type Strings } from '../strings'
import { numberText, parseNumber } from '../../core/number-input'
import { useLocale } from '../common/locale'

/** paper sizes in pt (portrait) */
export const PAPERS: { k: keyof Strings['pageSetup']['papers']; w: number; h: number }[] = [
  { k: 'a4', w: 595.3, h: 841.9 },
  { k: 'letter', w: 612, h: 792 },
  { k: 'legal', w: 612, h: 1008 },
  { k: 'a3', w: 841.9, h: 1190.6 },
  { k: 'a5', w: 419.5, h: 595.3 },
  { k: 'b5', w: 498.9, h: 708.7 },
]

const CM = 72 / 2.54
const toCm = (pt: number) => +(pt / CM).toFixed(2)
const toPt = (cm: number) => +(cm * CM).toFixed(2)
const near = (a: number, b: number) => Math.abs(a - b) < 2

/** the paper of a page (either way round), or 'custom' */
export function paperOf(page: { w: number; h: number }): string {
  const lo = Math.min(page.w, page.h)
  const hi = Math.max(page.w, page.h)
  return PAPERS.find((p) => near(p.w, lo) && near(p.h, hi))?.k ?? 'custom'
}

const MARGIN_PRESETS: { k: keyof Strings['pageSetup']['marginPresets']; cm: [number, number, number, number] }[] = [
  { k: 'normal', cm: [2.54, 2.54, 2.54, 2.54] },
  { k: 'narrow', cm: [1.27, 1.27, 1.27, 1.27] },
  { k: 'moderate', cm: [2.54, 1.91, 2.54, 1.91] },
  { k: 'wide', cm: [2.54, 5.08, 2.54, 5.08] },
  { k: 'vietnam', cm: [2, 1.5, 2, 3] },
]

/**
 * Page setup for the whole document: paper, orientation, margins (cm), text columns.
 * `onOk` gets only what changed.
 */
export function PageSetupDialog({ page, onOk, onClose }: { page: PageSetup; onOk: (set: PageSet) => void; onClose: () => void }) {
  const t = useStrings()
  // Numbers are typed in the viewer's locale (2,54 in de-DE) and read whole: one that is not a number (empty, 2,5 where
  // the decimal separator is a point) is refused as one out of bounds is. Without a locale the fields are the
  // browser's number fields, as they were.
  const locale = useLocale()
  const text = (cm: number) => numberText(cm, locale)
  const [paper, setPaper] = useState(paperOf(page))
  const [land, setLand] = useState(page.w > page.h)
  // margins as typed (cm): top, right, bottom, left
  const [mar, setMar] = useState([page.mt, page.mr, page.mb, page.ml].map((v) => text(toCm(v))))
  const [cols, setCols] = useState(page.cols ?? 1)
  const [gap, setGap] = useState(text(toCm(page.colGap ?? 36)))
  const first = useRef<HTMLSelectElement>(null)
  useEffect(() => first.current?.focus(), [])

  const num = (v: string) => parseNumber(v, locale) ?? NaN
  const nums = mar.map(num)
  const gapN = num(gap)
  const size = (() => {
    const p = PAPERS.find((x) => x.k === paper)
    const lo = p ? p.w : Math.min(page.w, page.h)
    const hi = p ? p.h : Math.max(page.w, page.h)
    return land ? { w: hi, h: lo } : { w: lo, h: hi }
  })()
  const bad =
    nums.some((v) => !Number.isFinite(v) || v < 0 || v > 15) ||
    toPt(nums[1] + nums[3]) > size.w - 72 ||
    toPt(nums[0] + nums[2]) > size.h - 72 ||
    !Number.isFinite(gapN) ||
    gapN < 0 ||
    gapN > 10

  const submit = () => {
    if (bad) return
    const set: PageSet = {}
    if (!near(size.w, page.w) || !near(size.h, page.h)) Object.assign(set, { w: size.w, h: size.h })
    const keys = ['mt', 'mr', 'mb', 'ml'] as const
    keys.forEach((k, i) => {
      const v = toPt(nums[i])
      if (Math.abs(v - page[k]) > 0.3) set[k] = v
    })
    if (cols !== (page.cols ?? 1)) set.cols = cols
    if (cols > 1 && Math.abs(toPt(gapN) - (page.colGap ?? 36)) > 0.3) set.colGap = toPt(gapN)
    onClose()
    if (Object.keys(set).length) onOk(set)
  }

  const field = (i: number, label: string) => (
    <label className="de-ps-field">
      <span>{label}</span>
      <input
        type={locale ? 'text' : 'number'}
        inputMode="decimal"
        step="any"
        min="0"
        aria-label={t.pageSetup.marginLabel(label)}
        value={mar[i]}
        onChange={(e) => setMar((m) => m.map((x, k) => (k === i ? e.target.value : x)))}
      />
      <em>cm</em>
    </label>
  )

  return (
    <div
      className="de-dialog-back"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <form
        className="de-dialog de-ps"
        role="dialog"
        noValidate
        aria-label={t.pageSetup.title}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="de-dialog-title">{t.pageSetup.title}</div>
        <div className="de-ps-note">{t.pageSetup.note}</div>

        <div className="de-ps-row">
          <label className="de-ps-field de-ps-wide">
            <span>{t.pageSetup.paper}</span>
            <select ref={first} aria-label={t.pageSetup.paper} value={paper} onChange={(e) => setPaper(e.target.value)}>
              {PAPERS.map((p) => (
                <option key={p.k} value={p.k}>
                  {t.pageSetup.papers[p.k]}
                </option>
              ))}
              {paper === 'custom' && <option value="custom">{t.pageSetup.custom(formatNumber(t, toCm(page.w)), formatNumber(t, toCm(page.h)))}</option>}
            </select>
          </label>
        </div>

        <div className="de-ps-row" role="radiogroup" aria-label={t.pageSetup.orientation}>
          <span className="de-ps-head">{t.pageSetup.orientation}</span>
          <label className="de-ps-radio">
            <input type="radio" name="de-ps-orient" checked={!land} onChange={() => setLand(false)} /> {t.pageSetup.portrait}
          </label>
          <label className="de-ps-radio">
            <input type="radio" name="de-ps-orient" checked={land} onChange={() => setLand(true)} /> {t.pageSetup.landscape}
          </label>
        </div>

        <div className="de-ps-head">
          {t.pageSetup.margins}
          <select
            className="de-ps-preset"
            aria-label={t.pageSetup.marginPreset}
            value=""
            onChange={(e) => {
              const p = MARGIN_PRESETS[Number(e.target.value)]
              if (p) setMar(p.cm.map(text))
            }}
          >
            <option value="">{t.pageSetup.presets}</option>
            {MARGIN_PRESETS.map((p, i) => (
              <option key={p.k} value={i}>
                {t.pageSetup.marginPresets[p.k]}
              </option>
            ))}
          </select>
        </div>
        <div className="de-ps-grid">
          {field(0, t.pageSetup.top)}
          {field(2, t.pageSetup.bottom)}
          {field(3, t.pageSetup.left)}
          {field(1, t.pageSetup.right)}
        </div>

        <div className="de-ps-row">
          <span className="de-ps-head">{t.pageSetup.columns}</span>
          {[1, 2, 3].map((n) => (
            <label key={n} className="de-ps-radio">
              <input type="radio" name="de-ps-cols" checked={cols === n} onChange={() => setCols(n)} /> {n}
            </label>
          ))}
          {cols > 1 && (
            <label className="de-ps-field">
              <span>{t.pageSetup.spacing}</span>
              <input type={locale ? 'text' : 'number'} inputMode="decimal" step="any" min="0" aria-label={t.pageSetup.spacingLabel} value={gap} onChange={(e) => setGap(e.target.value)} />
              <em>cm</em>
            </label>
          )}
        </div>

        {bad && <div className="de-dialog-note de-ps-bad">{t.pageSetup.noRoom}</div>}
        <div className="de-dialog-btns">
          <button type="button" className="de-btn" onClick={onClose}>
            {t.common.cancel}
          </button>
          <button type="submit" className="de-btn de-btn-primary" disabled={bad}>
            {t.common.apply}
          </button>
        </div>
      </form>
    </div>
  )
}
