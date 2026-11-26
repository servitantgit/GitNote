import { describe, expect, it } from 'vitest';
import { prefixLines, toggleHeading, wrapSelection } from './markdown-commands';

describe('Markdown editing commands', () => {
  it('wraps selected text and preserves the inner selection', () => {
    expect(wrapSelection('hello world', { from: 6, to: 11 }, '**', '**')).toEqual({
      text: 'hello **world**', selection: { from: 8, to: 13 },
    });
  });
  it('inserts and selects a placeholder for an empty selection', () => {
    expect(wrapSelection('hello', { from: 5, to: 5 }, '`', '`', 'код')).toEqual({
      text: 'hello`код`', selection: { from: 6, to: 9 },
    });
  });
  it('prefixes only the lines covered by a selection', () => {
    expect(prefixLines('one\ntwo\nthree', { from: 1, to: 8 }, '> ')).toEqual({
      text: '> one\n> two\nthree', selection: { from: 0, to: 11 },
    });
  });
  it('adds and toggles a heading marker', () => {
    expect(toggleHeading('Title\nBody', { from: 2, to: 2 }, 2).text).toBe('## Title\nBody');
    expect(toggleHeading('## Title\nBody', { from: 3, to: 3 }, 2).text).toBe('Title\nBody');
  });
  it('handles a selection at the start of a document', () => {
    expect(prefixLines('\nsecond', { from: 0, to: 0 }, '- ').text).toBe('- \nsecond');
  });
});
