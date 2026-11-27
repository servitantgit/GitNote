import type { WorkspaceFileNode, WorkspaceFileSystem } from '../../core/domain/workspace-file-system';
import { normalizeWorkspacePath, parentWorkspacePath, validateWorkspaceName, workspacePathName } from '../../core/domain/workspace-file-system';
import { database } from './database';

function makeId(): string {
  return crypto.randomUUID();
}

function assertParentFolder(nodes: WorkspaceFileNode[], parentPath: string): void {
  if (parentPath && !nodes.some(node => node.path === parentPath && node.kind === 'folder')) {
    throw new Error(`Parent folder not found: ${parentPath}`);
  }
}

function nextPath(parentPath: string, name: string): string {
  return parentPath ? `${parentPath}/${name}` : name;
}

/** IndexedDB-backed virtual file system for the local workspace. */
export class LocalWorkspaceFileSystem implements WorkspaceFileSystem {
  async list(repositoryId: string, parentPath = ''): Promise<WorkspaceFileNode[]> {
    const parent = normalizeWorkspacePath(parentPath);
    return database.fileNodes
      .where('[repositoryId+parentPath]')
      .equals([repositoryId, parent])
      .sortBy('name');
  }

  async createFolder(repositoryId: string, parentPath: string, name: string): Promise<WorkspaceFileNode> {
    const parent = normalizeWorkspacePath(parentPath);
    const safeName = validateWorkspaceName(name);
    return database.transaction('rw', database.fileNodes, async () => {
      const nodes = await database.fileNodes.where('repositoryId').equals(repositoryId).toArray();
      assertParentFolder(nodes, parent);
      const path = nextPath(parent, safeName);
      if (nodes.some(node => node.path === path)) throw new Error(`Path already exists: ${path}`);
      const now = Date.now();
      const node: WorkspaceFileNode = {
        id: makeId(), repositoryId, path, parentPath: parent, name: safeName,
        kind: 'folder', createdAt: now, updatedAt: now,
      };
      await database.fileNodes.add(node);
      return node;
    });
  }

  async createDocument(document: import('../../core/domain/document-source').DocumentRecord, path: string): Promise<WorkspaceFileNode> {
    const normalized = normalizeWorkspacePath(path);
    if (!normalized) throw new Error('A document path is required.');
    if (document.path && normalizeWorkspacePath(document.path) !== normalized) {
      throw new Error('The document path does not match the requested workspace path.');
    }
    return database.transaction('rw', database.fileNodes, database.notes, async () => {
      const nodes = await database.fileNodes.where('repositoryId').equals(document.repositoryId).toArray();
      const parent = parentWorkspacePath(normalized);
      assertParentFolder(nodes, parent);
      if (nodes.some(node => node.path === normalized)) {
        throw new Error(`Path already exists: ${normalized}`);
      }
      if (await database.notes.get(document.id)) {
        throw new Error(`Document already exists: ${document.id}`);
      }
      const now = Date.now();
      const note = { ...document, path: normalized, syncState: 'local' as const, updatedAt: now };
      const node: WorkspaceFileNode = {
        id: makeId(), repositoryId: document.repositoryId, path: normalized,
        parentPath: parent, name: workspacePathName(normalized), kind: 'file',
        documentId: document.id, createdAt: document.createdAt, updatedAt: now,
      };
      await database.notes.add(note);
      await database.fileNodes.add(node);
      return node;
    });
  }

  async registerDocument(repositoryId: string, documentId: string, path: string): Promise<WorkspaceFileNode> {
    const normalized = normalizeWorkspacePath(path);
    if (!normalized) throw new Error('A document path is required.');
    return database.transaction('rw', database.fileNodes, database.notes, async () => {
      const note = await database.notes.get(documentId);
      if (!note || note.repositoryId !== repositoryId) throw new Error(`Document not found in workspace: ${documentId}`);
      const nodes = await database.fileNodes.where('repositoryId').equals(repositoryId).toArray();
      const parent = parentWorkspacePath(normalized);
      assertParentFolder(nodes, parent);
      if (nodes.some(node => node.path === normalized && node.documentId !== documentId)) {
        throw new Error(`Path already exists: ${normalized}`);
      }
      const existing = nodes.find(node => node.documentId === documentId);
      if (existing && existing.path !== normalized) await database.fileNodes.delete(existing.id);
      const now = Date.now();
      const node: WorkspaceFileNode = {
        id: existing?.id ?? makeId(), repositoryId, path: normalized, parentPath: parent,
        name: workspacePathName(normalized), kind: 'file', documentId,
        createdAt: existing?.createdAt ?? now, updatedAt: now,
      };
      await database.fileNodes.put(node);
      note.path = normalized;
      note.syncState = 'local';
      note.updatedAt = now;
      await database.notes.put(note);
      return node;
    });
  }

