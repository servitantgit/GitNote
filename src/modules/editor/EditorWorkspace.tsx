import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { codeLanguages } from './code-languages';
import { redo, undo } from '@codemirror/commands';
import { Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import DOMPurify from 'dompurify';
import {
  Bold, Italic, Strikethrough, Code2, Link2, Heading1, Heading2,
  List, ListOrdered, Quote, Minus, Undo2, Redo2, Map as MapIcon, ListTree,
} from 'lucide-react';
import type { EditorMode } from './types';
import { prefixLines, toggleHeading, wrapSelection } from './markdown-commands';
import { createScrollCoordinator } from './navigation/scroll-coordinator';
import {
  createCodeMirrorScrollSurface,
  createPreviewScrollSurface,
  type DocumentScrollPosition,
} from './navigation/scroll-position';
import { Minimap } from './Minimap';
import { Outline } from './Outline';
import { renderMarkdown } from './markdown-preview';
import './editor.css';

interface Props {
  documentId: string;
  editorStates: Map<string, EditorState>;
  scrollPosition?: DocumentScrollPosition;
  onScrollPositionChange: (documentId: string, position: DocumentScrollPosition) => void;
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  content: string;
  onContentChange: (value: string) => void;
}

interface ScrollDebugHook {
  readCoordinatorPosition: () => DocumentScrollPosition;
  readSourcePosition: () => DocumentScrollPosition | null;
}

declare global {
  interface Window {
    __gitnoteScrollDebug?: ScrollDebugHook;
  }
}

function applyInlineCommand(view: EditorView, before: string, after = before, placeholder = 'текст'): boolean {
  const { from, to } = view.state.selection.main;
  const result = wrapSelection(view.state.doc.toString(), { from, to }, before, after, placeholder);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: result.text },
    selection: { anchor: result.selection.from, head: result.selection.to },
    scrollIntoView: true,
  });
  return true;
}

const markdownKeymap = Prec.high(keymap.of([
  { key: 'Mod-b', run: view => applyInlineCommand(view, '**') },
  { key: 'Mod-i', run: view => applyInlineCommand(view, '*') },
  { key: 'Mod-Shift-x', run: view => applyInlineCommand(view, '~~') },
  { key: 'Mod-k', run: view => applyInlineCommand(view, '[', '](https://)', 'текст посилання') },
]));

const modes: { id: EditorMode; label: string }[] = [
  { id: 'source', label: 'Source' },
  { id: 'live', label: 'Live' },
  { id: 'preview', label: 'Preview' },
];

