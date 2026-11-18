import { describe, expect, it } from 'vitest';
import { canUseRemote, type RepositoryContext } from './repository';

const repo: RepositoryContext = { id: 'repo-a', owner: 'owner', name: 'notes', branch: 'main', isActive: false };

describe('canUseRemote', () => {
  it('blocks every remote operation for inactive repositories', () => {
    for (const operation of ['read', 'sync', 'commit', 'push'] as const) {
      expect(canUseRemote(repo, operation)).toBe(false);
    }
  });
  it('allows remote operations for the active repository', () => {
    expect(canUseRemote({ ...repo, isActive: true }, 'push')).toBe(true);
  });
});
