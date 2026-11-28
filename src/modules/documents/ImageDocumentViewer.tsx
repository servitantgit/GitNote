import { useEffect, useState } from 'react';
import type { BinaryDocumentRecord } from '../../core/domain/document-source';

interface Props { document: BinaryDocumentRecord; }

/** Read-only viewer for image files stored as ordinary workspace documents. */
export function ImageDocumentViewer({ document }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(document.content);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [document.id, document.content]);
  return (
    <div className="image-document-viewer" role="region" aria-label="Перегляд зображення"
      style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'auto', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      {src ? <img src={src} alt={document.title} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} /> : <span>Завантаження зображення…</span>}
    </div>
  );
}
