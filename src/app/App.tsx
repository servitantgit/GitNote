import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Files, GitBranch, Paperclip, Search, Settings, Plus, PanelLeftClose, Trash2, Check, AlertCircle, LoaderCircle } from 'lucide-react';
import { EditorWorkspace } from '../modules/editor/EditorWorkspace';
import type { EditorMode } from '../modules/editor/types';
import { noteStore, type LocalNote } from '../infrastructure/storage/database';
import './app.css';

const LOCAL_REPOSITORY_ID = 'local-workspace';
const INITIAL_CONTENT = '# Моя перша нотатка\n\nGitNote — робочий простір для нотаток і документів із Git-контролем версій.\n\n- Source: редагування Markdown\n- Live Preview: редагування з форматуванням\n- Preview: режим читання';

type SaveState = 'loading' | 'saved' | 'saving' | 'error';

function makeNote(title = 'Без назви', content = ''): LocalNote {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    repositoryId: LOCAL_REPOSITORY_ID,
    title,
    content,
    createdAt: now,
    updatedAt: now,
  };
}

export function App() {
  const [mode, setMode] = useState<EditorMode>('source');
  const [notes, setNotes] = useState<LocalNote[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>('loading');
  const [storageError, setStorageError] = useState<string | null>(null);
  const saveSequence = useRef(0);
  const saveTimer = useRef<number | null>(null);
  const dirtyNoteIds = useRef(new Set<string>());

  const activeNote = useMemo(
    () => notes.find(note => note.id === activeNoteId) ?? null,
    [notes, activeNoteId],
  );

  useEffect(() => {
    let cancelled = false;
    async function loadWorkspace() {
      try {
        const storedNotes = await noteStore.list(LOCAL_REPOSITORY_ID);
        if (cancelled) return;
        if (storedNotes.length > 0) {
          setNotes(storedNotes);
          setActiveNoteId(storedNotes[0].id);
        } else {
          const welcomeNote = makeNote('Моя перша нотатка', INITIAL_CONTENT);
          await noteStore.save(welcomeNote);
          if (cancelled) return;
          setNotes([welcomeNote]);
          setActiveNoteId(welcomeNote.id);
        }
        setSaveState('saved');
      } catch (error) {
        if (cancelled) return;
        setStorageError(error instanceof Error ? error.message : 'Не вдалося відкрити локальне сховище.');
        setSaveState('error');
      }
    }
    void loadWorkspace();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (saveState === 'loading') return;
    const pendingNotes = notes.filter(note => dirtyNoteIds.current.has(note.id));
    if (pendingNotes.length === 0) return;

    const sequence = ++saveSequence.current;
    setSaveState('saving');
    const timer = window.setTimeout(() => {
      saveTimer.current = null;
      void Promise.all(pendingNotes.map(note => noteStore.save(note)))
        .then(() => {
          if (saveSequence.current !== sequence) return;
          for (const savedNote of pendingNotes) {
            const currentNote = notes.find(note => note.id === savedNote.id);
            if (currentNote?.updatedAt === savedNote.updatedAt) dirtyNoteIds.current.delete(savedNote.id);
          }
          setStorageError(null);
          setSaveState(dirtyNoteIds.current.size === 0 ? 'saved' : 'saving');
        })
        .catch(error => {
          if (saveSequence.current === sequence) {
            setStorageError(error instanceof Error ? error.message : 'Не вдалося зберегти нотатку.');
            setSaveState('error');
          }
        });
    }, 350);
    saveTimer.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (saveTimer.current === timer) saveTimer.current = null;
    };
  }, [notes]);

  const updateActiveNote = useCallback((updates: Partial<Pick<LocalNote, 'title' | 'content'>>) => {
    if (activeNoteId) dirtyNoteIds.current.add(activeNoteId);
    setNotes(current => current.map(note => note.id === activeNoteId
      ? { ...note, ...updates, updatedAt: Date.now() }
      : note));
  }, [activeNoteId]);

  const createNote = useCallback(() => {
    if (saveState === 'loading') return;
    const note = makeNote();
    dirtyNoteIds.current.add(note.id);
    setNotes(current => [note, ...current]);
    setActiveNoteId(note.id);
    setMode('source');
  }, [saveState]);

  const deleteActiveNote = useCallback(async () => {
    if (!activeNote) return;
    const confirmed = window.confirm(`Видалити нотатку «${activeNote.title}» з локального сховища?`);
    if (!confirmed) return;
    try {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
      saveSequence.current += 1;
      await noteStore.remove(activeNote.id);
      dirtyNoteIds.current.delete(activeNote.id);
      const remaining = notes.filter(note => note.id !== activeNote.id);
      if (remaining.length === 0) {
        const replacement = makeNote();
        dirtyNoteIds.current.add(replacement.id);
        await noteStore.save(replacement);
        dirtyNoteIds.current.delete(replacement.id);
        setNotes([replacement]);
        setActiveNoteId(replacement.id);
      } else {
        setNotes(remaining);
        setActiveNoteId(remaining[0].id);
      }
      setStorageError(null);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Не вдалося видалити нотатку.');
    }
  }, [activeNote, notes]);

  const saveLabel = saveState === 'saving'
    ? 'Збереження…'
    : saveState === 'error'
      ? 'Помилка збереження'
      : saveState === 'loading'
        ? 'Завантаження…'
        : 'Збережено локально';

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="icon-button mobile-toggle" aria-label="Перемкнути навігацію" onClick={() => setSidebarOpen(!sidebarOpen)}><PanelLeftClose size={18} /></button>
        <div className="brand-mark">G</div><strong className="brand-name">GitNote</strong>
        <div className="repo-indicator"><GitBranch size={15} /><span>Локальний робочий простір</span></div>
        <div className="top-actions">
          <button className="icon-button" aria-label="Пошук нотаток" title="Пошук нотаток (ще не реалізовано)" disabled><Search size={18} /></button>
          <button className="icon-button" aria-label="Налаштування" title="Налаштування (ще не реалізовано)" disabled><Settings size={18} /></button>
        </div>
      </header>
      <div className="workspace">
        {sidebarOpen && <aside className="sidebar">
          <div className="sidebar-heading"><span>НОТАТКИ</span><button className="icon-button" aria-label="Створити нотатку" title="Створити нотатку" onClick={createNote} disabled={saveState === 'loading'}><Plus size={17} /></button></div>
          <div className="note-list" role="list" aria-label="Список нотаток">
            {notes.map(note => (
              <button
                key={note.id}
                className={`tree-item note-item${note.id === activeNoteId ? ' selected' : ''}`}
                onClick={() => setActiveNoteId(note.id)}
                title={note.title}
              >
                <Files size={16} /><span>{note.title || 'Без назви'}</span>
              </button>
            ))}
          </div>
          <div className="sidebar-footer"><span className="status-dot" />Лише локальне збереження</div>
        </aside>}
        <section className="document-area">
          {activeNote ? <>
            <div className="document-header">
              <div className="document-title-wrap">
                <div className="breadcrumb">Нотатки <span>/</span> Локальний робочий простір</div>
                <input
                  className="document-title-input"
                  aria-label="Назва нотатки"
                  value={activeNote.title}
                  onChange={event => updateActiveNote({ title: event.target.value })}
                  placeholder="Без назви"
                />
              </div>
              <div className="document-actions">
                <span className={`save-indicator ${saveState}`} title={storageError ?? saveLabel}>
                  {saveState === 'saving' ? <LoaderCircle size={14} /> : saveState === 'error' ? <AlertCircle size={14} /> : <Check size={14} />}
                  {saveLabel}
                </span>
                <button className="icon-button delete-note-button" aria-label="Видалити нотатку" title="Видалити нотатку" onClick={() => void deleteActiveNote()}><Trash2 size={16} /></button>
                <button className="attachment-button" disabled title="Вкладення будуть додані окремим модулем"><Paperclip size={16} />Вкладені файли</button>
              </div>
            </div>
            {storageError && <div className="storage-error" role="alert">{storageError}</div>}
            <EditorWorkspace mode={mode} onModeChange={setMode} content={activeNote.content} onContentChange={content => updateActiveNote({ content })} />
          </> : <div className="empty-workspace">Завантаження нотаток…</div>}
        </section>
      </div>
    </main>
  );
}
