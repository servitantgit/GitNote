export type WorkspaceNodeKind = 'file' | 'folder';

export interface WorkspaceFileNode {
  id: string;
  repositoryId: string;
  path: string;
  parentPath: string;
  name: string;
  kind: WorkspaceNodeKind;
  documentId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceFileSystem {
  list(repositoryId: string, parentPath?: string): Promise<WorkspaceFileNode[]>;
  createDocument(document: import('./document-source').DocumentRecord, path: string): Promise<WorkspaceFileNode>;
  createBinaryDocument(document: import('./document-source').BinaryDocumentRecord, path: string): Promise<WorkspaceFileNode>;
  createBinaryDocument(document: import('./document-source').BinaryDocumentRecord, path: string): Promise<WorkspaceFileNode>;
  createFolder(repositoryId: string, parentPath: string, name: string): Promise<WorkspaceFileNode>;
  registerDocument(repositoryId: string, documentId: string, path: string): Promise<WorkspaceFileNode>;
  rename(repositoryId: string, path: string, name: string): Promise<void>;
  move(repositoryId: string, path: string, targetParentPath: string): Promise<void>;
  remove(repositoryId: string, path: string): Promise<void>;
}

export function normalizeWorkspacePath(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw new Error('Workspace paths cannot contain relative segments.');
  }
  return segments.join('/');
}

export function validateWorkspaceName(name: string): string {
  const normalized = name.trim();
  if (!normalized || normalized === '.' || normalized === '..' || /[\/\\\0]/.test(normalized)) {
    throw new Error('A file or folder name must be a non-empty path segment.');
  }
  return normalized;
}

export function parentWorkspacePath(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  const separator = normalized.lastIndexOf('/');
  return separator < 0 ? '' : normalized.slice(0, separator);
}

export function workspacePathName(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/** Resolve a Markdown image target against the directory containing its note. */
export function resolveWorkspaceAssetPath(documentPath: string, target: string): string | null {
  let value = String(target ?? '').trim();
  if (!value || value.startsWith('#') || value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) return null;
  const suffix = value.search(/[?#]/u);
  if (suffix >= 0) value = value.slice(0, suffix);
  try { value = decodeURIComponent(value); } catch { return null; }
  if (!value || value.includes('\0')) return null;
  const segments = value.startsWith('/') ? [] : parentWorkspacePath(documentPath).split('/').filter(Boolean);
  for (const segment of value.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) return null;
      segments.pop();
    } else {
      if (segment.includes('\0')) return null;
      segments.push(segment);
    }
  }
  return segments.join('/') || null;
}
