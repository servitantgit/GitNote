import Dexie, { type EntityTable } from 'dexie';
import type { WorkspaceSnapshot } from '../../core/domain/workspace';
import type { BinaryDocumentRecord, DocumentRecord } from '../../core/domain/document-source';
import { normalizeWorkspacePath, type WorkspaceFileNode } from '../../core/domain/workspace-file-system';

export interface LocalDraft {
  id: string;
  repositoryId: string;
  path: string;
  content: string;
  updatedAt: number;
}

export type LocalNote = DocumentRecord;

interface StoredWorkspace {
  id: string;
  snapshot: WorkspaceSnapshot;
  updatedAt: number;
}

export interface LocalSearchDocument {
  id: string;
  documentType: 'note' | 'binary';
  title: string;
  path?: string;
  format: string;
  text: string;
  /** Unique lower-case trigrams used by the multi-entry IndexedDB index. */
  grams: string[];
  /** Source document timestamp used to detect stale extracted text. */
  sourceUpdatedAt: number;
}

class GitNotesDatabase extends Dexie {
  drafts!: EntityTable<LocalDraft, 'id'>;
  notes!: EntityTable<LocalNote, 'id'>;
  workspaces!: EntityTable<StoredWorkspace, 'id'>;
  fileNodes!: EntityTable<WorkspaceFileNode, 'id'>;
  binaryDocuments!: EntityTable<BinaryDocumentRecord, 'id'>;
  searchDocuments!: EntityTable<LocalSearchDocument, 'id'>;

