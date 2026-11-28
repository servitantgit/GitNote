import { DocViewer } from '../../vendor/office-engine';
import type { BinaryDocumentRecord } from '../../core/domain/document-source';

interface Props {
  document: BinaryDocumentRecord;
  onSave: (content: Blob) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onError: (error: Error) => void;
}

export function OfficeDocumentViewer({ document, onSave, onDirtyChange, onError }: Props) {
  return (
    <div className="office-document-viewer" data-testid="office-document-viewer">
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
