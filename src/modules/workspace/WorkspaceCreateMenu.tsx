import { useEffect, useRef, useState } from 'react';
import { FileText, FileType, FileSpreadsheet, Presentation, Plus } from 'lucide-react';
import type { OfficeDocumentKind } from '../documents/create-office-document';

interface Props {
  onCreateNote: () => void;
  onCreateOffice: (kind: OfficeDocumentKind) => void;
  disabled?: boolean;
}

export function WorkspaceCreateMenu({ onCreateNote, onCreateOffice, disabled = false }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  const createNote = () => {
    setIsOpen(false);
    onCreateNote();
  };
  const createOffice = (kind: OfficeDocumentKind) => {
    setIsOpen(false);
    onCreateOffice(kind);
  };

  return (
    <div className={`create-menu${isOpen ? ' open' : ''}`} ref={menuRef}>
      <button
        type="button"
        className="icon-button"
        aria-label="Створити"
        title="Створити нотатку або Office-документ"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls="workspace-create-menu"
        disabled={disabled}
        onClick={() => setIsOpen(open => !open)}
      >
        <Plus size={16} />
      </button>
      {isOpen && (
        <div className="create-menu-popover" id="workspace-create-menu" role="menu" aria-label="Створити документ">
          <button type="button" role="menuitem" disabled={disabled} onClick={createNote}>
            <FileText size={16} color="#4385D1" />Створити нотатку
          </button>
          <button type="button" role="menuitem" disabled={disabled} onClick={() => createOffice('docx')}>
            <FileType size={16} color="#3478C8" />Документ Word (.docx)
          </button>
          <button type="button" role="menuitem" disabled={disabled} onClick={() => createOffice('xlsx')}>
            <FileSpreadsheet size={16} color="#278653" />Таблицю Excel (.xlsx)
          </button>
          <button type="button" role="menuitem" disabled={disabled} onClick={() => createOffice('pptx')}>
            <Presentation size={16} color="#D58A35" />Презентацію PowerPoint (.pptx)
          </button>
        </div>
      )}
    </div>
  );
}
