import { useEffect, useRef } from 'react';
import { DocViewer } from '@p10node/office-engine';
import type { BinaryDocumentRecord } from '../../../core/domain/document-source';
import { connectHtmlScrollSurfaces } from './html-scroll-sync';

interface Props {
  document: BinaryDocumentRecord;
  onSave: (content: Blob) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onError: (error: Error) => void;
}

export function HtmlDocumentViewer({ document, onSave, onDirtyChange, onError }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let detach: (() => void) | null = null;
    let source: HTMLElement | null = null;
    let preview: HTMLElement | null = null;

    const connect = () => {
      const nextSource = root.querySelector<HTMLElement>('.de-src-scroll');
      const nextPreview = root.querySelector<HTMLElement>('.de-main .de-scroll');
      if (nextSource === source && nextPreview === preview) return;

      detach?.();
      detach = null;
      source = nextSource;
      preview = nextPreview;
      if (source && preview) detach = connectHtmlScrollSurfaces(source, preview);
    };

    connect();
    const observer = new MutationObserver(connect);
    observer.observe(root, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      detach?.();
    };
  }, [document.id]);

  return (
    <div
      ref={rootRef}
      className="html-document-viewer"
      data-testid="html-document-viewer"
      style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden' }}
    >
      <DocViewer
        src={document.content}
        name={document.title}
        editable
        allowSave
        allowDownload={false}
        fileMenu={false}
        onSave={content => onSave(content)}
        onDirtyChange={onDirtyChange}
        onError={onError}
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
}
