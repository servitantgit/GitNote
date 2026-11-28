import { useEffect, useMemo, useRef } from 'react';
import { createViewerController, DocViewer, useViewerState } from '../../../vendor/office-engine';
import type { BinaryDocumentRecord } from '../../../core/domain/document-source';
import { connectHtmlScrollSurfaces } from './html-scroll-sync';
import { downloadDocument } from '../document-download';

interface Props {
  document: BinaryDocumentRecord;
  onSave: (content: Blob) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onError: (error: Error) => void;
  printRequest: number;
  downloadRequest: number;
}

export function HtmlDocumentViewer({ document, onSave, onDirtyChange, onError, printRequest, downloadRequest }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const controller = useMemo(() => createViewerController(), []);
  const viewerState = useViewerState(controller);
  const savedBlob = useRef<Blob | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (printRequest > 0 && !viewerState.loading && viewerState.kind) controller.print();
  }, [controller, printRequest, viewerState.loading, viewerState.kind]);

  useEffect(() => {
    if (downloadRequest === 0 || viewerState.loading || !viewerState.kind) return;
    void controller.save().then(() => {
      if (savedBlob.current) downloadDocument(savedBlob.current, document.title);
    }).catch(error => onErrorRef.current(error instanceof Error ? error : new Error(String(error))));
  }, [controller, downloadRequest, document.title, viewerState.loading, viewerState.kind]);

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
        allowDownload
        fileMenu={false}
        controller={controller}
        onSave={async content => {
          savedBlob.current = content;
          await onSave(content);
        }}
        onDirtyChange={onDirtyChange}
        onError={onError}
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
}
