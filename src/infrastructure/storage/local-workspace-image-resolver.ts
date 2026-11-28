import { detectDocumentFormat } from '../../core/domain/document-format';
import { resolveWorkspaceAssetPath } from '../../core/domain/workspace-file-system';
import { database } from './database';

/** Read an image Blob from an ordinary file node in the same workspace. */
export async function resolveLocalWorkspaceImage(repositoryId: string, notePath: string, target: string): Promise<Blob | null> {
  const path = resolveWorkspaceAssetPath(notePath, target);
  if (!path) return null;
  const node = await database.fileNodes.where('[repositoryId+path]').equals([repositoryId, path]).first();
  if (!node || node.kind !== 'file' || !node.documentId) return null;
  const document = await database.binaryDocuments.get(node.documentId);
  if (!document || document.repositoryId !== repositoryId) return null;
  const format = detectDocumentFormat(node.name, document.mediaType || document.content.type).id;
  if (format !== 'image' && !document.content.type.startsWith('image/')) return null;
  return document.content;
}
