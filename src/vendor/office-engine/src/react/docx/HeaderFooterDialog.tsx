import { useEffect, useRef, useState } from 'react'
import type { Block, DocxMeta, HFKind, HFLine, HFSet } from '../../core/docx/types'
import { useStrings, type Strings } from '../strings'
import { numberText, parseNumber } from '../../core/number-input'
import { useLocale } from '../common/locale'

const KINDS: { k: HFKind }[] = [{ k: 'header' }, { k: 'footer' }, { k: 'firstHeader' }, { k: 'firstFooter' }]

/** quick page numbers: where, and how (the "Page 1 of 5" text in the UI's language) */
const numbers = (t: Strings): { label: string; k: HFKind; line: HFLine }[] => [
  { label: t.headerFooter.bottomCenter, k: 'footer', line: { text: '{PAGE}', align: 'center' } },
  { label: t.headerFooter.bottomRight, k: 'footer', line: { text: '{PAGE}', align: 'right' } },
  { label: t.headerFooter.bottomPageOf, k: 'footer', line: { text: t.headerFooter.pageOfText, align: 'center' } },
  // Vietnamese documents: "Trang" is "Page"
  { label: t.headerFooter.bottomVietnamese, k: 'footer', line: { text: 'Trang {PAGE}/{NUMPAGES}', align: 'center' } },
  { label: t.headerFooter.topRight, k: 'header', line: { text: '{PAGE}', align: 'right' } },
]

interface Part {
  text: string
  align: 'left' | 'center' | 'right'
  b: boolean
  sz: string
  /** holds pictures, tables or shapes the dialog can't show: saving replaces them */
  rich: boolean
}

/** the editable form of a header / footer as converted for display; its size as typed in `locale` */
export function partOf(blocks: Block[] | undefined, locale?: string): Part {
  const paras = (blocks ?? []).filter((b) => b.t === 'p')
  const rich = (blocks ?? []).some((b) => b.t !== 'p' || b.runs.some((r) => r.t !== 'text' && r.t !== 'field'))
  const lines = paras.map((p) => (p.t === 'p' ? p.runs.map((r) => (r.t === 'text' ? r.text.replace(/\n/g, ' ') : r.t === 'field' ? `{${r.kind}}` : '')).join('') : ''))
  const p0 = paras.find((p) => p.t === 'p' && p.runs.length) ?? paras[0]
  const runs = p0?.t === 'p' ? p0.runs.filter((r) => r.t === 'text' || r.t === 'field') : []
  const align = p0?.t === 'p' && (p0.ps.align === 'center' || p0.ps.align === 'right') ? p0.ps.align : 'left'
  const first = runs[0] as { s?: { b?: boolean; sz?: number } } | undefined
  // trailing empty lines carry nothing
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return { text: lines.join('\n'), align, b: runs.length > 0 && runs.every((r) => (r as { s?: { b?: boolean } }).s?.b), sz: first?.s?.sz ? numberText(first.s.sz, locale) : '', rich }
}

/** the lines of a part; its size read in `locale` (one that is not a number from 4 up: the size of the text around, as before) */
const linesOf = (p: Part, locale?: string): HFLine[] => {
  const sz = parseNumber(p.sz, locale)
  return p.text.split('\n').length === 1 && !p.text.trim()
    ? []
    : p.text.split('\n').map((text) => ({ text, align: p.align, ...(p.b ? { b: true } : {}), ...(sz !== null && sz >= 4 ? { sz } : {}) }))
}

/**
 * Headers and footers of the document: text (a line per paragraph), alignment, bold, size, page number / page count,
 * a different first page. `onOk` gets only the parts that changed.
 */
