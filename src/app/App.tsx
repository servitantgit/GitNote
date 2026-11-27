import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorState } from '@codemirror/state';
import { Files, GitBranch, Paperclip, Search, Settings, Plus, PanelLeftClose, Trash2, Check, AlertCircle, LoaderCircle, X, LockKeyhole } from 'lucide-react';
import { EditorWorkspace } from '../modules/editor/EditorWorkspace';
import type { EditorMode } from '../modules/editor/types';
import { workspaceStore } from '../infrastructure/storage/database';
import type { DocumentRecord } from '../core/domain/document-source';
import { documentSource } from '../infrastructure/storage/local-document-source';
import { workspaceFileSystem } from '../infrastructure/storage/local-workspace-file-system';
import { WorkspaceManager, type WorkspaceSnapshot } from '../core/domain/workspace';
import './app.css';

const LOCAL_REPOSITORY_ID = 'local-workspace';
const LOCAL_REPOSITORY = { id: LOCAL_REPOSITORY_ID, owner: 'local', name: 'Локальний робочий простір', defaultBranch: 'main' };
const INITIAL_CONTENT = '# Моя перша нотатка\n\nGitNotes — робочий простір для нотаток і документів із Git-контролем версій.\n\n- Source: редагування Markdown\n- Live Preview: редагування з форматуванням\n- Preview: режим читання';

type SaveState = 'loading' | 'saved' | 'saving' | 'error';

function makeNote(title = 'Без назви', content = ''): DocumentRecord {
  const now = Date.now();
  const id = crypto.randomUUID();
  return { id, repositoryId: LOCAL_REPOSITORY_ID, title, content, path: `Notes/${id}.md`, syncState: 'local', createdAt: now, updatedAt: now };
}

function tabForNote(note: DocumentRecord) {
  return { id: `note:${note.id}`, repositoryId: note.repositoryId, branch: 'main', noteId: note.id, title: note.title || 'Без назви', openedAt: Date.now() };
}

