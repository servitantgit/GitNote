import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { searchHighlightExtension, setSearchHighlights } from './search-highlight';

describe('searchHighlightExtension', () => {
  it('marks all source ranges and distinguishes the initial match', () => {
    const state = EditorState.create({ doc: 'first second', extensions: [searchHighlightExtension] });
    const highlighted = state.update({
      effects: setSearchHighlights.of({
        ranges: [{ from: 0, to: 5 }, { from: 6, to: 12 }],
        activeIndex: 0,
      }),
    }).state;

    const marks: Array<{ from: number; to: number; className: string }> = [];
    highlighted.field(searchHighlightExtension).between(0, highlighted.doc.length, (from, to, decoration) => {
      marks.push({ from, to, className: decoration.spec.class as string });
    });

    expect(marks).toEqual([
      { from: 0, to: 5, className: 'cm-search-match-current' },
      { from: 6, to: 12, className: 'cm-search-match' },
    ]);
  });

  it('clears stale search decorations when the source document changes', () => {
    const state = EditorState.create({ doc: 'first second', extensions: [searchHighlightExtension] });
    const highlighted = state.update({
      effects: setSearchHighlights.of({
        ranges: [{ from: 0, to: 5 }],
        activeIndex: 0,
      }),
    }).state;
    const edited = highlighted.update({ changes: { from: 0, to: 0, insert: 'new ' } }).state;

    const marks: Array<{ from: number; to: number }> = [];
    edited.field(searchHighlightExtension).between(0, edited.doc.length, (from, to) => {
      marks.push({ from, to });
    });
    expect(marks).toEqual([]);
  });
});
