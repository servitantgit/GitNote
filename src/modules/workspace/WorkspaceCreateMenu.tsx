import { FileText, FileType, FileSpreadsheet, Presentation, Plus } from 'lucide-react';
import type { OfficeDocumentKind } from '../documents/create-office-document';

interface Props {
  onCreateNote: () => void;
  onCreateOffice: (kind: OfficeDocumentKind) => void;
  disabled?: boolean;
}

export function WorkspaceCreateMenu({ onCreateNote, onCreateOffice, disabled = false }: Props) {
  const closeMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.closest('details')?.removeAttribute('open');
  };
  return (
    <details className="create-menu">
      <summary className="icon-button" aria-label="Створити" title="Створити нотатку або Office-документ" aria-haspopup="menu">
        <Plus size={16} />
      </summary>
      <div className="create-menu-popover" role="menu" aria-label="Створити документ">
        <button type="button" role="menuitem" disabled={disabled} onClick={event => { closeMenu(event); onCreateNote(); }}>
          <FileText size={16} color="#4385D1" />Нотатку Markdown
        </button>
        <button type="button" role="menuitem" disabled={disabled} onClick={event => { closeMenu(event); onCreateOffice('docx'); }}>
          <FileType size={16} color="#3478C8" />Документ Word (.docx)
        </button>
        <button type="button" role="menuitem" disabled={disabled} onClick={event => { closeMenu(event); onCreateOffice('xlsx'); }}>
          <FileSpreadsheet size={16} color="#278653" />Таблицю Excel (.xlsx)
        </button>
        <button type="button" role="menuitem" disabled={disabled} onClick={event => { closeMenu(event); onCreateOffice('pptx'); }}>
          <Presentation size={16} color="#D58A35" />Презентацію PowerPoint (.pptx)
        </button>
      </div>
    </details>
  );
}
