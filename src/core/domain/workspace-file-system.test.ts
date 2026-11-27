import { describe, expect, it } from 'vitest';
import { normalizeWorkspacePath, parentWorkspacePath, validateWorkspaceName, workspacePathName } from './workspace-file-system';

describe('workspace path rules', () => {
  it('normalizes separators and redundant outer separators', () => {
    expect(normalizeWorkspacePath('\\Notes\\Draft.md')).toBe('Notes/Draft.md');
    expect(normalizeWorkspacePath('/Notes/Draft.md/')).toBe('Notes/Draft.md');
  });

  it('rejects relative path traversal', () => {
    expect(() => normalizeWorkspacePath('../secret.md')).toThrow('relative segments');
    expect(() => normalizeWorkspacePath('Notes/../../secret.md')).toThrow('relative segments');
  });

  it('validates names as single path segments', () => {
    expect(validateWorkspaceName('  Draft.md  ')).toBe('Draft.md');
    expect(() => validateWorkspaceName('')).toThrow('non-empty');
    expect(() => validateWorkspaceName('../Draft.md')).toThrow('non-empty');
    expect(() => validateWorkspaceName('folder/name')).toThrow('non-empty');
  });

  it('extracts parent and leaf names', () => {
    expect(parentWorkspacePath('Notes/Projects/Draft.md')).toBe('Notes/Projects');
    expect(workspacePathName('Notes/Projects/Draft.md')).toBe('Draft.md');
    expect(parentWorkspacePath('Readme.md')).toBe('');
  });
});
