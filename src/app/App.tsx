import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorState } from '@codemirror/state';
import type { DocumentScrollPosition } from '../modules/editor/navigation/scroll-position';
import { Files, FileText, FileUp, GitBranch, Paperclip, Search, Settings, Plus, PanelLeftClose, Trash2, Check, AlertCircle, LoaderCircle, X, LockKeyhole } from 'lucide-react';
import { EditorWorkspace } from '../modules/editor/EditorWorkspace';
import type { EditorMode } from '../modules/editor/types';
import { workspaceStore } from '../infrastructure/storage/database';
import type { BinaryDocumentRecord, DocumentRecord } from '../core/domain/document-source';
import { binaryDocumentSource, documentSource } from '../infrastructure/storage/local-document-source';
import { workspaceFileSystem } from '../infrastructure/storage/local-workspace-file-system';
import { validateWorkspaceName } from '../core/domain/workspace-file-system';
import { WorkspaceManager, type WorkspaceSnapshot } from '../core/domain/workspace';
import './app.css';

const LOCAL_REPOSITORY_ID = 'local-workspace';
const LOCAL_REPOSITORY = { id: LOCAL_REPOSITORY_ID, owner: 'local', name: 'Локальний робочий простір', defaultBranch: 'main' };
const INITIAL_CONTENT = '# Моя перша нотатка\n\nGitNotes — робочий простір для нотаток і документів із Git-контролем версій.\n\n- Source: редагування Markdown\n- Live: Source і Preview поруч із синхронізованою прокруткою\n- Preview: режим читання';

async function ensureWorkspaceFolder(name: string): Promise<void> {
  const nodes = await workspaceFileSystem.list(LOCAL_REPOSITORY_ID);
  if (nodes.some(node => node.kind === 'folder' && node.name === name)) return;
  try {
    await workspaceFileSystem.createFolder(LOCAL_REPOSITORY_ID, '', name);
  } catch (error) {
    const refreshed = await workspaceFileSystem.list(LOCAL_REPOSITORY_ID);
    if (!refreshed.some(node => node.kind === 'folder' && node.name === name)) throw error;
  }
}