export function App() {
  const [mode, setMode] = useState<EditorMode>('source');
  const [notes, setNotes] = useState<DocumentRecord[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>('loading');
  const [storageError, setStorageError] = useState<string | null>(null);
  const managerRef = useRef<WorkspaceManager | null>(null);
  const saveSequence = useRef(0);
  const saveTimer = useRef<number | null>(null);
  const dirtyNoteIds = useRef(new Set<string>());
  const dirtyTitleNoteIds = useRef(new Set<string>());
  const activeNoteIdRef = useRef<string | null>(null);
  const editorStatesRef = useRef(new Map<string, EditorState>());

  const activeTab = useMemo(
    () => workspace?.tabs.find(tab => tab.id === workspace.activeTabId) ?? null,
    [workspace],
  );
  const activeNote = useMemo(
    () => notes.find(note => note.id === activeTab?.noteId) ?? null,
    [notes, activeTab],
  );
  activeNoteIdRef.current = activeNote?.id ?? null;

  const persistWorkspace = useCallback((manager: WorkspaceManager) => {
    const snapshot = manager.getSnapshot();
    setWorkspace(snapshot);
    void workspaceStore.save(snapshot).catch(error => {
      setStorageError(error instanceof Error ? error.message : 'Не вдалося зберегти стан робочого простору.');
    });
  }, []);

  const openNote = useCallback((note: DocumentRecord) => {
    const manager = managerRef.current;
    if (!manager) return;
    manager.openTab(tabForNote(note));
    persistWorkspace(manager);
  }, [persistWorkspace]);

  useEffect(() => {
    let cancelled = false;
    async function loadWorkspace() {
      try {
        const [documentMetas, savedWorkspace] = await Promise.all([
          documentSource.list(),
          workspaceStore.get(),
        ]);
        const rootNodes = await workspaceFileSystem.list(LOCAL_REPOSITORY_ID);
        if (!rootNodes.some(node => node.kind === 'folder' && node.name === 'Notes')) {
          try {
            await workspaceFileSystem.createFolder(LOCAL_REPOSITORY_ID, '', 'Notes');
          } catch (error) {
            // React StrictMode can run this initialization effect twice. If another
            // invocation created Notes first, treat that as successful initialization.
            const refreshedRootNodes = await workspaceFileSystem.list(LOCAL_REPOSITORY_ID);
            const notesFolderExists = refreshedRootNodes.some(
              node => node.kind === 'folder' && node.name === 'Notes',
            );
            if (!notesFolderExists) throw error;
          }
        }
        let storedNotes = await Promise.all(documentMetas.map(async meta => ({
          ...meta,
          ...await documentSource.read(meta.id),
        })));
        if (cancelled) return;

        let nextNotes = storedNotes;
        if (nextNotes.length === 0) {
          const welcomeNote = makeNote('Моя перша нотатка', INITIAL_CONTENT);
          await documentSource.create(welcomeNote, welcomeNote.content);
          await workspaceFileSystem.registerDocument(welcomeNote.repositoryId, welcomeNote.id, welcomeNote.path!);
          nextNotes = [welcomeNote];
        }

        const manager = new WorkspaceManager(savedWorkspace ?? undefined);
        if (!manager.getSnapshot().repositories.some(repository => repository.id === LOCAL_REPOSITORY_ID)) {
          manager.registerRepository(LOCAL_REPOSITORY);
        }

        const validNoteIds = new Set(nextNotes.map(note => note.id));
        for (const tab of manager.getSnapshot().tabs) {
          if (tab.repositoryId === LOCAL_REPOSITORY_ID && !validNoteIds.has(tab.noteId)) manager.closeTab(tab.id);
        }
        const current = manager.getSnapshot();
        const activeExists = current.tabs.some(tab => tab.id === current.activeTabId && validNoteIds.has(tab.noteId));
        if (!activeExists && nextNotes[0]) manager.openTab(tabForNote(nextNotes[0]));

        managerRef.current = manager;
        setNotes(nextNotes);
        setWorkspace(manager.getSnapshot());
        await workspaceStore.save(manager.getSnapshot());
        if (!cancelled) setSaveState('saved');
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
    const pendingNotes = notes.filter(note => dirtyNoteIds.current.has(note.id) || dirtyTitleNoteIds.current.has(note.id));
    if (pendingNotes.length === 0) return;

    const sequence = ++saveSequence.current;
    setSaveState('saving');
    const timer = window.setTimeout(() => {
      saveTimer.current = null;
      void Promise.all(pendingNotes.map(async note => {
        if (dirtyNoteIds.current.has(note.id)) {
          await documentSource.write(note.id, note.content, note.baseSha);
        }
        if (dirtyTitleNoteIds.current.has(note.id)) {
          await documentSource.rename(note.id, note.title);
        }
      }))
        .then(() => {
          if (saveSequence.current !== sequence) return;
          for (const savedNote of pendingNotes) {
            const currentNote = notes.find(note => note.id === savedNote.id);
            if (currentNote?.updatedAt === savedNote.updatedAt) {
              dirtyNoteIds.current.delete(savedNote.id);
              dirtyTitleNoteIds.current.delete(savedNote.id);
            }
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

  const updateActiveNote = useCallback((updates: Partial<Pick<DocumentRecord, 'title' | 'content'>>) => {
    if (!activeNote) return;
    if (updates.content !== undefined) dirtyNoteIds.current.add(activeNote.id);
    if (updates.title !== undefined) dirtyTitleNoteIds.current.add(activeNote.id);
    setNotes(current => current.map(note => note.id === activeNote.id
      ? { ...note, ...updates, updatedAt: Date.now() }
      : note));
    if (updates.title !== undefined && managerRef.current) {
      const manager = managerRef.current;
      const tabId = `note:${activeNote.id}`;
      if (manager.getSnapshot().tabs.some(tab => tab.id === tabId)) {
        manager.updateTab(tabId, { title: updates.title || 'Без назви' });
        persistWorkspace(manager);
      }
    }
  }, [activeNote, persistWorkspace]);

  const createNote = useCallback(async () => {
    if (saveState === 'loading') return;
    const note = makeNote();
    try {
      await documentSource.create(note, note.content);
      await workspaceFileSystem.registerDocument(note.repositoryId, note.id, note.path!);
      setNotes(current => [note, ...current]);
      openNote(note);
      setMode('source');
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Не вдалося створити нотатку.');
    }
  }, [openNote, saveState]);

  const closeTab = useCallback((tabId: string) => {
    const manager = managerRef.current;
    if (!manager) return;
    manager.closeTab(tabId);
    if (!manager.getSnapshot().activeTabId) {
      const fallback = notes.find(note => `note:${note.id}` !== tabId);
      if (fallback) manager.openTab(tabForNote(fallback));
    }
    persistWorkspace(manager);
  }, [notes, persistWorkspace]);

  const deleteActiveNote = useCallback(async () => {
    if (!activeNote) return;
    const confirmed = window.confirm(`Видалити нотатку «${activeNote.title}» з локального сховища?`);
    if (!confirmed) return;
    try {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
      saveSequence.current += 1;
      if (activeNote.path) await workspaceFileSystem.remove(activeNote.repositoryId, activeNote.path);
      else await documentSource.remove(activeNote.id);
      dirtyNoteIds.current.delete(activeNote.id);
      dirtyTitleNoteIds.current.delete(activeNote.id);
      const manager = managerRef.current;
      manager?.closeTab(`note:${activeNote.id}`);
      const remaining = notes.filter(note => note.id !== activeNote.id);
      if (remaining.length === 0) {
        const replacement = makeNote();
        await documentSource.create(replacement, replacement.content);
        await workspaceFileSystem.registerDocument(replacement.repositoryId, replacement.id, replacement.path!);
        setNotes([replacement]);
        manager?.openTab(tabForNote(replacement));
      } else {
        setNotes(remaining);
        if (manager && !manager.getSnapshot().activeTabId) manager.openTab(tabForNote(remaining[0]));
      }
      if (manager) persistWorkspace(manager);
      setStorageError(null);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Не вдалося видалити нотатку.');
    }
  }, [activeNote, notes, persistWorkspace]);

  const handleEditorContentChange = useCallback((content: string) => {
    const noteId = activeNoteIdRef.current;
    if (!noteId) return;
    dirtyNoteIds.current.add(noteId);
    setNotes(current => current.map(note => note.id === noteId
      ? { ...note, content, syncState: note.path ? (note.syncState === 'conflict' ? 'conflict' : 'dirty') : 'local', updatedAt: Date.now() }
      : note));
  }, []);

  const saveLabel = saveState === 'saving' ? 'Збереження…'
    : saveState === 'error' ? 'Помилка збереження'
      : saveState === 'loading' ? 'Завантаження…' : 'Збережено локально';

  const activeRepositoryId = workspace?.activeRepositoryId ?? null;
  const activeRepository = workspace?.repositories.find(repository => repository.id === activeRepositoryId);
  const activeTabRepository = activeTab ? workspace?.repositories.find(repository => repository.id === activeTab.repositoryId) : null;
  const remoteAllowed = Boolean(activeTab && managerRef.current?.canUseRemote(activeTab.repositoryId, 'sync'));

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="icon-button mobile-toggle" aria-label="Перемкнути навігацію" onClick={() => setSidebarOpen(!sidebarOpen)}><PanelLeftClose size={18} /></button>
        <div className="brand-mark">G</div><strong className="brand-name">GitNotes</strong>
        <div className="repo-indicator"><GitBranch size={15} /><span>{activeRepository?.name ?? 'Репозиторій не активний'}</span></div>
        <div className="top-actions">
          <button className="icon-button" aria-label="Пошук нотаток" title="Пошук нотаток (ще не реалізовано)" disabled><Search size={18} /></button>
          <button className="icon-button" aria-label="Налаштування" title="Налаштування (ще не реалізовано)" disabled><Settings size={18} /></button>
        </div>
      </header>
      {storageError && <div className="storage-error" role="alert">{storageError}</div>}
      <div className="workspace">
        {sidebarOpen && <aside className="sidebar">
          <div className="sidebar-heading"><span>НОТАТКИ</span><button className="icon-button" aria-label="Створити нотатку" title="Створити нотатку" onClick={createNote} disabled={saveState === 'loading'}><Plus size={17} /></button></div>
          <div className="note-list" role="list" aria-label="Список нотаток">
            {notes.map(note => (
              <button key={note.id} className={`tree-item note-item${note.id === activeNote?.id ? ' selected' : ''}`} onClick={() => openNote(note)} title={note.title}>
                <Files size={16} /><span>{note.title || 'Без назви'}</span>
              </button>
            ))}
          </div>
          <div className="sidebar-footer"><span className="status-dot" />Лише локальне збереження</div>
        </aside>}
        <section className="document-area">
          <div className="document-tabs" role="tablist" aria-label="Відкриті документи">
            {workspace?.tabs.map(tab => {
              const note = notes.find(item => item.id === tab.noteId);
              if (!note) return null;
              const inactive = tab.repositoryId !== activeRepositoryId;
              return <div className={`document-tab${tab.id === workspace.activeTabId ? ' active' : ''}${inactive ? ' inactive' : ''}`} key={tab.id}>
                <button role="tab" aria-selected={tab.id === workspace.activeTabId} onClick={() => {
                  managerRef.current?.selectTab(tab.id);
                  if (managerRef.current) persistWorkspace(managerRef.current);
                }} title={inactive ? 'Репозиторій не активний. Локальне редагування доступне.' : tab.title}>
                  {inactive && <LockKeyhole size={12} />}<span>{note.title || 'Без назви'}</span>
                </button>
                <button className="tab-close" aria-label={`Закрити ${note.title || 'Без назви'}`} onClick={() => closeTab(tab.id)}><X size={13} /></button>
              </div>;
            })}
          </div>
          {activeNote ? <>
            <div className="document-header">
              <div className="document-title-wrap">
                <div className="breadcrumb">Нотатки <span>/</span> {activeTabRepository?.name ?? 'Репозиторій'}</div>
                <input className="document-title-input" aria-label="Назва нотатки" value={activeNote.title} onChange={event => updateActiveNote({ title: event.target.value })} placeholder="Без назви" />
              </div>
              <div className="document-actions">
                <span className={`save-indicator ${saveState}`} title={storageError ?? saveLabel}>
                  {saveState === 'saving' ? <LoaderCircle size={14} /> : saveState === 'error' ? <AlertCircle size={14} /> : <Check size={14} />}{saveLabel}
                </span>
                {!remoteAllowed && <span className="local-only-indicator" title="Віддалені Git-операції для цього репозиторію вимкнені"><LockKeyhole size={13} />Локально</span>}
                <button className="icon-button delete-note-button" aria-label="Видалити нотатку" title="Видалити нотатку" onClick={() => void deleteActiveNote()}><Trash2 size={16} /></button>
                <button className="attachment-button" disabled title="Вкладення будуть додані окремим модулем"><Paperclip size={16} />Вкладені файли</button>
              </div>
            </div>
            <EditorWorkspace documentId={activeNote.id} editorStates={editorStatesRef.current} mode={mode} onModeChange={setMode} content={activeNote.content} onContentChange={handleEditorContentChange} />
          </> : <div className="empty-workspace">Виберіть нотатку або створіть нову</div>}
        </section>
      </div>
    </main>
  );
}
