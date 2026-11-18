import Dexie, { type EntityTable } from 'dexie';

export interface LocalDraft {
  id: string;
  repositoryId: string;
  path: string;
  content: string;
  updatedAt: number;
}

export interface LocalNote {
  id: string;
  repositoryId: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

class GitNoteDatabase extends Dexie {
  drafts!: EntityTable<LocalDraft, 'id'>;
  notes!: EntityTable<LocalNote, 'id'>;

  constructor() {
    super('gitnote-local');
    this.version(1).stores({ drafts: 'id, repositoryId, path, updatedAt' });
    this.version(2).stores({
      drafts: 'id, repositoryId, path, updatedAt',
      notes: 'id, repositoryId, title, createdAt, updatedAt',
    });
  }
}

export const database = new GitNoteDatabase();

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
  async get(id: string): Promise<LocalNote | undefined> {
    return database.notes.get(id);
  },
  async save(note: LocalNote): Promise<void> {
    await database.notes.put(note);
  },
  async remove(id: string): Promise<void> {
    await database.notes.delete(id);
  },
};
