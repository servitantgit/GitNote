import { useMemo, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { redo, undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  Bold, Italic, Strikethrough, Code2, Link2, Heading1, Heading2,
  List, ListOrdered, Quote, Minus, Undo2, Redo2,
} from 'lucide-react';
import type { EditorMode } from './types';
import { prefixLines, toggleHeading, wrapSelection } from './markdown-commands';
import { livePreviewExtension } from './live-preview';
import './editor.css';

interface Props {
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  content: string;
  onContentChange: (value: string) => void;
}
const modes: { id: EditorMode; label: string }[] = [
  { id: 'source', label: 'Source' },
  { id: 'live-preview', label: 'Live Preview' },
  { id: 'preview', label: 'Preview' },
];

export function EditorWorkspace({ mode, onModeChange, content, onContentChange }: Props) {
  const editorRef = useRef<EditorView | null>(null);
  const extensions = useMemo(() => mode === 'live-preview' ? [markdown(), livePreviewExtension] : [markdown()], [mode]);
  const rendered = DOMPurify.sanitize(marked.parse(content, { gfm: true }) as string);
  const wordCount = content.trim() ? content.trim().split(/\s+/u).length : 0;
  const lineCount = content.length ? content.split('\n').length : 1;

  const applyEdit = (edit: (text: string, from: number, to: number) => { text: string; selection: { from: number; to: number } }) => {
    const view = editorRef.current;
    if (!view || mode === 'preview') return;
    const { from, to } = view.state.selection.main;
    const result = edit(view.state.doc.toString(), from, to);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: result.text },
      selection: { anchor: result.selection.from, head: result.selection.to },
      scrollIntoView: true,
    });
    view.focus();
  };
  const inline = (before: string, after = before, placeholder = 'текст') => {
    applyEdit((text, from, to) => wrapSelection(text, { from, to }, before, after, placeholder));
  };
  const linePrefix = (prefix: string) => applyEdit((text, from, to) => prefixLines(text, { from, to }, prefix));
  const heading = (level: number) => applyEdit((text, from, to) => toggleHeading(text, { from, to }, level));
  const insertRule = () => applyEdit((text, from, to) => {
    const prefix = from > 0 && text[from - 1] !== '\n' ? '\n' : '';
    const suffix = to < text.length && text[to] !== '\n' ? '\n' : '';
    const insertion = prefix + '\n---\n' + suffix;
    const next = text.slice(0, from) + insertion + text.slice(to);
    const position = from + prefix.length + 5;
    return { text: next, selection: { from: position, to: position } };
  });
  const runHistory = (command: typeof undo) => {
    const view = editorRef.current;
    if (view && mode !== 'preview') {
      command(view);
      view.focus();
    }
  };

  return (
    <div className="editor-frame">
      <div className="editor-toolbar">
        <div className="mode-switch" role="tablist" aria-label="Режим документа">
          {modes.map(item => (
            <button key={item.id} type="button" role="tab" aria-selected={mode === item.id}
              className={mode === item.id ? 'active' : ''} onClick={() => onModeChange(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        <span className="editor-language">{mode === 'live-preview' ? 'LIVE MARKDOWN' : 'MARKDOWN'}</span>
      </div>

      {mode !== 'preview' && (
        <div className="format-toolbar" role="toolbar" aria-label="Форматування Markdown">
          <button type="button" aria-label="Скасувати" title="Скасувати (Ctrl+Z)" onClick={() => runHistory(undo)}><Undo2 size={16} /></button>
          <button type="button" aria-label="Повторити" title="Повторити (Ctrl+Y)" onClick={() => runHistory(redo)}><Redo2 size={16} /></button>
          <span className="toolbar-separator" />
          <button type="button" aria-label="Жирний" title="Жирний (Ctrl+B)" onClick={() => inline('**')}><Bold size={16} /></button>
          <button type="button" aria-label="Курсив" title="Курсив (Ctrl+I)" onClick={() => inline('*')}><Italic size={16} /></button>
          <button type="button" aria-label="Закреслений" title="Закреслений" onClick={() => inline('~~')}><Strikethrough size={16} /></button>
          <button type="button" aria-label="Вбудований код" title="Вбудований код" onClick={() => inline('`', '`', 'код')}><Code2 size={16} /></button>
          <button type="button" aria-label="Посилання" title="Посилання" onClick={() => inline('[', '](https://)', 'текст посилання')}><Link2 size={16} /></button>
          <span className="toolbar-separator" />
          <button type="button" aria-label="Заголовок 1" title="Заголовок 1" onClick={() => heading(1)}><Heading1 size={17} /></button>
          <button type="button" aria-label="Заголовок 2" title="Заголовок 2" onClick={() => heading(2)}><Heading2 size={17} /></button>
          <button type="button" aria-label="Маркований список" title="Маркований список" onClick={() => linePrefix('- ')}><List size={16} /></button>
          <button type="button" aria-label="Нумерований список" title="Нумерований список" onClick={() => linePrefix('1. ')}><ListOrdered size={16} /></button>
          <button type="button" aria-label="Цитата" title="Цитата" onClick={() => linePrefix('> ')}><Quote size={16} /></button>
          <button type="button" aria-label="Горизонтальна лінія" title="Горизонтальна лінія" onClick={insertRule}><Minus size={16} /></button>
        </div>
      )}

      <div className={'source-editor' + (mode === 'preview' ? ' source-editor-hidden' : '')}>
        <CodeMirror
          value={content}
          height="100%"
          extensions={extensions}
          editable
          onChange={onContentChange}
          onCreateEditor={view => { editorRef.current = view; }}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
            indentOnInput: true,
          }}
          className="gitnotes-codemirror"
        />
      </div>
      <article className="markdown-preview" hidden={mode !== 'preview'} dangerouslySetInnerHTML={{ __html: rendered }} />
      <div className="editor-status">
        <span>{mode === 'preview' ? 'Режим читання' : mode === 'live-preview' ? 'Редагування з форматуванням' : 'Вихідний Markdown'}</span>
        <span>{wordCount} слів · {lineCount} рядків · {content.length} символів</span>
      </div>
    </div>
  );
}
