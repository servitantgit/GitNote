import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, File, FileImage, FileText, Folder, FolderOpen } from 'lucide-react';
import type { WorkspaceFileNode } from '../../core/domain/workspace-file-system';

interface Props {
  nodes: WorkspaceFileNode[];
  selectedPath: string;
  onSelectFolder: (path: string) => void;
  onOpenFile: (node: WorkspaceFileNode) => void;
}

function FileIcon({ name }: { name: string }) {
  const extension = name.split('.').pop()?.toLowerCase();
  if (['md', 'markdown', 'txt', 'html', 'htm', 'csv'].includes(extension ?? '')) return <FileText size={15} />;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico'].includes(extension ?? '')) return <FileImage size={15} />;
  return <File size={15} />;
}

export function WorkspaceFileTree({ nodes, selectedPath, onSelectFolder, onOpenFile }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['Notes', 'Documents']));
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

  const renderLevel = (parentPath: string, depth: number): React.ReactNode =>
    (childrenByParent.get(parentPath) ?? []).map(node => {
      if (node.kind === 'folder') {
        const isExpanded = expanded.has(node.path);
        const selected = selectedPath === node.path;
        return (
          <div className="file-tree-branch" key={node.id}>
            <button
              className={`file-tree-row folder-row${selected ? ' selected' : ''}`}
              style={{ paddingLeft: 8 + depth * 16 }}
              aria-expanded={isExpanded}
              onClick={() => {
                onSelectFolder(node.path);
                setExpanded(current => {
                  const next = new Set(current);
                  if (next.has(node.path)) next.delete(node.path);
                  else next.add(node.path);
                  return next;
                });
              }}
              title={node.path}
            >
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {isExpanded ? <FolderOpen size={15} /> : <Folder size={15} />}
              <span>{node.name}</span>
            </button>
            {isExpanded && <div>{renderLevel(node.path, depth + 1)}</div>}
          </div>
        );
      }
      return (
        <button
          key={node.id}
          className={`file-tree-row file-row${selectedPath === node.parentPath ? ' in-selected-folder' : ''}`}
          style={{ paddingLeft: 28 + depth * 16 }}
          onClick={() => onOpenFile(node)}
          title={node.path}
        >
          <FileIcon name={node.name} />
          <span>{node.name}</span>
        </button>
      );
    });

  return <div className="workspace-file-tree" role="tree" aria-label="Файли та папки" data-testid="workspace-file-tree">
    {renderLevel('', 0)}
    {nodes.length === 0 && <div className="file-tree-empty">Папка порожня</div>}
  </div>;
}