export function EditorWorkspace({
  documentId,
  editorStates,
  scrollPosition,
  onScrollPositionChange,
  mode,
  onModeChange,
  content,
  onContentChange,
}: Props) {
  const editorRef = useRef<EditorView | null>(null);
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [minimapOpen, setMinimapOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [rendered, setRendered] = useState<{ content: string; html: string } | null>(null);
  const previewRef = useRef<HTMLElement | null>(null);
  const sourceAttachmentRef = useRef<{ coordinator: ReturnType<typeof createScrollCoordinator>; view: EditorView; detach: () => void } | null>(null);
  const previewAttachmentRef = useRef<{ coordinator: ReturnType<typeof createScrollCoordinator>; element: HTMLElement; detach: () => void } | null>(null);
  const positionChangeRef = useRef(onScrollPositionChange);
  positionChangeRef.current = onScrollPositionChange;

  const coordinator = useMemo(
    () => createScrollCoordinator(
      scrollPosition ?? { line: 0, offset: 0 },
      position => positionChangeRef.current(documentId, position),
    ),
    [documentId],
  );

  useLayoutEffect(() => {
    if (!(import.meta as ImportMeta & { env: { DEV: boolean } }).env.DEV) return;
    const debugHook: ScrollDebugHook = {
      readCoordinatorPosition: () => coordinator.getPosition(),
      readSourcePosition: () => editorRef.current
        ? createCodeMirrorScrollSurface(editorRef.current).readPosition()
        : null,
    };
    window.__gitnoteScrollDebug = debugHook;
    return () => {
      if (window.__gitnoteScrollDebug === debugHook) {
        delete window.__gitnoteScrollDebug;
      }
    };
  }, [coordinator]);

  const attachSource = (view: EditorView) => {
    const current = sourceAttachmentRef.current;
    if (current?.coordinator === coordinator && current.view === view) return;
    current?.detach();
    sourceAttachmentRef.current = {
      coordinator,
      view,
      detach: (() => {
        return coordinator.register(createCodeMirrorScrollSurface(view));
      })(),
    };
  };

  const extensions = useMemo(() => [markdown({ codeLanguages }), markdownKeymap, EditorView.lineWrapping], []);
  useEffect(() => {
    if (mode !== 'preview' && mode !== 'live') {
      setRendered('');
      return;
    }
    let active = true;
    void renderMarkdown(content).then(html => {
      if (active) setRendered({ content, html: DOMPurify.sanitize(html) });
    });
    return () => { active = false; };
  }, [content, mode]);
  const previewReady = rendered?.content === content;
  const wordCount = content.trim() ? content.trim().split(/\s+/u).length : 0;
  const lineCount = content.length ? content.split('\n').length : 1;

  useLayoutEffect(() => {
    if ((mode === 'preview' || mode === 'live') && previewReady) {
      const element = previewRef.current;
      const current = previewAttachmentRef.current;
      if (element && (current?.coordinator !== coordinator || current.element !== element)) {
        current?.detach();
        previewAttachmentRef.current = {
          coordinator,
          element,
          detach: coordinator.register(createPreviewScrollSurface(element, content)),
        };
      }
    }
    if (mode !== 'preview' && editorRef.current?.dom.isConnected) {
      attachSource(editorRef.current);
    }

    return () => {
      const source = sourceAttachmentRef.current;
      if (source?.coordinator === coordinator) {
        source.detach();
        sourceAttachmentRef.current = null;
      }
      const preview = previewAttachmentRef.current;
      if (preview?.coordinator === coordinator) {
        preview.detach();
        previewAttachmentRef.current = null;
      }
    };
  }, [coordinator, mode, content, previewReady]);

  // Surface listeners are detached by the effect above. Do not terminally destroy
  // this memoized coordinator here: React StrictMode replays effect cleanup/setup
  // with the same instance, which would otherwise leave it permanently disabled.

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
              className={mode === item.id ? 'active' : ''} data-mode={item.id} onClick={() => onModeChange(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        <div className="editor-toolbar-actions">
          <button
            type="button"
            className={'outline-toggle' + (outlineOpen ? ' active' : '')}
            aria-label={outlineOpen ? 'Приховати зміст' : 'Показати зміст'}
            aria-pressed={outlineOpen}
            title="Структура документа"
            onClick={() => setOutlineOpen(open => !open)}
          >
            <ListTree size={15} />
          </button>
          <button
            type="button"
            className={'minimap-toggle' + (minimapOpen ? ' active' : '')}
            aria-label={minimapOpen ? 'Приховати мінімапу' : 'Показати мінімапу'}
            aria-pressed={minimapOpen}
            title="Мінімапа документа"
            onClick={() => setMinimapOpen(open => !open)}
          >
            <MapIcon size={15} />
          </button>
          <span className="editor-language">{mode === 'live' ? 'LIVE MARKDOWN' : 'MARKDOWN'}</span>
        </div>
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

      <div className={'editor-main' + (mode === 'live' ? ' live-mode' : '')}>
      <div className={'source-editor' + (mode === 'preview' ? ' source-editor-hidden' : '')}>
        <CodeMirror
          key={documentId}
          value={content}
          height="100%"
          extensions={extensions}
          editable
          onChange={onContentChange}
          onUpdate={update => {
            editorStates.set(documentId, update.state);
          }}
          onCreateEditor={view => {
            editorRef.current = view;
            setEditorView(view);
            const savedState = editorStates.get(documentId);
            if (savedState) view.setState(savedState);
            editorStates.set(documentId, view.state);
            attachSource(view);
          }}
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
      <article
        key={documentId}
        ref={previewRef}
        className="markdown-preview"
        hidden={mode !== 'preview' && mode !== 'live'}
        dangerouslySetInnerHTML={{ __html: previewReady ? rendered.html : '' }}
      />
      {outlineOpen && <Outline content={content} coordinator={coordinator} />}
      {minimapOpen && (
        <Minimap
          view={editorView}
          content={content}
          mode={mode}
          previewRef={previewRef}
          coordinator={coordinator}
        />
      )}
      </div>
      <div className="editor-status">
        <span>{mode === 'preview' ? 'Режим читання' : mode === 'live' ? 'Редагування та попередній перегляд' : 'Вихідний Markdown'}</span>
        <span>{wordCount} слів · {lineCount} рядків · {content.length} символів</span>
      </div>
    </div>
  );
}
