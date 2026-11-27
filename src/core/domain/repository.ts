export interface RepositoryContext {
  id: string;
  owner: string;
  name: string;
  branch: string;
  /** Only the selected repository may perform remote operations. */
  isActive: boolean;
}

export type RemoteOperation = 'read' | 'sync' | 'commit' | 'push';

export function canUseRemote(repository: RepositoryContext, operation: RemoteOperation): boolean {
  if (!repository.isActive) return false;
  return operation === 'read' || operation === 'sync' || operation === 'commit' || operation === 'push';
}
