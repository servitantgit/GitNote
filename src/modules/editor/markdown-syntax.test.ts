import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';
import { getFenceStateBeforeLine, isFenceClosing, parseFenceOpening } from './markdown-syntax';

describe('Markdown fenced code detection', () => {
  it('recognizes backtick and tilde fence openers', () => {
    expect(parseFenceOpening('```ts')).toEqual({ marker: '`', length: 3 });
    expect(parseFenceOpening('  ~~~~')).toEqual({ marker: '~', length: 4 });
  });

  it('rejects invalid fence openers', () => {
    expect(parseFenceOpening('not a fence')).toBeNull();
    expect(parseFenceOpening('```js`')).toBeNull();
  });

  it('requires a closing fence with the same marker and sufficient length', () => {
    const fence = { marker: '`' as const, length: 3 };
    expect(isFenceClosing('  ````  ', fence)).toBe(true);
    expect(isFenceClosing('~~~', fence)).toBe(false);
    expect(isFenceClosing('``', fence)).toBe(false);
    expect(isFenceClosing('``` trailing text', fence)).toBe(false);
  });

  it('tracks whether a line is inside a fenced code block', () => {
    const doc = Text.of(['Intro', '```ts', 'const value = **literal**;', '```', 'After']);
    expect(getFenceStateBeforeLine(doc, 2)).toBeNull();
    expect(getFenceStateBeforeLine(doc, 3)).toEqual({ marker: '`', length: 3 });
    expect(getFenceStateBeforeLine(doc, 4)).toEqual({ marker: '`', length: 3 });
    expect(getFenceStateBeforeLine(doc, 5)).toBeNull();
  });

  it('does not close a longer fence with a shorter marker', () => {
    const doc = Text.of(['~~~~', '~~~', 'still code', '~~~~', 'text']);
    expect(getFenceStateBeforeLine(doc, 3)).toEqual({ marker: '~', length: 4 });
    expect(getFenceStateBeforeLine(doc, 5)).toBeNull();
  });
});
