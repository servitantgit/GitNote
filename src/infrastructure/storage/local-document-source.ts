import type { BinaryDocumentRecord, BinaryDocumentSource, DocumentMeta, MutableDocumentSource } from '../../core/domain/document-source';
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
    // This adapter represents local storage, not a remote Git working tree.
    note.syncState = note.syncState === 'conflict' ? 'conflict' : 'local';
    note.updatedAt = Math.max(Date.now(), note.updatedAt + 1);
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
    note.updatedAt = Math.max(Date.now(), note.updatedAt + 1);
    await database.notes.put(note);
  }
}

export const documentSource: MutableDocumentSource = new LocalIndexedDbDocumentSource();

/** IndexedDB storage for binary documents; content stays as a Blob, never decoded as text. */
export class LocalIndexedDbBinaryDocumentSource implements BinaryDocumentSource {
  async list(): Promise<Omit<BinaryDocumentRecord, 'content'>[]> {
    const documents = await database.binaryDocuments.orderBy('updatedAt').reverse().toArray();
    return documents.map(({ content: _content, ...meta }) => meta);
  }

  async read(id: string): Promise<BinaryDocumentRecord> {
    const document = await database.binaryDocuments.get(id);
    if (!document) throw new Error(`Binary document not found: ${id}`);
    return document;
  }

  async write(id: string, content: Blob, baseSha?: string): Promise<{ sha?: string }> {
    const document = await database.binaryDocuments.get(id);
    if (!document) throw new Error(`Binary document not found: ${id}`);
    document.content = content;
    document.size = content.size;
    document.mediaType = content.type || document.mediaType;
    if (baseSha !== undefined) document.baseSha = baseSha;
    document.syncState = document.syncState === 'conflict' ? 'conflict' : 'local';
    document.updatedAt = Math.max(Date.now(), document.updatedAt + 1);
    await database.binaryDocuments.put(document);
    return {};
  }

  async remove(id: string): Promise<void> {
    await database.binaryDocuments.delete(id);
  }

  async create(document: BinaryDocumentRecord): Promise<void> {
    await database.binaryDocuments.add(document);
  }
}

export const binaryDocumentSource: BinaryDocumentSource = new LocalIndexedDbBinaryDocumentSource();
