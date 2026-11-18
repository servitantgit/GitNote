import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { EditorMode } from './types';
import { livePreviewExtension } from './live-preview';
import './editor.css';

interface Props { mode: EditorMode; onModeChange: (mode: EditorMode) => void; content: string; onContentChange: (value: string) => void }
const modes: { id: EditorMode; label: string }[] = [
  { id: 'source', label: 'Source' }, { id: 'live-preview', label: 'Live Preview' }, { id: 'preview', label: 'Preview' },
];

export function EditorWorkspace({ mode, onModeChange, content, onContentChange }: Props) {
  const rendered = DOMPurify.sanitize(marked.parse(content) as string);
  return <div className="editor-frame">
    <div className="editor-toolbar"><div className="mode-switch" role="tablist" aria-label="Режим документа">{modes.map(item => <button key={item.id} role="tab" aria-selected={mode === item.id} className={mode === item.id ? 'active' : ''} onClick={() => onModeChange(item.id)}>{item.label}</button>)}</div><span className="editor-language">{mode === 'live-preview' ? 'LIVE MARKDOWN' : 'MARKDOWN'}</span></div>
    {mode === 'preview' ? <article className="markdown-preview" dangerouslySetInnerHTML={{ __html: rendered }} /> : <div className="source-editor"><CodeMirror value={content} height="100%" extensions={mode === 'live-preview' ? [markdown(), livePreviewExtension] : [markdown()]} editable onChange={onContentChange} basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }} /></div>}
    <div className="editor-status"><span>{mode === 'preview' ? 'Режим читання' : mode === 'live-preview' ? 'Редагування з форматуванням' : 'Вихідний Markdown'}</span><span>{content.length} символів</span></div>
  </div>;
}
