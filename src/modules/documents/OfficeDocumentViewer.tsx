import { useEffect, useMemo, useRef } from 'react';
import { createViewerController, DocViewer, useViewerState } from '../../vendor/office-engine';
import type { BinaryDocumentRecord } from '../../core/domain/document-source';
import { downloadDocument } from './document-download';

interface Props {
  document: BinaryDocumentRecord;
  onSave: (content: Blob) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onError: (error: Error) => void;
  printRequest: number;
  downloadRequest: number;
}

export function OfficeDocumentViewer({ document, onSave, onDirtyChange, onError, printRequest, downloadRequest }: Props) {
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

  return (
    <div className="office-document-viewer" data-testid="office-document-viewer">
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