export function HeaderFooterDialog({ meta, focus, onOk, onClose }: { meta: DocxMeta; focus?: HFKind; onOk: (set: HFSet) => void; onClose: () => void }) {
  const t = useStrings()
  const NUMBERS = numbers(t)
  const locale = useLocale()
  const init = useRef(Object.fromEntries(KINDS.map(({ k }) => [k, partOf(meta[k], locale)])) as Record<HFKind, Part>)
  const [parts, setParts] = useState(init.current)
  const [first, setFirst] = useState(!!meta.titlePg)
  const [active, setActive] = useState<HFKind>(focus && (first || !focus.startsWith('first')) ? focus : 'header')
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => area.current?.focus(), [active])

  const cur = parts[active]
  const put = (patch: Partial<Part>, k: HFKind = active) => setParts((p) => ({ ...p, [k]: { ...p[k], ...patch } }))
  const insert = (token: string) => {
    const el = area.current
    const at = el ? el.selectionStart : cur.text.length
    const end = el ? el.selectionEnd : at
    put({ text: cur.text.slice(0, at) + token + cur.text.slice(end) })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(at + token.length, at + token.length)
    })
  }

  const submit = () => {
    const set: HFSet = {}
    for (const { k } of KINDS) {
      const a = parts[k]
      const b = init.current[k]
      if (a.text !== b.text || a.align !== b.align || a.b !== b.b || a.sz !== b.sz) (set.parts ??= {})[k] = linesOf(a, locale)
    }
    if (first !== !!meta.titlePg) set.titlePg = first
    onClose()
    if (set.parts || set.titlePg !== undefined) onOk(set)
  }

  const shown = KINDS.filter(({ k }) => first || !k.startsWith('first'))
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
        className="de-dialog de-hfd"
        role="dialog"
        aria-label={t.headerFooter.label}
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="de-dialog-title">{t.headerFooter.title}</div>
        <div className="de-hfd-tabs" role="tablist">
          {shown.map(({ k }) => (
            <button key={k} type="button" role="tab" aria-selected={active === k} className={active === k ? 'on' : undefined} onClick={() => setActive(k)}>
              {t.headerFooter.kinds[k]}
            </button>
          ))}
        </div>
        <textarea
          ref={area}
          rows={3}
          aria-label={t.headerFooter.text(t.headerFooter.kinds[active])}
          placeholder={t.headerFooter.placeholder}
          value={cur.text}
          style={{ textAlign: cur.align, fontWeight: cur.b ? 700 : undefined }}
          onChange={(e) => put({ text: e.target.value })}
        />
        {cur.rich && <div className="de-dialog-note de-ps-bad">{t.headerFooter.rich}</div>}
        <div className="de-ps-row">
          {(['left', 'center', 'right'] as const).map((a) => (
            <label key={a} className="de-ps-radio">
              <input type="radio" name="de-hfd-align" checked={cur.align === a} onChange={() => put({ align: a })} /> {t.headerFooter.aligns[a]}
            </label>
          ))}
          <label className="de-ps-radio">
            <input type="checkbox" checked={cur.b} onChange={(e) => put({ b: e.target.checked })} /> {t.headerFooter.bold}
          </label>
          <label className="de-ps-field">
            <span>{t.headerFooter.size}</span>
            <input type={locale ? 'text' : 'number'} inputMode="decimal" step="any" min="4" aria-label={t.headerFooter.sizeLabel} placeholder={t.headerFooter.sizeAuto} value={cur.sz} onChange={(e) => put({ sz: e.target.value })} />
          </label>
        </div>
        <div className="de-ps-row">
          <button type="button" className="de-btn" onClick={() => insert('{PAGE}')}>
            {t.headerFooter.pageNumber}
          </button>
          <button type="button" className="de-btn" onClick={() => insert('{NUMPAGES}')}>
            {t.headerFooter.pageCount}
          </button>
          <select
            className="de-ps-preset"
            aria-label={t.headerFooter.preset}
            value=""
            onChange={(e) => {
              const n = NUMBERS[Number(e.target.value)]
              if (!n) return
              put({ text: n.line.text, align: n.line.align ?? 'left' }, n.k)
              setActive(n.k)
            }}
          >
            <option value="">{t.headerFooter.presets}</option>
            {NUMBERS.map((n, i) => (
              <option key={n.label} value={i}>
                {n.label}
              </option>
            ))}
          </select>
        </div>
        <label className="de-ps-radio">
          <input
            type="checkbox"
            checked={first}
            onChange={(e) => {
              setFirst(e.target.checked)
              if (!e.target.checked && active.startsWith('first')) setActive(active === 'firstFooter' ? 'footer' : 'header')
            }}
          />{' '}
          {t.headerFooter.firstPage}
        </label>
        <div className="de-dialog-btns">
          <button type="button" className="de-btn" onClick={onClose}>
            {t.common.cancel}
          </button>
          <button type="submit" className="de-btn de-btn-primary">
            {t.common.apply}
          </button>
        </div>
      </form>
    </div>
  )
}