  constructor() {
    // Keep the existing database name so previously saved GitNote notes remain accessible.
    super('gitnote-local');
    this.version(1).stores({ drafts: 'id, repositoryId, path, updatedAt' });
    this.version(2).stores({
      drafts: 'id, repositoryId, path, updatedAt',
      notes: 'id, repositoryId, title, createdAt, updatedAt',
    });
    this.version(3).stores({
      drafts: 'id, repositoryId, path, updatedAt',
      notes: 'id, repositoryId, title, createdAt, updatedAt',
      workspaces: 'id, updatedAt',
    });
    this.version(4).stores({
      drafts: 'id, repositoryId, path, updatedAt',
      notes: 'id, repositoryId, title, createdAt, updatedAt, path, syncState',
      workspaces: 'id, updatedAt',
    }).upgrade(transaction => transaction.table('notes').toCollection().modify(note => {
      if (!note.syncState) note.syncState = 'local';
    }));
    this.version(5).stores({
      drafts: 'id, repositoryId, path, updatedAt',
      notes: 'id, repositoryId, title, createdAt, updatedAt, path, syncState',
      workspaces: 'id, updatedAt',
      fileNodes: 'id, repositoryId, [repositoryId+path], [repositoryId+parentPath], [repositoryId+kind], documentId',
    }).upgrade(async transaction => {
      const notesTable = transaction.table('notes');
      const nodesTable = transaction.table('fileNodes');
      const notes = await notesTable.toArray();
      const folders = new Map<string, WorkspaceFileNode>();
      const occupied = new Set<string>();
      const now = Date.now();

      for (const note of notes) {
        const repositoryId = note.repositoryId;
        const title = typeof note.title === 'string' && note.title.trim() ? note.title.trim() : 'Без назви';
        const slug = title.normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'note';
        const rawPath = typeof note.path === 'string' && note.path.trim()
          ? note.path
          : `Notes/${slug}-${String(note.id).slice(0, 8)}.md`;
        let path: string;
        try {
          path = normalizeWorkspacePath(rawPath);
          if (!path) throw new Error('Empty document path.');
        } catch {
          path = `Notes/${slug}-${String(note.id)}.md`;
        }
        let key = `${repositoryId}:${path}`;
        if (occupied.has(key)) path = `Notes/${slug}-${String(note.id)}.md`;
        key = `${repositoryId}:${path}`;
        let collisionSuffix = 1;
        while (occupied.has(key)) {
          path = `Notes/${slug}-${String(note.id)}-${collisionSuffix}.md`;
          key = `${repositoryId}:${path}`;
          collisionSuffix += 1;
        }
        occupied.add(key);

        const segments = path.split('/');
        let parentPath = '';
        for (const segment of segments.slice(0, -1)) {
          const folderPath = parentPath ? `${parentPath}/${segment}` : segment;
          const folderKey = `${repositoryId}:${folderPath}`;
          if (!folders.has(folderKey)) {
            const folder: WorkspaceFileNode = {
              id: `migration-folder:${repositoryId}:${folderPath}`,
              repositoryId,
              path: folderPath,
              parentPath,
              name: segment,
              kind: 'folder',
              createdAt: now,
              updatedAt: now,
            };
            folders.set(folderKey, folder);
          }
          parentPath = folderPath;
        }

        const file: WorkspaceFileNode = {
          id: `migration-file:${note.id}`,
          repositoryId,
          path,
          parentPath,
          name: segments[segments.length - 1],
          kind: 'file',
          documentId: note.id,
          createdAt: note.createdAt ?? now,
          updatedAt: note.updatedAt ?? now,
        };
        note.path = path;
        if (!note.syncState) note.syncState = 'local';
        await notesTable.put(note);
        await nodesTable.put(file);
      }

      if (folders.size) await nodesTable.bulkPut([...folders.values()]);
    });
    this.version(6).stores({
      drafts: 'id, repositoryId, path, updatedAt',
      notes: 'id, repositoryId, title, createdAt, updatedAt, path, syncState',
      workspaces: 'id, updatedAt',
      fileNodes: 'id, repositoryId, [repositoryId+path], [repositoryId+parentPath], [repositoryId+kind], documentId',
      binaryDocuments: 'id, repositoryId, title, createdAt, updatedAt, path, syncState',
    });
    this.version(7).stores({
      drafts: 'id, repositoryId, path, updatedAt',
      notes: 'id, repositoryId, title, createdAt, updatedAt, path, syncState',
      workspaces: 'id, updatedAt',
      fileNodes: 'id, repositoryId, [repositoryId+path], [repositoryId+parentPath], [repositoryId+kind], documentId',
      binaryDocuments: 'id, repositoryId, title, createdAt, updatedAt, path, syncState',
      searchDocuments: 'id, documentType, sourceUpdatedAt, *grams',
    });
  }
}

export const database = new GitNotesDatabase();

export const draftStore = {
  async save(draft: LocalDraft): Promise<void> { await database.drafts.put(draft); },
  async get(id: string): Promise<LocalDraft | undefined> { return database.drafts.get(id); },
  async listForRepository(repositoryId: string): Promise<LocalDraft[]> {
    return database.drafts.where('repositoryId').equals(repositoryId).toArray();
  },
  async remove(id: string): Promise<void> { await database.drafts.delete(id); },
};

/** Local-first note storage. This store never contacts GitHub. */
export const noteStore = {
  async list(repositoryId: string): Promise<LocalNote[]> {
    return database.notes.where('repositoryId').equals(repositoryId).sortBy('updatedAt').then(notes => notes.reverse());
  },
  async get(id: string): Promise<LocalNote | undefined> { return database.notes.get(id); },
  async save(note: LocalNote): Promise<void> { await database.notes.put(note); },
  async remove(id: string): Promise<void> { await database.notes.delete(id); },
};

/** Persists open tabs and repository workspace state locally. */
export const workspaceStore = {
  async get(): Promise<WorkspaceSnapshot | undefined> {
    return (await database.workspaces.get('default'))?.snapshot;
  },
  async save(snapshot: WorkspaceSnapshot): Promise<void> {
    await database.workspaces.put({ id: 'default', snapshot, updatedAt: Date.now() });
  },
};
