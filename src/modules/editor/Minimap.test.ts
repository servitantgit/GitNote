import { describe, expect, it } from 'vitest';
import { buildMinimapLineKinds, positionAtMinimapRatio } from './Minimap';

describe('minimap document model', () => {
  it('classifies Markdown headings, fenced code and list blocks using the Lezer tree', () => {
    const content = [
      '# Heading',
      '',
      'Ordinary paragraph',
      '',
      '- first item',
      '- second item',
      '',
      '```ts',
      'const value = 1;',
      '```',
    ].join('\n');

    expect(buildMinimapLineKinds(content)).toEqual([
      'heading',
      'text',
      'text',
      'text',
      'list',
      'list',
      'text',
      'code',
      'code',
      'code',
    ]);
  });

  it('maps a minimap ratio to a fractional logical document position', () => {
    expect(positionAtMinimapRatio(0, 100)).toEqual({ line: 0, offset: 0 });
    expect(positionAtMinimapRatio(0.255, 100)).toEqual({ line: 25, offset: 0.5 });
    expect(positionAtMinimapRatio(1, 100)).toEqual({ line: 99, offset: 0.999 });
  });

  it('clamps pointer ratios and invalid values to the document range', () => {
    expect(positionAtMinimapRatio(-1, 10)).toEqual({ line: 0, offset: 0 });
    expect(positionAtMinimapRatio(2, 10)).toEqual({ line: 9, offset: 0.999 });
    expect(positionAtMinimapRatio(Number.NaN, 10)).toEqual({ line: 0, offset: 0 });
    expect(positionAtMinimapRatio(0.5, 0)).toEqual({ line: 0, offset: 0 });
  });
});