const OfficeDocumentViewer = lazy(() => import('../modules/documents/OfficeDocumentViewer').then(module => ({ default: module.OfficeDocumentViewer })));
const HtmlDocumentViewer = lazy(() => import('../modules/documents/html/HtmlDocumentViewer').then(module => ({ default: module.HtmlDocumentViewer })));

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
  const [binaryDocuments, setBinaryDocuments] = useState<Omit<BinaryDocumentRecord, 'content'>[]>([]);
  const [activeBinaryDocument, setActiveBinaryDocument] = useState<BinaryDocumentRecord | null>(null);
  const [binaryDirty, setBinaryDirty] = useState(false);
  const [binarySaveState, setBinarySaveState] = useState<SaveState>('saved');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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
  const scrollPositionsRef = useRef(new Map<string, DocumentScrollPosition>());

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

  const canLeaveBinaryDocument = useCallback((nextDocumentId?: string) => {
    if (!activeBinaryDocument || activeBinaryDocument.id === nextDocumentId || !binaryDirty) return true;
    return window.confirm('Документ має незбережені зміни. Відкрити інший документ і відкинути їх?');
  }, [activeBinaryDocument, binaryDirty]);

  const openNote = useCallback((note: DocumentRecord, confirmedSwitch = false) => {
    if (!confirmedSwitch && !canLeaveBinaryDocument()) return;
    setActiveBinaryDocument(null);
    setBinaryDirty(false);
    setBinarySaveState('saved');
    const manager = managerRef.current;
    if (!manager) return;
    manager.openTab(tabForNote(note));
    persistWorkspace(manager);
  }, [canLeaveBinaryDocument, persistWorkspace]);

  useEffect(() => {
    let cancelled = false;
    async function loadWorkspace() {
      try {
        const [documentMetas, savedWorkspace, binaryMetas] = await Promise.all([
          documentSource.list(),
          workspaceStore.get(),
          binaryDocumentSource.list(),
        ]);
        await Promise.all(['Notes', 'Documents'].map(ensureWorkspaceFolder));
        let storedNotes = await Promise.all(documentMetas.map(async meta => ({
          ...meta,
          ...await documentSource.read(meta.id),
        })));
        if (cancelled) return;

        let nextNotes = storedNotes;
        if (nextNotes.length === 0) {
          const welcomeNote = makeNote('Моя перша нотатка', INITIAL_CONTENT);
          await workspaceFileSystem.createDocument(welcomeNote, welcomeNote.path!);
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
        setBinaryDocuments(binaryMetas);
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
    if (saveState === 'loading' || !canLeaveBinaryDocument()) return;
    const note = makeNote();
    try {
      await workspaceFileSystem.createDocument(note, note.path!);
      setNotes(current => [note, ...current]);
      openNote(note, true);
      setMode('source');
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Не вдалося створити нотатку.');
    }
  }, [canLeaveBinaryDocument, openNote, saveState]);

  const openBinaryDocument = useCallback(async (id: string) => {
    if (activeBinaryDocument?.id === id || !canLeaveBinaryDocument(id)) return;
    try {
      const document = await binaryDocumentSource.read(id);
      setActiveBinaryDocument(document);
      setBinaryDirty(false);
      setBinarySaveState('saved');
      setStorageError(null);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Не вдалося відкрити документ.');
    }
  }, [activeBinaryDocument, canLeaveBinaryDocument]);

  const importBinaryDocument = useCallback(async (file: File) => {
    if (!canLeaveBinaryDocument()) return;
    try {
      const name = validateWorkspaceName(file.name);
      const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
      if (!['.docx', '.xlsx', '.pptx', '.md', '.html', '.svg'].includes(extension)) {
        throw new Error('Підтримуються формати DOCX, XLSX, PPTX, MD, HTML та SVG.');
      }
      await ensureWorkspaceFolder('Documents');
      const now = Date.now();
      const path = `Documents/${name}`;
      const document: BinaryDocumentRecord = {
        id: crypto.randomUUID(), repositoryId: LOCAL_REPOSITORY_ID, title: name, path,
        content: file, mediaType: file.type || 'application/octet-stream', size: file.size,
        syncState: 'local', createdAt: now, updatedAt: now,
      };
      await workspaceFileSystem.createBinaryDocument(document, path);
      const [metas, stored] = await Promise.all([binaryDocumentSource.list(), binaryDocumentSource.read(document.id)]);
      setBinaryDocuments(metas);
      setActiveBinaryDocument(stored);
      setBinaryDirty(false);
      setBinarySaveState('saved');
      setStorageError(null);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Не вдалося імпортувати документ.');
    }
  }, [canLeaveBinaryDocument]);

  const saveBinaryDocument = useCallback(async (content: Blob) => {
    if (!activeBinaryDocument) return;
    setBinarySaveState('saving');
    try {
      await binaryDocumentSource.write(activeBinaryDocument.id, content);
      const [stored, metas] = await Promise.all([binaryDocumentSource.read(activeBinaryDocument.id), binaryDocumentSource.list()]);
      setActiveBinaryDocument(stored);
      setBinaryDocuments(metas);
      setBinaryDirty(false);
      setBinarySaveState('saved');
      setStorageError(null);
    } catch (error) {
      setBinarySaveState('error');
      setStorageError(error instanceof Error ? error.message : 'Не вдалося зберегти документ.');
      throw error;
    }
  }, [activeBinaryDocument]);

  const deleteActiveBinaryDocument = useCallback(async () => {
    if (!activeBinaryDocument) return;
    if (!window.confirm(`Видалити документ «${activeBinaryDocument.title}» з локального сховища?`)) return;
    try {
      if (activeBinaryDocument.path) await workspaceFileSystem.remove(activeBinaryDocument.repositoryId, activeBinaryDocument.path);
      else await binaryDocumentSource.remove(activeBinaryDocument.id);
      setBinaryDocuments(await binaryDocumentSource.list());
      setActiveBinaryDocument(null);
      setBinaryDirty(false);
      setBinarySaveState('saved');
      setStorageError(null);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Не вдалося видалити документ.');
    }
  }, [activeBinaryDocument]);

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
      scrollPositionsRef.current.delete(activeNote.id);
      dirtyNoteIds.current.delete(activeNote.id);
      dirtyTitleNoteIds.current.delete(activeNote.id);
      const manager = managerRef.current;
      manager?.closeTab(`note:${activeNote.id}`);
      const remaining = notes.filter(note => note.id !== activeNote.id);
      if (remaining.length === 0) {
        const replacement = makeNote();
        await workspaceFileSystem.createDocument(replacement, replacement.path!);
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

  const handleScrollPositionChange = useCallback((documentId: string, position: DocumentScrollPosition) => {
    if (!notes.some(note => note.id === documentId)) return;
    scrollPositionsRef.current.set(documentId, position);
  }, [notes]);

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
              <button key={note.id} className={`tree-item note-item${!activeBinaryDocument && note.id === activeNote?.id ? ' selected' : ''}`} onClick={() => openNote(note)} title={note.title}>
                <Files size={16} /><span>{note.title || 'Без назви'}</span>
              </button>
            ))}
          </div>
          <div className="sidebar-heading documents-heading">
            <span>ДОКУМЕНТИ</span>
            <button className="icon-button" aria-label="Імпортувати документ" title="Імпортувати DOCX, XLSX, PPTX та інші підтримувані файли" onClick={() => fileInputRef.current?.click()} disabled={saveState === 'loading'}>
              <FileUp size={16} />
            </button>
          </div>
          <input ref={fileInputRef} className="workspace-file-input" type="file" accept=".docx,.xlsx,.pptx,.md,.html,.svg" aria-label="Файл для імпорту"
            onChange={event => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importBinaryDocument(file);
            }}
          />
          <div className="note-list document-list" role="list" aria-label="Список документів">
            {binaryDocuments.map(document => (
              <button key={document.id} className={`tree-item note-item${activeBinaryDocument?.id === document.id ? ' selected' : ''}`} onClick={() => void openBinaryDocument(document.id)} title={document.title}>
                <FileText size={16} /><span>{document.title}</span>
              </button>
            ))}
          </div>
          <div className="sidebar-footer"><span className="status-dot" />Лише локальне збереження</div>
        </aside>}
        <section className="document-area">
          {!activeBinaryDocument && <div className="document-tabs" role="tablist" aria-label="Відкриті документи">
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
          </div>}
          {activeBinaryDocument ? <>
            <div className="document-header">
              <div className="document-title-wrap">
                <div className="breadcrumb">Документи <span>/</span> Локальний робочий простір</div>
                <div className="document-title-text">{activeBinaryDocument.title}</div>
              </div>
              <div className="document-actions">
                <span className={`save-indicator ${binarySaveState}`} title={storageError ?? undefined}>
                  {binarySaveState === 'saving' ? <LoaderCircle size={14} /> : binarySaveState === 'error' ? <AlertCircle size={14} /> : <Check size={14} />}
                  {binarySaveState === 'saving' ? 'Збереження…' : binarySaveState === 'error' ? 'Помилка збереження' : binaryDirty ? 'Є незбережені зміни' : 'Збережено локально'}
                </span>
                <button className="icon-button delete-note-button" aria-label="Видалити документ" title="Видалити документ" onClick={() => void deleteActiveBinaryDocument()}><Trash2 size={16} /></button>
                <button className="icon-button" aria-label="Закрити документ" title="Закрити документ" onClick={() => { if (canLeaveBinaryDocument()) setActiveBinaryDocument(null); }}><X size={16} /></button>
              </div>
            </div>
            {activeBinaryDocument.title.toLowerCase().endsWith('.html') ? (
              <Suspense fallback={<div className="office-viewer-loading">Завантаження редактора HTML…</div>}>
                <HtmlDocumentViewer document={activeBinaryDocument} onSave={saveBinaryDocument} onDirtyChange={setBinaryDirty} onError={error => setStorageError(error.message)} />
              </Suspense>
            ) : (
              <Suspense fallback={<div className="office-viewer-loading">Завантаження редактора документа…</div>}>
                <OfficeDocumentViewer document={activeBinaryDocument} onSave={saveBinaryDocument} onDirtyChange={setBinaryDirty} onError={error => setStorageError(error.message)} />
              </Suspense>
            )}
          </> : activeNote ? <>
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
            <EditorWorkspace documentId={activeNote.id} editorStates={editorStatesRef.current} scrollPosition={scrollPositionsRef.current.get(activeNote.id)} onScrollPositionChange={handleScrollPositionChange} mode={mode} onModeChange={setMode} content={activeNote.content} onContentChange={handleEditorContentChange} />
          </> : <div className="empty-workspace">Виберіть нотатку або створіть нову</div>}
        </section>
      </div>
    </main>
  );
}
