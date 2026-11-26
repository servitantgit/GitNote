import { describe, expect, it } from 'vitest';
import { WorkspaceManager, type WorkspaceRepository, type WorkspaceTab } from './workspace';

const repoA: WorkspaceRepository = { id: 'repo-a', owner: 'owner', name: 'notes-a', defaultBranch: 'main' };
const repoB: WorkspaceRepository = { id: 'repo-b', owner: 'owner', name: 'notes-b', defaultBranch: 'develop' };
const tabA: WorkspaceTab = { id: 'tab-a', repositoryId: repoA.id, branch: 'main', noteId: 'note-a', title: 'A', openedAt: 1 };
const tabB: WorkspaceTab = { id: 'tab-b', repositoryId: repoB.id, branch: 'develop', noteId: 'note-b', title: 'B', openedAt: 2 };

describe('WorkspaceManager', () => {
  it('keeps tabs from different repositories open while switching tabs', () => {
    const workspace = new WorkspaceManager();
    workspace.registerRepository(repoA);
    workspace.registerRepository(repoB);
    workspace.openTab(tabA);
    workspace.openTab(tabB);
    workspace.selectTab(tabA.id);
    expect(workspace.getSnapshot().tabs.map(tab => tab.id)).toEqual(['tab-a', 'tab-b']);
    expect(workspace.getSnapshot().activeTabId).toBe(tabA.id);
  });

  it('does not change remote repository focus when selecting an inactive repository tab', () => {
    const workspace = new WorkspaceManager();
    workspace.registerRepository(repoA);
    workspace.registerRepository(repoB);
    workspace.openTab(tabA);
    workspace.openTab(tabB);
    workspace.activateRepository(repoA.id);
    workspace.selectTab(tabB.id);
    expect(workspace.canUseRemote(repoA.id, 'push')).toBe(true);
    expect(workspace.canUseRemote(repoB.id, 'push')).toBe(false);
  });

  it('reactivates remote operations only after explicit repository activation', () => {
    const workspace = new WorkspaceManager();
    workspace.registerRepository(repoA);
    workspace.registerRepository(repoB);
    workspace.activateRepository(repoA.id);
    workspace.activateRepository(repoB.id);
    for (const operation of ['read', 'sync', 'commit', 'push'] as const) {
      expect(workspace.canUseRemote(repoA.id, operation)).toBe(false);
      expect(workspace.canUseRemote(repoB.id, operation)).toBe(true);
    }
  });

  it('does not silently activate another repository when the active one is removed', () => {
    const workspace = new WorkspaceManager();
    workspace.registerRepository(repoA);
    workspace.registerRepository(repoB);
    workspace.activateRepository(repoA.id);
    workspace.removeRepository(repoA.id);
    expect(workspace.getSnapshot().activeRepositoryId).toBeNull();
    expect(workspace.canUseRemote(repoB.id, 'push')).toBe(false);
  });

  it('restores a snapshot and drops tabs whose repository no longer exists', () => {
    const workspace = new WorkspaceManager({
      repositories: [repoA],
      tabs: [tabA, tabB],
      activeRepositoryId: repoB.id,
      activeTabId: tabB.id,
    });
    expect(workspace.getSnapshot().tabs).toEqual([tabA]);
    expect(workspace.getSnapshot().activeRepositoryId).toBeNull();
    expect(workspace.getSnapshot().activeTabId).toBe(tabA.id);
  });

  it('updates tab metadata without changing its repository context', () => {
    const workspace = new WorkspaceManager();
    workspace.registerRepository(repoA);
    workspace.openTab(tabA);
    workspace.updateTab(tabA.id, { title: 'Renamed' });
    expect(workspace.getSnapshot().tabs[0]).toMatchObject({ title: 'Renamed', repositoryId: repoA.id, branch: 'main' });
  });

  it('rejects tabs for unknown repositories and conflicting tab IDs', () => {
    const workspace = new WorkspaceManager();
    workspace.registerRepository(repoA);
    expect(() => workspace.openTab(tabB)).toThrow('Unknown repository');
    workspace.openTab(tabA);
    expect(() => workspace.openTab({ ...tabA, noteId: 'different-note' })).toThrow('cannot be reused');
  });
});
