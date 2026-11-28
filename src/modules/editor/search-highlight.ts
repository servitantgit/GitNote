import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import type { SearchMatchRange } from '../search/search-query';

interface SearchHighlightEffect {
  ranges: SearchMatchRange[];
  activeIndex: number;
}

export const setSearchHighlights = StateEffect.define<SearchHighlightEffect>();

export const searchHighlightExtension = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    if (transaction.docChanged) decorations = Decoration.none;

    for (const effect of transaction.effects) {
      if (!effect.is(setSearchHighlights)) continue;
      const { ranges, activeIndex } = effect.value;
      decorations = Decoration.set(
        ranges
          .filter(range => range.from >= 0 && range.to > range.from && range.to <= transaction.newDoc.length)
          .map((range, index) => Decoration.mark({
            class: index === activeIndex ? 'cm-search-match-current' : 'cm-search-match',
          }).range(range.from, range.to)),
        true,
      );
    }

    return decorations;
  },
  provide: field => EditorView.decorations.from(field),
});
