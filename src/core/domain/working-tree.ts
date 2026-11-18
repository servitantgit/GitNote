export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'moved';

export interface WorkingTreeChange {
  id: string;
  repositoryId: string;
  path: string;
  previousPath?: string;
  kind: ChangeKind;
  content?: string;
  binary?: Blob;
  updatedAt: number;
}

/** Local journal only. This module deliberately performs no GitHub requests. */
export class WorkingTree {
  private readonly changes = new Map<string, WorkingTreeChange>();

  stage(change: WorkingTreeChange): void {
    this.changes.set(`${change.repositoryId}:${change.path}`, change);
  }

  list(repositoryId: string): WorkingTreeChange[] {
    return [...this.changes.values()].filter(change => change.repositoryId === repositoryId);
  }

  clear(repositoryId: string): void {
    for (const [key, change] of this.changes) {
      if (change.repositoryId === repositoryId) this.changes.delete(key);
    }
  }
}
