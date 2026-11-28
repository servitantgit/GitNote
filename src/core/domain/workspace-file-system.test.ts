import { describe, expect, it } from 'vitest';
import { normalizeWorkspacePath, parentWorkspacePath, resolveWorkspaceAssetPath, validateWorkspaceName, workspacePathName } from './workspace-file-system';

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
    expect(validateWorkspaceName('2026-report-v0.docx')).toBe('2026-report-v0.docx');
    expect(() => validateWorkspaceName('')).toThrow('non-empty');
    expect(() => validateWorkspaceName('../Draft.md')).toThrow('non-empty');
    expect(() => validateWorkspaceName('folder/name')).toThrow('non-empty');
    expect(() => validateWorkspaceName('folder\\name')).toThrow('non-empty');
    expect(() => validateWorkspaceName('file\0name.md')).toThrow('non-empty');
  });

  it('extracts parent and leaf names', () => {
    expect(parentWorkspacePath('Notes/Projects/Draft.md')).toBe('Notes/Projects');
    expect(workspacePathName('Notes/Projects/Draft.md')).toBe('Draft.md');
    expect(parentWorkspacePath('Readme.md')).toBe('');
  });
});


describe('workspace asset path resolution', () => {
  it('resolves relative paths against the note directory', () => {
    expect(resolveWorkspaceAssetPath('Notes/Projects/Plan.md', '../Images/diagram.png')).toBe('Notes/Images/diagram.png');
    expect(resolveWorkspaceAssetPath('Notes/Plan.md', 'photo%20one.png')).toBe('Notes/photo one.png');
    expect(resolveWorkspaceAssetPath('Notes/Plan.md', './photo.png')).toBe('Notes/photo.png');
  });
  it('resolves root-relative paths from the workspace root', () => {
    expect(resolveWorkspaceAssetPath('Notes/Plan.md', '/Images/photo.png')).toBe('Images/photo.png');
  });
  it('rejects external URLs, fragments, malformed escapes and traversal above the root', () => {
    expect(resolveWorkspaceAssetPath('Notes/Plan.md', 'https://example.com/photo.png')).toBeNull();
    expect(resolveWorkspaceAssetPath('Notes/Plan.md', '//example.com/photo.png')).toBeNull();
    expect(resolveWorkspaceAssetPath('Notes/Plan.md', '#section')).toBeNull();
    expect(resolveWorkspaceAssetPath('Notes/Plan.md', '../../secret.png')).toBeNull();
    expect(resolveWorkspaceAssetPath('Notes/Plan.md', '%E0%A4%A.png')).toBeNull();
  });
});
