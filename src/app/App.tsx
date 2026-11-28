import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorState } from '@codemirror/state';
import type { DocumentScrollPosition } from '../modules/editor/navigation/scroll-position';
import { GitBranch, Paperclip, Search, Settings, Plus, FolderPlus, Upload, PanelLeftClose, Trash2, Check, AlertCircle, LoaderCircle, X, LockKeyhole } from 'lucide-react';
import { EditorWorkspace } from '../modules/editor/EditorWorkspace';
import type { EditorMode } from '../modules/editor/types';
import { workspaceStore } from '../infrastructure/storage/database';
import type { BinaryDocumentRecord, DocumentRecord } from '../core/domain/document-source';
import { binaryDocumentSource, documentSource } from '../infrastructure/storage/local-document-source';
import { workspaceFileSystem } from '../infrastructure/storage/local-workspace-file-system';
import { validateWorkspaceName, type WorkspaceFileNode } from '../core/domain/workspace-file-system';
import { WorkspaceFileTree } from '../modules/workspace/WorkspaceFileTree';
import { detectDocumentFormat } from '../core/domain/document-format';
import { DocumentActions } from '../modules/documents/DocumentActions';
import { downloadDocument } from '../modules/documents/document-download';
import { printMarkdownDocument } from '../modules/documents/markdown-print';
import { WorkspaceManager, workspaceTabDocumentId, workspaceTabDocumentType, type WorkspaceSnapshot } from '../core/domain/workspace';
import './app.css';

const LOCAL_REPOSITORY_ID = 'local-workspace';
const LOCAL_REPOSITORY = { id: LOCAL_REPOSITORY_ID, owner: 'local', name: 'Локальний робочий простір', defaultBranch: 'main' };
const INITIAL_CONTENT = '# Моя перша нотатка\n\nGitNotes — робочий простір для нотаток і документів із Git-контролем версій.\n\n- Source: редагування Markdown\n- Live: Source і Preview поруч із синхронізованою прокруткою\n- Preview: режим читання';

async function listWorkspaceTree(parentPath = ''): Promise<WorkspaceFileNode[]> {
  const children = await workspaceFileSystem.list(LOCAL_REPOSITORY_ID, parentPath);
  const nested = await Promise.all(children.filter(node => node.kind === 'folder').map(node => listWorkspaceTree(node.path)));
  return [...children, ...nested.flat()];
}

const OfficeDocumentViewer = lazy(() => import('../modules/documents/OfficeDocumentViewer').then(module => ({ default: module.OfficeDocumentViewer })));
const HtmlDocumentViewer = lazy(() => import('../modules/documents/html/HtmlDocumentViewer').then(module => ({ default: module.HtmlDocumentViewer })));
const PdfDocumentViewer = lazy(() => import('../modules/documents/PdfDocumentViewer').then(module => ({ default: module.PdfDocumentViewer })));

type SaveState = 'loading' | 'saved' | 'saving' | 'error';

function makeNote(title = 'Без назви', content = '', parentPath = ''): DocumentRecord {
  const now = Date.now();
  const id = crypto.randomUUID();
  return { id, repositoryId: LOCAL_REPOSITORY_ID, title, content, path: parentPath ? `${parentPath}/${id}.md` : `${id}.md`, syncState: 'local', createdAt: now, updatedAt: now };
}

function tabForNote(note: DocumentRecord) {
  return { id: `note:${note.id}`, repositoryId: note.repositoryId, branch: 'main', documentType: 'note' as const, documentId: note.id, noteId: note.id, title: note.title || 'Без назви', openedAt: Date.now() };
}

function tabForBinary(document: Pick<BinaryDocumentRecord, 'id' | 'repositoryId' | 'title'>) {
  return { id: `binary:${document.id}`, repositoryId: document.repositoryId, branch: 'main', documentType: 'binary' as const, documentId: document.id, title: document.title, openedAt: Date.now() };
}

