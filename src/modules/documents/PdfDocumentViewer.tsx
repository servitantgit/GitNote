import { useEffect, useRef, useState } from 'react';
import type { BinaryDocumentRecord } from '../../core/domain/document-source';

interface Props {
  document: BinaryDocumentRecord;
  printRequest: number;
}

/** Read-only PDF surface backed by the browser's native PDF viewer. */
export function PdfDocumentViewer({ document, printRequest }: Props) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const loadedRef = useRef(false);
  const pendingPrintRef = useRef(false);
  const [url, setUrl] = useState('');

  useEffect(() => {
    const nextUrl = URL.createObjectURL(document.content);
    setUrl(nextUrl);
    loadedRef.current = false;
    return () => URL.revokeObjectURL(nextUrl);
  }, [document.id, document.content]);

  const print = () => {
    const target = frameRef.current?.contentWindow;
    if (!target) return;
    target.focus();
    target.print();
  };

  useEffect(() => {
    if (printRequest === 0 || !url) return;
    if (loadedRef.current) print();
    else pendingPrintRef.current = true;
  }, [printRequest, url]);

  return (
    <div className="pdf-document-viewer" data-testid="pdf-document-viewer">
      {url && (
        <iframe
          ref={frameRef}
          className="pdf-document-frame"
          src={url}
          title={document.title}
          onLoad={() => {
            loadedRef.current = true;
            if (pendingPrintRef.current) {
              pendingPrintRef.current = false;
              print();
            }
          }}
        />
      )}
    </div>
  );
}
