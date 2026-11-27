import type { RemoteOperation } from './repository';

export interface WorkspaceRepository {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  lastKnownHead?: string;
}

export interface WorkspaceTab {
  id: string;
  repositoryId: string;
  branch: string;
  noteId: string;
  title: string;
  openedAt: number;
}

export interface WorkspaceSnapshot {
  repositories: WorkspaceRepository[];
  tabs: WorkspaceTab[];
  activeRepositoryId: string | null;
  activeTabId: string | null;
}

/** Coordinates global tabs separately from the repository enabled for remote Git operations. */
export class WorkspaceManager {
  private repositories = new Map<string, WorkspaceRepository>();
  private tabs: WorkspaceTab[] = [];
  private activeRepositoryId: string | null = null;
  private activeTabId: string | null = null;

  constructor(snapshot?: WorkspaceSnapshot) {
    if (!snapshot) return;
    this.repositories = new Map(snapshot.repositories.map(repository => [repository.id, repository]));
    this.tabs = [...snapshot.tabs];
    this.activeRepositoryId = snapshot.activeRepositoryId;
    this.activeTabId = snapshot.activeTabId;
    this.normalize();
  }

  registerRepository(repository: WorkspaceRepository): void {
    this.repositories.set(repository.id, repository);
    if (!this.activeRepositoryId) this.activeRepositoryId = repository.id;
  }

  removeRepository(repositoryId: string): void {
    this.repositories.delete(repositoryId);
    this.tabs = this.tabs.filter(tab => tab.repositoryId !== repositoryId);
    if (this.activeRepositoryId === repositoryId) this.activeRepositoryId = null;
    if (this.activeTabId && !this.tabs.some(tab => tab.id === this.activeTabId)) {
      this.activeTabId = this.tabs[0]?.id ?? null;
    }
  }

  openTab(tab: WorkspaceTab): void {
    if (!this.repositories.has(tab.repositoryId)) throw new Error(`Unknown repository: ${tab.repositoryId}`);
    const existing = this.tabs.find(item => item.id === tab.id);
    if (existing) {
      if (existing.repositoryId !== tab.repositoryId || existing.noteId !== tab.noteId) {
        throw new Error('A tab ID cannot be reused for a different document.');
      }
      this.activeTabId = existing.id;
      return;
    }
    this.tabs.push(tab);
    this.activeTabId = tab.id;
  }

  updateTab(tabId: string, updates: Partial<Pick<WorkspaceTab, 'title' | 'branch'>>): void {
    const index = this.tabs.findIndex(tab => tab.id === tabId);
    if (index < 0) throw new Error(`Unknown tab: ${tabId}`);
    this.tabs[index] = { ...this.tabs[index], ...updates };
  }

  closeTab(tabId: string): void {
    const index = this.tabs.findIndex(tab => tab.id === tabId);
    if (index < 0) return;
    this.tabs.splice(index, 1);
    if (this.activeTabId === tabId) {
      this.activeTabId = this.tabs[Math.min(index, this.tabs.length - 1)]?.id ?? null;
    }
  }

  selectTab(tabId: string): void {
    if (!this.tabs.some(tab => tab.id === tabId)) throw new Error(`Unknown tab: ${tabId}`);
    this.activeTabId = tabId;
  }

  activateRepository(repositoryId: string): void {
    if (!this.repositories.has(repositoryId)) throw new Error(`Unknown repository: ${repositoryId}`);
    this.activeRepositoryId = repositoryId;
  }

  canUseRemote(repositoryId: string, _operation: RemoteOperation): boolean {
    return this.repositories.has(repositoryId) && this.activeRepositoryId === repositoryId;
  }

  getSnapshot(): WorkspaceSnapshot {
    return {
      repositories: [...this.repositories.values()],
      tabs: [...this.tabs],
      activeRepositoryId: this.activeRepositoryId,
      activeTabId: this.activeTabId,
    };
  }

  private normalize(): void {
    this.tabs = this.tabs.filter(tab => this.repositories.has(tab.repositoryId));
    if (this.activeRepositoryId && !this.repositories.has(this.activeRepositoryId)) this.activeRepositoryId = null;
    if (this.activeTabId && !this.tabs.some(tab => tab.id === this.activeTabId)) {
      this.activeTabId = this.tabs[0]?.id ?? null;
    }
  }
}