export function App() {
  const [mode, setMode] = useState<EditorMode>('source');
  const [notes, setNotes] = useState<DocumentRecord[]>([]);
  const [fileNodes, setFileNodes] = useState<WorkspaceFileNode[]>([]);
  const [selectedFolderPath, setSelectedFolderPath] = useState('');
  const [binaryDocumentRecords, setBinaryDocumentRecords] = useState<Record<string, BinaryDocumentRecord>>({});
  const [binaryUiState, setBinaryUiState] = useState<Record<string, { dirty: boolean; saveState: SaveState; printRequest: number; downloadRequest: number }>>({});
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
    () => activeTab && workspaceTabDocumentType(activeTab) === 'note'
      ? notes.find(note => note.id === workspaceTabDocumentId(activeTab)) ?? null
      : null,
    [notes, activeTab],
  );
  const activeBinaryDocument = activeTab && workspaceTabDocumentType(activeTab) === 'binary'
    ? binaryDocumentRecords[workspaceTabDocumentId(activeTab)] ?? null
    : null;
  const activeBinaryUi = activeBinaryDocument
    ? binaryUiState[activeBinaryDocument.id] ?? { dirty: false, saveState: 'saved' as SaveState, printRequest: 0, downloadRequest: 0 }
    : null;
  activeNoteIdRef.current = activeNote?.id ?? null;

  const persistWorkspace = useCallback((manager: WorkspaceManager) => {
    const snapshot = manager.getSnapshot();
    setWorkspace(snapshot);
    void workspaceStore.save(snapshot).catch(error => {
      setStorageError(error instanceof Error ? error.message : 'Не вдалося зберегти стан робочого простору.');
    });
  }, []);

  const refreshFileNodes = useCallback(async () => {
    setFileNodes(await listWorkspaceTree());
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
        const [documentMetas, savedWorkspace, binaryMetas] = await Promise.all([
          documentSource.list(),
          workspaceStore.get(),
          binaryDocumentSource.list(),
        ]);
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
        const validBinaryIds = new Set(binaryMetas.map(document => document.id));
        for (const tab of manager.getSnapshot().tabs) {
          if (tab.repositoryId !== LOCAL_REPOSITORY_ID) continue;
          const documentId = workspaceTabDocumentId(tab);
          const valid = workspaceTabDocumentType(tab) === 'note' ? validNoteIds.has(documentId) : validBinaryIds.has(documentId);
          if (!valid) manager.closeTab(tab.id);
        }
        const current = manager.getSnapshot();
        const activeExists = current.tabs.some(tab => tab.id === current.activeTabId);
        if (!activeExists && nextNotes[0]) manager.openTab(tabForNote(nextNotes[0]));
        const openedBinary = await Promise.all(current.tabs.filter(tab => workspaceTabDocumentType(tab) === 'binary')
          .map(tab => binaryDocumentSource.read(workspaceTabDocumentId(tab))));
        managerRef.current = manager;
        setNotes(nextNotes);
        setFileNodes(await listWorkspaceTree());
        setBinaryDocumentRecords(Object.fromEntries(openedBinary.map(document => [document.id, document])));
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
    const note = makeNote('Без назви', '', selectedFolderPath);
    try {
      await workspaceFileSystem.createDocument(note, note.path!);
      setNotes(current => [note, ...current]);
      await refreshFileNodes();
      openNote(note);
      setMode('source');
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Не вдалося створити нотатку.');
    }
  }, [openNote, refreshFileNodes, saveState, selectedFolderPath]);

  const createFolder = useCallback(async () => {
    const name = window.prompt('Назва нової папки');
    if (!name) return;
    try {
      await workspaceFileSystem.createFolder(LOCAL_REPOSITORY_ID, selectedFolderPath, name);
      await refreshFileNodes();
      setStorageError(null);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Не вдалося створити папку.');
    }
  }, [refreshFileNodes, selectedFolderPath]);

  const openBinaryDocument = useCallback(async (id: string) => {
    const manager = managerRef.current;
    if (!manager) return;
    try {
      let document = binaryDocumentRecords[id];
      if (!document) {
        document = await binaryDocumentSource.read(id);
        setBinaryDocumentRecords(current => ({ ...current, [id]: document! }));
      }
      manager.openTab(tabForBinary(document));
      persistWorkspace(manager);
      setBinaryUiState(current => ({ ...current, [id]: current[id] ?? { dirty: false, saveState: 'saved', printRequest: 0, downloadRequest: 0 } }));
      setStorageError(null);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Не вдалося відкрити документ.');
    }
  }, [binaryDocumentRecords, persistWorkspace]);

  const openFileNode = useCallback((node: WorkspaceFileNode) => {
    if (!node.documentId) return;
    const note = notes.find(item => item.id === node.documentId);
    if (note) openNote(note);
    else void openBinaryDocument(node.documentId);
  }, [notes, openNote, openBinaryDocument]);

  const importBinaryDocument = useCallback(async (file: File) => {
    try {
      const name = validateWorkspaceName(file.name);
      const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
      if (!['.docx', '.xlsx', '.pptx', '.md', '.html', '.svg', '.pdf'].includes(extension)) {
        throw new Error('Підтримуються формати DOCX, XLSX, PPTX, MD, HTML, SVG та PDF.');
      }
      const now = Date.now();
      const path = selectedFolderPath ? `${selectedFolderPath}/${name}` : name;
      const document: BinaryDocumentRecord = {
        id: crypto.randomUUID(), repositoryId: LOCAL_REPOSITORY_ID, title: name, path,
        content: file, mediaType: file.type || 'application/octet-stream', size: file.size,
        syncState: 'local', createdAt: now, updatedAt: now,
      };
      await workspaceFileSystem.createBinaryDocument(document, path);
      const stored = await binaryDocumentSource.read(document.id);
      await refreshFileNodes();
      setBinaryDocumentRecords(current => ({ ...current, [document.id]: stored }));
      const manager = managerRef.current;
      if (manager) { manager.openTab(tabForBinary(stored)); persistWorkspace(manager); }
      setBinaryUiState(current => ({ ...current, [document.id]: { dirty: false, saveState: 'saved', printRequest: 0, downloadRequest: 0 } }));
      setStorageError(null);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Не вдалося імпортувати документ.');
    }
  }, [persistWorkspace, refreshFileNodes, selectedFolderPath]);

  const saveBinaryDocument = useCallback(async (documentId: string, content: Blob) => {
    setBinaryUiState(current => ({ ...current, [documentId]: { ...(current[documentId] ?? { dirty: false, saveState: 'saved', printRequest: 0, downloadRequest: 0 }), saveState: 'saving' } }));
    try {
      await binaryDocumentSource.write(documentId, content);
      setBinaryUiState(current => ({ ...current, [documentId]: { ...(current[documentId] ?? { dirty: false, saveState: 'saved', printRequest: 0, downloadRequest: 0 }), dirty: false, saveState: 'saved' } }));
      setStorageError(null);
    } catch (error) {
      setBinaryUiState(current => ({ ...current, [documentId]: { ...(current[documentId] ?? { dirty: true, saveState: 'saved', printRequest: 0, downloadRequest: 0 }), saveState: 'error' } }));
      setStorageError(error instanceof Error ? error.message : 'Не вдалося зберегти документ.');
      throw error;
    }
  }, []);

  const deleteActiveBinaryDocument = useCallback(async () => {
    if (!activeBinaryDocument) return;
    if (!window.confirm(`Видалити документ «${activeBinaryDocument.title}» з локального сховища?`)) return;
    try {
      if (activeBinaryDocument.path) await workspaceFileSystem.remove(activeBinaryDocument.repositoryId, activeBinaryDocument.path);
      else await binaryDocumentSource.remove(activeBinaryDocument.id);
      const manager = managerRef.current;
      manager?.closeTab(`binary:${activeBinaryDocument.id}`);
      setBinaryDocumentRecords(current => { const next = { ...current }; delete next[activeBinaryDocument.id]; return next; });
      setBinaryUiState(current => { const next = { ...current }; delete next[activeBinaryDocument.id]; return next; });
      if (manager) persistWorkspace(manager);
      await refreshFileNodes();
      setStorageError(null);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Не вдалося видалити документ.');
    }
  }, [activeBinaryDocument, persistWorkspace, refreshFileNodes]);

  const closeTab = useCallback((tabId: string) => {
    const manager = managerRef.current;
    if (!manager) return;
    const tab = manager.getSnapshot().tabs.find(item => item.id === tabId);
    if (tab && workspaceTabDocumentType(tab) === 'binary') {
      const documentId = workspaceTabDocumentId(tab);
      if (binaryUiState[documentId]?.dirty && !window.confirm('Документ має незбережені зміни. Закрити вкладку та відкинути їх?')) return;
      setBinaryDocumentRecords(current => { const next = { ...current }; delete next[documentId]; return next; });
      setBinaryUiState(current => { const next = { ...current }; delete next[documentId]; return next; });
    }
    manager.closeTab(tabId);
    if (!manager.getSnapshot().activeTabId) {
      const fallback = notes.find(note => `note:${note.id}` !== tabId);
      if (fallback) manager.openTab(tabForNote(fallback));
    }
    persistWorkspace(manager);
  }, [binaryUiState, notes, persistWorkspace]);

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
      await refreshFileNodes();
      setStorageError(null);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Не вдалося видалити нотатку.');
    }
  }, [activeNote, notes, persistWorkspace, refreshFileNodes]);

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
  const activeBinaryFormat = activeBinaryDocument
    ? detectDocumentFormat(activeBinaryDocument.title, activeBinaryDocument.mediaType).id
    : null;

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
          <div className="sidebar-heading workspace-tree-heading">
            <span>РОБОЧИЙ ПРОСТІР</span>
            <div className="sidebar-tree-actions">
              <button className="icon-button" aria-label="Створити нотатку" title="Створити нотатку в обраній папці" onClick={createNote} disabled={saveState === 'loading'}><Plus size={16} /></button>
              <button className="icon-button" aria-label="Створити папку" title="Створити вкладену папку" onClick={() => void createFolder()} disabled={saveState === 'loading'}><FolderPlus size={16} /></button>
              <button className="icon-button" aria-label="Імпортувати документ" title="Імпортувати файл в обрану папку" onClick={() => fileInputRef.current?.click()} disabled={saveState === 'loading'}><Upload size={16} /></button>
            </div>
          </div>
          <input ref={fileInputRef} className="workspace-file-input" type="file" accept=".docx,.xlsx,.pptx,.md,.html,.svg,.pdf" aria-label="Файл для імпорту"
            onChange={event => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importBinaryDocument(file);
            }}
          />
          <WorkspaceFileTree
            nodes={fileNodes}
            selectedPath={selectedFolderPath}
            onSelectFolder={setSelectedFolderPath}
            onOpenFile={openFileNode}
          />
          <div className="sidebar-footer"><span className="status-dot" />Лише локальне збереження</div>
        </aside>}
        <section className="document-area">
          <div className="document-tabs" role="tablist" aria-label="Відкриті документи">
            {workspace?.tabs.map(tab => {
              const documentId = workspaceTabDocumentId(tab); const isNote = workspaceTabDocumentType(tab) === 'note';
              const note = isNote ? notes.find(item => item.id === documentId) : null;
              const binary = !isNote ? binaryDocumentRecords[documentId] : null;
              const title = note?.title || binary?.title || tab.title || 'Без назви'; const inactive = tab.repositoryId !== activeRepositoryId;
              return <div className={`document-tab${tab.id === workspace.activeTabId ? ' active' : ''}${inactive ? ' inactive' : ''}`} key={tab.id}>
                <button role="tab" aria-selected={tab.id === workspace.activeTabId} onClick={() => { managerRef.current?.selectTab(tab.id); if (managerRef.current) persistWorkspace(managerRef.current); }} title={inactive ? 'Репозиторій не активний. Локальне редагування доступне.' : title}>{inactive && <LockKeyhole size={12} />}<span>{title}</span>{binaryUiState[documentId]?.dirty && <span aria-label="Є незбережені зміни">•</span>}</button>
                <button className="tab-close" aria-label="Закрити вкладку" title={`Закрити ${title}`} onClick={() => closeTab(tab.id)}><X size={13} /></button>
              </div>;
            })}
          </div>
          {activeBinaryDocument && activeBinaryUi && <div className="document-header"><div className="document-title-wrap"><div className="breadcrumb">Документи <span>/</span> Локальний робочий простір</div><div className="document-title-text">{activeBinaryDocument.title}</div></div><div className="document-actions">
            <span className={`save-indicator ${activeBinaryUi.saveState}`} title={storageError ?? undefined}>{activeBinaryUi.saveState === 'saving' ? <LoaderCircle size={14} /> : activeBinaryUi.saveState === 'error' ? <AlertCircle size={14} /> : <Check size={14} />}{activeBinaryUi.saveState === 'saving' ? 'Збереження…' : activeBinaryUi.saveState === 'error' ? 'Помилка збереження' : activeBinaryUi.dirty ? 'Є незбережені зміни' : 'Збережено локально'}</span>
            <DocumentActions onDownload={() => { if (activeBinaryFormat === 'pdf' || activeBinaryFormat === 'image') downloadDocument(activeBinaryDocument.content, activeBinaryDocument.title); else setBinaryUiState(current => { const state = current[activeBinaryDocument.id] ?? activeBinaryUi; return { ...current, [activeBinaryDocument.id]: { ...state, downloadRequest: state.downloadRequest + 1 } }; }); }} onPrint={() => setBinaryUiState(current => { const state = current[activeBinaryDocument.id] ?? activeBinaryUi; return { ...current, [activeBinaryDocument.id]: { ...state, printRequest: state.printRequest + 1 } }; })} />
            <button className="icon-button delete-note-button" aria-label="Видалити документ" title="Видалити документ" onClick={() => void deleteActiveBinaryDocument()}><Trash2 size={16} /></button>
          </div></div>}
          {activeNote && <div className="document-header"><div className="document-title-wrap"><div className="breadcrumb">Нотатки <span>/</span> {activeTabRepository?.name ?? 'Репозиторій'}</div><input className="document-title-input" aria-label="Назва нотатки" value={activeNote.title} onChange={event => updateActiveNote({ title: event.target.value })} placeholder="Без назви" /></div><div className="document-actions">
            <span className={`save-indicator ${saveState}`} title={storageError ?? saveLabel}>{saveState === 'saving' ? <LoaderCircle size={14} /> : saveState === 'error' ? <AlertCircle size={14} /> : <Check size={14} />}{saveLabel}</span>
            <DocumentActions onDownload={() => downloadDocument(new Blob([activeNote.content], { type: 'text/markdown;charset=utf-8' }), `${activeNote.title || 'Без назви'}.md`)} onPrint={() => { void printMarkdownDocument(activeNote.content, activeNote.title || 'Без назви').catch(error => setStorageError(error instanceof Error ? error.message : 'Не вдалося надрукувати нотатку.')); }} />
            {!remoteAllowed && <span className="local-only-indicator" title="Віддалені Git-операції для цього репозиторію вимкнені"><LockKeyhole size={13} />Локально</span>}<button className="icon-button delete-note-button" aria-label="Видалити нотатку" title="Видалити нотатку" onClick={() => void deleteActiveNote()}><Trash2 size={16} /></button><button className="attachment-button" disabled title="Вкладення будуть додані окремим модулем"><Paperclip size={16} />Вкладені файли</button>
          </div></div>}
          <div className="workspace-document-stack">
            {workspace?.tabs.filter(tab => workspaceTabDocumentType(tab) === 'binary').map(tab => {
              const documentId = workspaceTabDocumentId(tab); const document = binaryDocumentRecords[documentId]; if (!document) return null;
              const format = detectDocumentFormat(document.title, document.mediaType).id;
              const ui = binaryUiState[documentId] ?? { dirty: false, saveState: 'saved' as SaveState, printRequest: 0, downloadRequest: 0 };
              const active = tab.id === workspace.activeTabId; const save = (content: Blob) => saveBinaryDocument(documentId, content);
              const dirty = (value: boolean) => setBinaryUiState(current => ({ ...current, [documentId]: { ...(current[documentId] ?? ui), dirty: value } }));
              const error = (value: Error) => setStorageError(value.message);
              return <div key={tab.id} className="workspace-document-panel" style={{ display: active ? 'flex' : 'none' }} aria-hidden={!active}>
                {format === 'pdf' ? <Suspense fallback={<div className="office-viewer-loading">Завантаження переглядача PDF…</div>}><PdfDocumentViewer document={document} printRequest={ui.printRequest} /></Suspense>
                  : format === 'html' ? <Suspense fallback={<div className="office-viewer-loading">Завантаження редактора HTML…</div>}><HtmlDocumentViewer document={document} onSave={save} onDirtyChange={dirty} onError={error} printRequest={ui.printRequest} downloadRequest={ui.downloadRequest} /></Suspense>
                    : <Suspense fallback={<div className="office-viewer-loading">Завантаження редактора документа…</div>}><OfficeDocumentViewer document={document} onSave={save} onDirtyChange={dirty} onError={error} printRequest={ui.printRequest} downloadRequest={ui.downloadRequest} /></Suspense>}
              </div>;
            })}
            {activeNote && <div className="workspace-document-panel"><EditorWorkspace documentId={activeNote.id} editorStates={editorStatesRef.current} scrollPosition={scrollPositionsRef.current.get(activeNote.id)} onScrollPositionChange={handleScrollPositionChange} mode={mode} onModeChange={setMode} content={activeNote.content} onContentChange={handleEditorContentChange} /></div>}
            {!activeNote && !activeBinaryDocument && <div className="empty-workspace">Виберіть нотатку або створіть нову</div>}
          </div>
        </section>
      </div>
    </main>
  );
}
