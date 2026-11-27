import type { DocumentMeta, MutableDocumentSource } from '../../core/domain/document-source';
import { database } from './database';

/** IndexedDB implementation. It never performs network or Git operations. */
export class LocalIndexedDbDocumentSource implements MutableDocumentSource {
  async list(): Promise<DocumentMeta[]> {
    const notes = await database.notes.orderBy('updatedAt').reverse().toArray();
    return notes.map(({ content: _content, ...meta }) => meta);
  }

  async read(id: string): Promise<{ content: string; baseSha?: string }> {
    const note = await database.notes.get(id);
    if (!note) throw new Error(`Document not found: ${id}`);
    return { content: note.content, baseSha: note.baseSha };
  }

  async write(id: string, content: string, baseSha?: string): Promise<{ sha?: string }> {
    const note = await database.notes.get(id);
    if (!note) throw new Error(`Document not found: ${id}`);
    note.content = content;
    if (baseSha !== undefined) note.baseSha = baseSha;
    note.syncState = note.path
      ? note.syncState === 'conflict' ? 'conflict' : 'dirty'
      : 'local';
    note.updatedAt = Date.now();
    await database.notes.put(note);
    return {};
  }

  async remove(id: string): Promise<void> {
    await database.notes.delete(id);
  }

  async create(meta: DocumentMeta, content: string): Promise<void> {
    await database.notes.add({ ...meta, content });
  }

  async rename(id: string, title: string): Promise<void> {
    const note = await database.notes.get(id);
    if (!note) throw new Error(`Document not found: ${id}`);
    note.title = title;
    note.updatedAt = Date.now();
    await database.notes.put(note);
  }
}

export const documentSource = new LocalIndexedDbDocumentSource();
