import type { DocumentAttachmentRecord } from '../../core/domain/document-source';
import { validateWorkspaceName } from '../../core/domain/workspace-file-system';
import { database } from './database';

/** Local, note-owned binary attachments. This store never contacts the network. */
export const noteAttachmentStore = {
  async list(noteId: string): Promise<DocumentAttachmentRecord[]> {
    return database.noteAttachments.where('noteId').equals(noteId).sortBy('createdAt');
  },
  async add(noteId: string, file: File): Promise<DocumentAttachmentRecord> {
    const name = validateWorkspaceName(file.name);
    return database.transaction('rw', database.notes, database.noteAttachments, async () => {
      if (!(await database.notes.get(noteId))) throw new Error('Батьківську нотатку не знайдено.');
      const id = crypto.randomUUID();
      const now = Date.now();
      const attachment: DocumentAttachmentRecord = {
        id, noteId, name, path: `${id}/${name}`,
        content: file.slice(0, file.size, file.type || 'application/octet-stream'),
        mediaType: file.type || 'application/octet-stream', size: file.size, createdAt: now, updatedAt: now,
      };
      await database.noteAttachments.add(attachment);
      return attachment;
    });
  },
  async read(id: string): Promise<DocumentAttachmentRecord> {
    const attachment = await database.noteAttachments.get(id);
    if (!attachment) throw new Error('Вкладення не знайдено.');
    return attachment;
  },
  async remove(id: string): Promise<void> { await database.noteAttachments.delete(id); },
};
