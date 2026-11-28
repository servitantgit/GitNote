import { useMemo, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, Folder, FolderInput, FolderOpen, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react';
import { WorkspaceFileIcon } from './WorkspaceFileIcon';
import type { WorkspaceFileNode } from '../../core/domain/workspace-file-system';

interface Props {
  nodes: WorkspaceFileNode[];
  selectedPath: string;
  onSelectFolder: (path: string) => void;
  onOpenFile: (node: WorkspaceFileNode) => void;
  onRename: (node: WorkspaceFileNode) => void;
  onMove: (node: WorkspaceFileNode, targetParentPath: string) => void;
  onDelete: (node: WorkspaceFileNode) => void;
  disabled?: boolean;
}

export function WorkspaceFileTree({
  nodes,
  selectedPath,
  onSelectFolder,
  onOpenFile,
  onRename,
  onMove,
  onDelete,
  disabled = false,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['Notes', 'Documents']));
  const [openMenuPath, setOpenMenuPath] = useState<string | null>(null);
  const [moveTargetPath, setMoveTargetPath] = useState('');
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);

  const childrenByParent = useMemo(() => {
    const groups = new Map<string, WorkspaceFileNode[]>();
    for (const node of nodes) {
      const siblings = groups.get(node.parentPath) ?? [];
      siblings.push(node);
      groups.set(node.parentPath, siblings);
    }
    for (const siblings of groups.values()) {
      siblings.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1);
    }
    return groups;
  }, [nodes]);

  const folderOptions = useMemo(() => [
    { path: '', name: 'Робочий простір' },
    ...nodes.filter(node => node.kind === 'folder').map(node => ({ path: node.path, name: node.path })),
  ], [nodes]);

  const toggleFolder = (path: string) => {
    setOpenMenuPath(null);
    onSelectFolder(path);
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleDrop = (event: DragEvent, targetParentPath: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTargetPath(null);
    const sourcePath = event.dataTransfer.getData('text/plain');
    const source = nodes.find(node => node.path === sourcePath);
    if (!source || source.path === targetParentPath || (source.kind === 'folder' && targetParentPath.startsWith(source.path + '/'))) return;
    if (source.parentPath === targetParentPath) return;
    setOpenMenuPath(null);
    onMove(source, targetParentPath);
  };

  const renderActions = (node: WorkspaceFileNode): ReactNode => {
    const menuOpen = openMenuPath === node.path;
    const validTargets = folderOptions.filter(option => option.path !== node.path
      && !(node.kind === 'folder' && option.path.startsWith(node.path + '/')));
    return (
      <div className="file-tree-actions">
        <button
          type="button"
          className="file-tree-more"
          aria-label="Меню дій"
          title={`Дії: ${node.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={disabled}
          onClick={event => {
            event.stopPropagation();
            setMoveTargetPath(node.parentPath);
            setOpenMenuPath(current => current === node.path ? null : node.path);
          }}
        >
          <MoreHorizontal size={15} />
        </button>
        {menuOpen && (
          <div className="file-tree-menu" role="menu" aria-label={`Дії для ${node.name}`} onClick={event => event.stopPropagation()}>
            <button type="button" role="menuitem" onClick={() => { setOpenMenuPath(null); onRename(node); }}>
              <Pencil size={14} />Перейменувати
            </button>
            <div className="file-tree-move">
              <label htmlFor={`move-target-${node.id}`}>Перемістити до</label>
              <select
                id={`move-target-${node.id}`}
                aria-label={`Перемістити ${node.name} до папки`}
                value={moveTargetPath}
                onChange={event => setMoveTargetPath(event.target.value)}
                disabled={disabled}
              >
                {validTargets.map(option => <option key={option.path || '__root__'} value={option.path}>{option.name}</option>)}
              </select>
              <button
                type="button"
                disabled={disabled || moveTargetPath === node.parentPath || !validTargets.some(option => option.path === moveTargetPath)}
                onClick={() => { const target = moveTargetPath; setOpenMenuPath(null); onMove(node, target); }}
              >
                <FolderInput size={14} />Перемістити
              </button>
            </div>
            <button type="button" role="menuitem" className="danger" disabled={disabled} onClick={() => { setOpenMenuPath(null); onDelete(node); }}>
              <Trash2 size={14} />Видалити
            </button>
            <button type="button" role="menuitem" className="file-tree-menu-close" onClick={() => setOpenMenuPath(null)}>
              <X size={14} />Закрити
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderLevel = (parentPath: string, depth: number): ReactNode =>
    (childrenByParent.get(parentPath) ?? []).map(node => {
      if (node.kind === 'folder') {
        const isExpanded = expanded.has(node.path);
        const selected = selectedPath === node.path;
        const isDropTarget = dropTargetPath === node.path;
        return (
          <div className="file-tree-branch" key={node.id}>
            <div className={`file-tree-entry${isDropTarget ? ' drop-target' : ''}`}>
              <button
                type="button"
                className={`file-tree-row folder-row${selected ? ' selected' : ''}`}
                style={{ paddingLeft: 8 + depth * 16 }}
                aria-expanded={isExpanded}
                draggable={!disabled}
                onDragStart={event => { event.dataTransfer.setData('text/plain', node.path); event.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => setDropTargetPath(null)}
                onDragOver={event => { if (!disabled) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTargetPath(node.path); } }}
                onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTargetPath(null); }}
                onDrop={event => !disabled && handleDrop(event, node.path)}
                onClick={() => toggleFolder(node.path)}
                title={node.path}
              >
                {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {isExpanded ? <FolderOpen size={15} /> : <Folder size={15} />}
                <span>{node.name}</span>
              </button>
              {renderActions(node)}
            </div>
            {isExpanded && <div>{renderLevel(node.path, depth + 1)}</div>}
          </div>
        );
      }
      return (
        <div className="file-tree-entry" key={node.id}>
          <button
            type="button"
            className={`file-tree-row file-row${selectedPath === node.parentPath ? ' in-selected-folder' : ''}`}
            style={{ paddingLeft: 28 + depth * 16 }}
            draggable={!disabled}
            onDragStart={event => { event.dataTransfer.setData('text/plain', node.path); event.dataTransfer.effectAllowed = 'move'; }}
            onDragEnd={() => setDropTargetPath(null)}
            onClick={() => { setOpenMenuPath(null); onOpenFile(node); }}
            title={node.path}
          >
            <WorkspaceFileIcon name={node.name} />
            <span>{node.name}</span>
          </button>
          {renderActions(node)}
        </div>
      );
    });

  return <div className="workspace-file-tree" role="tree" aria-label="Файли та папки" data-testid="workspace-file-tree">
    <div className={`file-tree-entry root-entry${dropTargetPath === '' ? ' drop-target' : ''}`}>
      <button
        type="button"
        className={`file-tree-row root-row${selectedPath === '' ? ' selected' : ''}`}
        onClick={() => { setOpenMenuPath(null); onSelectFolder(''); }}
        onDragOver={event => { if (!disabled) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTargetPath(''); } }}
        onDragLeave={() => setDropTargetPath(null)}
        onDrop={event => !disabled && handleDrop(event, '')}
        title="Коренева папка"
      >
        <FolderOpen size={15} /><span>Робочий простір</span>
      </button>
      {dropTargetPath === '' && <span className="file-tree-drop-indicator" aria-hidden="true"><Check size={12} /></span>}
    </div>
    {renderLevel('', 0)}
    {nodes.length === 0 && <div className="file-tree-empty">Папка порожня</div>}
  </div>;
}
