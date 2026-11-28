import { HIGHLIGHT_MAX, highlightLines, LANGUAGE_NAME, languageOf } from '../../core/syntax'
import { useFileOps } from '../common/Slots'
import { mdFence } from '../file/text'
import { formatCount, useStrings } from '../strings'
import { SourceEditor, type SourceEditorProps } from './SourceEditor'

export type CodeViewProps = Omit<SourceEditorProps, 'full'>

/**
 * A source file (main.ts, script.py, config.json…): its text with line numbers and colors, edited when the viewer
 * edits. What is printed, exported and saved is the text: the colors are only drawn.
 */
export function CodeView(props: CodeViewProps) {
  const { text, language } = props
  const strings = useStrings()
  const id = languageOf(language)
  useFileOps({
    printable: async () => {
      const lines = id && id !== 'text' && text.length <= HIGHLIGHT_MAX ? highlightLines(id, text) : null
      return {
        size: 'auto',
        margin: '1.5cm',
        node: (
          <pre className="de-code de-code-print">
            {lines
              ? lines.map((toks, k) => (
                  <span key={k}>
                    {toks.map(([c, t], j) => (c ? <span key={j} className={`de-tk-${c}`}>{t}</span> : t))}
                    {'\n'}
                  </span>
                ))
              : text}
          </pre>
        ),
      }
    },
    text: async (format) => (format === 'md' ? mdFence(language, text.replace(/\r\n?/g, '\n')) + '\n' : text),
    stats: () => {
      let n = 1
      for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++
      return [
        [strings.source.language, id === 'text' ? strings.imported.text : (id && LANGUAGE_NAME[id]) || language || strings.imported.text],
        [strings.source.lineCount, formatCount(strings, n)],
        [strings.source.characterCount, formatCount(strings, text.length)],
      ]
    },
  })
  return <SourceEditor {...props} full />
}
