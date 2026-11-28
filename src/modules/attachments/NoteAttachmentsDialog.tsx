import { useEffect, useRef, useState } from 'react';
import { Download, FilePlus2, Paperclip, Trash2, X } from 'lucide-react';
import type { DocumentAttachmentRecord } from '../../core/domain/document-source';
import { noteAttachmentStore } from '../../infrastructure/storage/local-note-attachment-store';
import { downloadDocument } from '../documents/document-download';
import './attachments.css';

interface Props { noteId: string; noteTitle: string; onClose: () => void; }

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} ГБ`;
}

export function NoteAttachmentsDialog({ noteId, noteTitle, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [attachments, setAttachments] = useState<DocumentAttachmentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() { setAttachments(await noteAttachmentStore.list(noteId)); }

  useEffect(() => {
    let cancelled = false;
    void noteAttachmentStore.list(noteId).then(items => {
      if (!cancelled) setAttachments(items);
    }).catch(cause => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : 'Не вдалося завантажити вкладення.');
    }).finally(() => { if (!cancelled) setLoading(false); });
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => { cancelled = true; window.removeEventListener('keydown', onKeyDown); };
  }, [noteId, onClose]);

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true); setError(null);
    try {
      for (const file of Array.from(files)) await noteAttachmentStore.add(noteId, file);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не вдалося додати вкладення.');
      await refresh();
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function removeAttachment(attachment: DocumentAttachmentRecord) {
    if (!window.confirm(`Видалити вкладення «${attachment.name}»?`)) return;
    setBusy(true); setError(null);
    try {
      await noteAttachmentStore.remove(attachment.id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не вдалося видалити вкладення.');
    } finally { setBusy(false); }
  }

  return (
    <div className="attachments-overlay" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="attachments-dialog" role="dialog" aria-modal="true" aria-labelledby="attachments-title">
        <header className="attachments-header">
          <div>
            <h2 id="attachments-title"><Paperclip size={18} />Вкладені файли</h2>
            <p title={noteTitle}>{noteTitle || 'Без назви'}</p>
          </div>
          <button type="button" className="icon-button" aria-label="Закрити вкладення" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="attachments-toolbar">
          <button type="button" className="attachments-add-button" onClick={() => inputRef.current?.click()} disabled={busy}><FilePlus2 size={16} />Додати файли</button>
          <input ref={inputRef} type="file" multiple aria-label="Файли для вкладення" className="attachments-file-input" onChange={event => void addFiles(event.currentTarget.files)} />
          <span>{attachments.length} {attachments.length === 1 ? 'файл' : attachments.length >= 2 && attachments.length <= 4 ? 'файли' : 'файлів'}</span>
        </div>
        {error && <p className="attachments-error" role="alert">{error}</p>}
        {loading ? <p className="attachments-empty">Завантаження…</p> : attachments.length === 0
          ? <div className="attachments-empty"><Paperclip size={24} /><p>До цієї нотатки ще не додано файлів</p></div>
          : <ul className="attachments-list">{attachments.map(attachment => (
            <li key={attachment.id} className="attachment-item" data-testid="attachment-item">
              <div className="attachment-info"><strong title={attachment.name}>{attachment.name}</strong><span>{formatSize(attachment.size)} · {attachment.mediaType}</span></div>
              <div className="attachment-actions">
                <button type="button" className="icon-button" aria-label={`Завантажити ${attachment.name}`} title="Завантажити" onClick={() => downloadDocument(attachment.content, attachment.name)}><Download size={16} /></button>
                <button type="button" className="icon-button" aria-label={`Видалити вкладення ${attachment.name}`} title="Видалити" onClick={() => void removeAttachment(attachment)} disabled={busy}><Trash2 size={16} /></button>
              </div>
            </li>
          ))}</ul>}
        <footer className="attachments-footer"><button type="button" onClick={onClose}>Закрити</button></footer>
      </section>
    </div>
  );
}