  async rename(repositoryId: string, path: string, name: string): Promise<void> {
    const normalized = normalizeWorkspacePath(path);
    const safeName = validateWorkspaceName(name);
    const parent = parentWorkspacePath(normalized);
    await this.relocate(repositoryId, normalized, nextPath(parent, safeName));
  }

  async move(repositoryId: string, path: string, targetParentPath: string): Promise<void> {
    const normalized = normalizeWorkspacePath(path);
    const targetParent = normalizeWorkspacePath(targetParentPath);
    const node = await database.fileNodes.where('[repositoryId+path]').equals([repositoryId, normalized]).first();
    if (!node) throw new Error(`Path not found: ${normalized}`);
    if (node.kind === 'folder' && (targetParent === normalized || targetParent.startsWith(`${normalized}/`))) {
      throw new Error('A folder cannot be moved into itself or one of its descendants.');
    }
    await this.relocate(repositoryId, normalized, nextPath(targetParent, node.name));
  }

  async remove(repositoryId: string, path: string): Promise<void> {
    const normalized = normalizeWorkspacePath(path);
    await database.transaction('rw', database.fileNodes, database.notes, async () => {
      const nodes = await database.fileNodes.where('repositoryId').equals(repositoryId).toArray();
      const target = nodes.find(node => node.path === normalized);
      if (!target) return;
      const removed = nodes.filter(node => node.path === normalized || node.path.startsWith(`${normalized}/`));
      const documentIds = removed.flatMap(node => node.documentId ? [node.documentId] : []);
      await database.fileNodes.bulkDelete(removed.map(node => node.id));
      await database.notes.bulkDelete(documentIds);
    });
  }

  private async relocate(repositoryId: string, oldPath: string, newPath: string): Promise<void> {
    const normalizedNew = normalizeWorkspacePath(newPath);
    if (!normalizedNew) throw new Error('A destination path is required.');
    await database.transaction('rw', database.fileNodes, database.notes, async () => {
      const nodes = await database.fileNodes.where('repositoryId').equals(repositoryId).toArray();
      const source = nodes.find(node => node.path === oldPath);
      if (!source) throw new Error(`Path not found: ${oldPath}`);
      const targetParent = parentWorkspacePath(normalizedNew);
      assertParentFolder(nodes, targetParent);
      const moving = nodes.filter(node => node.path === oldPath || node.path.startsWith(`${oldPath}/`));
      const movingIds = new Set(moving.map(node => node.id));
      const destinationPaths = new Set(moving.map(node => normalizedNew + node.path.slice(oldPath.length)));
      if (nodes.some(node => !movingIds.has(node.id) && destinationPaths.has(node.path))) {
        throw new Error(`Destination already exists: ${normalizedNew}`);
      }
      if (source.kind === 'folder' && (normalizedNew === oldPath || normalizedNew.startsWith(`${oldPath}/`))) {
        throw new Error('A folder cannot be moved into itself or one of its descendants.');
      }
      const now = Date.now();
      for (const node of moving) {
        const updatedPath = normalizedNew + node.path.slice(oldPath.length);
        node.path = updatedPath;
        node.parentPath = parentWorkspacePath(updatedPath);
        node.name = workspacePathName(updatedPath);
        node.updatedAt = now;
        await database.fileNodes.put(node);
        if (node.documentId) {
          const note = await database.notes.get(node.documentId);
          if (note) {
            note.path = updatedPath;
            note.updatedAt = now;
            await database.notes.put(note);
          }
        }
      }
    });
  }
}

export const workspaceFileSystem: WorkspaceFileSystem = new LocalWorkspaceFileSystem();
