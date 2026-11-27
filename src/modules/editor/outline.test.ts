import { describe, expect, it } from 'vitest';
import { parseDocumentOutline } from './outline';

describe('parseDocumentOutline', () => {
  it('returns ATX headings with their document lines and levels', () => {
    expect(parseDocumentOutline('# Title\ntext\n## Section\n### Deep')).toEqual([
      { line: 0, level: 1, text: 'Title' },
      { line: 2, level: 2, text: 'Section' },
      { line: 3, level: 3, text: 'Deep' },
    ]);
  });

  it('supports Setext headings', () => {
    expect(parseDocumentOutline('Main title\n===========\n\nSection\n-------')).toEqual([
      { line: 0, level: 1, text: 'Main title' },
      { line: 3, level: 2, text: 'Section' },
    ]);
  });

  it('ignores heading-like content inside fenced and inline code', () => {
    const content = ['# Real', '```md', '# Not a heading', '```', 'Text with `# inline code`', '## Also real'].join('\n');
    expect(parseDocumentOutline(content)).toEqual([
      { line: 0, level: 1, text: 'Real' },
      { line: 5, level: 2, text: 'Also real' },
    ]);
  });

  it('strips closing hashes but keeps C# text', () => {
    expect(parseDocumentOutline('# Title ##\n# C#')).toEqual([
      { line: 0, level: 1, text: 'Title' },
      { line: 1, level: 1, text: 'C#' },
    ]);
  });

  it('returns an empty outline when the document has no headings', () => {
    expect(parseDocumentOutline('plain text\n`# code`')).toEqual([]);
  });
});