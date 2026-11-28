import { Download, Printer } from 'lucide-react';

interface Props {
  onDownload: () => void;
  onPrint: () => void;
}

/** Shared workspace actions; each format supplies its own print/save behavior. */
export function DocumentActions({ onDownload, onPrint }: Props) {
  return (
    <>
      <button className="icon-button" type="button" aria-label="Завантажити файл" title="Завантажити файл" onClick={onDownload}>
        <Download size={16} />
      </button>
      <button className="icon-button" type="button" aria-label="Друкувати файл" title="Друкувати файл" onClick={onPrint}>
        <Printer size={16} />
      </button>
    </>
  );
}
