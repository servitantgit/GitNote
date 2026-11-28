import { memo, useMemo, useRef, type KeyboardEvent } from 'react'
import { HIGHLIGHT_MAX, highlightLines, LANGUAGE_NAME, languageOf, type Token } from '../../core/syntax'
import { Icon } from '../edit/Toolbar'
import { useStrings } from '../strings'

export interface SourceEditorProps {
  text: string
  /** the language it is colored in ("markdown", "html", "typescript"…; an unknown one: plain) */
  language: string
  /** what the header calls it (default: the language's name) */
  label?: string
  onChange: (text: string) => void
  readOnly?: boolean
  /** a line under the header (e.g. what editing the source does) */
  notice?: string
  onCopy?: () => void
  onDownload?: () => void
  /** the whole view is the source (a source file), not a pane beside the document */
  full?: boolean
}

/** one colored line; a line whose tokens did not change is not drawn again (unchanged lines get the same tokens back) */
const Line = memo(function Line({ toks }: { toks: Token[] }) {
  return (
    <>
      {toks.map(([c, t], k) => (c ? <span key={k} className={`de-tk-${c}`}>{t}</span> : t))}
      {'\n'}
    </>
  )
})

/**
 * The text of a Markdown / HTML / SVG / diagram / source file, editable, with line numbers and syntax colors: a
 * transparent textarea over the colored text, both sized by their content in one grid cell (they scroll together).
 * The colors are only drawn: the text is the textarea's, as typed.
 */
export function SourceEditor({ text, language, label, onChange, readOnly, notice, onCopy, onDownload, full }: SourceEditorProps) {
  const t = useStrings()
  const id = languageOf(language)
  const name = label ?? (id && id !== 'text' ? LANGUAGE_NAME[id] : undefined) ?? t.source.source
  // past the limit, or in no known language: the text as it is, in one piece
  const colored = !!id && id !== 'text' && text.length <= HIGHLIGHT_MAX
  const lines = useMemo(() => (colored ? highlightLines(id, text) : null), [colored, id, text])
  const count = useMemo(() => {
    let n = 1
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++
    return n
  }, [text])
  const gutter = useMemo(() => Array.from({ length: count }, (_, k) => k + 1).join('\n'), [count])
  // Escape, then Tab: leave the editor (Tab alone indents)
  const leaving = useRef(false)
  const insert = (el: HTMLTextAreaElement, s: string) => {
    // execCommand keeps the native undo history; setRangeText where it is gone
    if (!el.ownerDocument.execCommand?.('insertText', false, s)) {
      el.setRangeText(s, el.selectionStart, el.selectionEnd, 'end')
      onChange(el.value)
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    if (e.key === 'Escape') {
      leaving.current = true
      return
    }
    const wasLeaving = leaving.current
    leaving.current = false
    if (readOnly || e.altKey || e.metaKey || e.ctrlKey || e.nativeEvent.isComposing) return
    if (e.key === 'Tab' && !e.shiftKey && !wasLeaving) {
      e.preventDefault()
      insert(el, '  ')
    } else if (e.key === 'Enter' && !e.shiftKey) {
      // keep the indentation of the line
      const start = el.value.lastIndexOf('\n', el.selectionStart - 1) + 1
      const indent = /^[ \t]*/.exec(el.value.slice(start, el.selectionStart))![0]
      if (!indent) return
      e.preventDefault()
      insert(el, '\n' + indent)
    }
  }
  return (
    <div className={full ? 'de-src de-src-full' : 'de-src'} data-testid={full ? 'de-code' : 'de-source'} data-language={id ?? ''}>
      <div className="de-src-head">
        <span className="de-src-title">
          <Icon name="code" size={15} />
          {name}
        </span>
        <span className="de-src-lines">
          {t.source.lines(count, t.locale)}
        </span>
        <span style={{ flex: 1 }} />
        {onCopy && (
          <button type="button" className="de-src-btn" onClick={onCopy} title={t.source.copy}>
            <Icon name="copy" size={15} />
          </button>
        )}
        {onDownload && (
          <button type="button" className="de-src-btn" onClick={onDownload} title={t.source.download}>
            <Icon name="save" size={15} />
          </button>
        )}
      </div>
      {notice && <div className="de-src-notice">{notice}</div>}
      <div className="de-src-scroll">
        <pre className="de-src-gutter" aria-hidden="true">
          {gutter}
        </pre>
        <div className="de-src-code">
          <pre className="de-src-hl" aria-hidden="true">
            {lines ? lines.map((toks, k) => <Line key={k} toks={toks} />) : text + '\n'}
          </pre>
          <textarea
            className="de-src-input"
            value={text}
            readOnly={readOnly}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            wrap="off"
            rows={1}
            cols={1}
            aria-label={t.source.input(name)}
            data-testid="de-source-input"
          />
        </div>
      </div>
    </div>
  )
}
