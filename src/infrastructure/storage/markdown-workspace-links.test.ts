import { describe, expect, it } from 'vitest';
import { rewriteWorkspaceMarkdownLinks } from './markdown-workspace-links';

describe('rewriteWorkspaceMarkdownLinks', () => {
  const paths = new Set([
    'Notes/page.md',
    'Notes/Images/photo one.png',
    'Documents/guide.pdf',
    'Images/shared.png',
  ]);

  it('rewrites inline links and images when a referenced workspace file moves', () => {
    const source = [
      '![Photo](Images/photo%20one.png)',
      '[Guide](../Documents/guide.pdf#page=2)',
      '![Root image](/Images/shared.png)',
    ].join('\n');
    const changes = new Map([
      ['Notes/Images/photo one.png', 'Media/photo one.png'],
      ['Documents/guide.pdf', 'Archive/guide.pdf'],
      ['Images/shared.png', 'Assets/shared.png'],
    ]);

    expect(rewriteWorkspaceMarkdownLinks(source, 'Notes/page.md', 'Notes/page.md', changes, paths))
      .toBe([
        '![Photo](../Media/photo%20one.png)',
        '[Guide](../Archive/guide.pdf#page=2)',
        '![Root image](/Assets/shared.png)',
      ].join('\n'));
  });

  it('adjusts relative links when the Markdown document itself moves', () => {
    const source = '[Guide](../Documents/guide.pdf)\n![Image](./Images/photo%20one.png)';
    expect(rewriteWorkspaceMarkdownLinks(
      source,
      'Notes/page.md',
      'Archive/page.md',
      new Map(),
      paths,
    )).toBe('[Guide](../Documents/guide.pdf)\n![Image](../Notes/Images/photo%20one.png)');
  });

  it('does not rewrite external links, attachment references or code examples', () => {
    const source = [
      '[Web](https://example.com/Images/shared.png)',
      '![Owned](attachment:abc123)',
      '```md',
      '![Example](Images/shared.png)',
      '```',
    ].join('\n');
    expect(rewriteWorkspaceMarkdownLinks(
      source,
      'Notes/page.md',
      'Archive/page.md',
      new Map([['Images/shared.png', 'Assets/shared.png']]),
      paths,
    )).toBe(source);
  });

  it('leaves unresolved and traversal targets unchanged', () => {
    const source = '[Missing](missing.pdf)\n[Outside](../../outside.pdf)';
    expect(rewriteWorkspaceMarkdownLinks(
      source,
      'Notes/page.md',
      'Archive/page.md',
      new Map(),
      paths,
    )).toBe(source);
  });
});
