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

  it('does not treat the first document line as preceding context', () => {
    const doc = Text.of(['```ts', 'const value = 1;', '```']);
    expect(getFenceStateBeforeLine(doc, 1)).toBeNull();
    expect(getFenceStateBeforeLine(doc, 2)).toEqual({ marker: '`', length: 3 });
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

test('captures Source and Live Preview visual states for browser review', async ({ page }) => {
  const editor = page.locator('.cm-content');
  await editor.fill('# Visual heading\\n\\n**Formatted text**\\n\\n```ts\\nconst value = 1;\\n```');
  await page.screenshot({ path: 'test-results/gitnotes-source.png', fullPage: true });

  await page.getByRole('tab', { name: 'Live Preview' }).click();
  await expect(page.locator('.gn-heading-1')).toContainText('Visual heading');
  await expect(page.locator('.gn-strong')).toContainText('Formatted text');
  await page.screenshot({ path: 'test-results/gitnotes-live-preview.png', fullPage: true });
});

test('stores newly created notes as files in the local VFS', async ({ page }) => {
  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  const vfs = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gitnote-local');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<{ notes: Array<{ id: string; path?: string; content: string }>; nodes: Array<{ path: string; kind: string; documentId?: string }> }>((resolve, reject) => {
      const transaction = db.transaction(['notes', 'fileNodes'], 'readonly');
      const notesRequest = transaction.objectStore('notes').getAll();
      const nodesRequest = transaction.objectStore('fileNodes').getAll();
      transaction.oncomplete = () => resolve({ notes: notesRequest.result, nodes: nodesRequest.result });
      transaction.onerror = () => reject(transaction.error);
    });
  });
  const note = vfs.notes.find(item => item.content === '');
  expect(note?.path).toMatch(/^Notes\/.+\.md$/);
  expect(vfs.nodes).toContainEqual(expect.objectContaining({
    path: note?.path,
    kind: 'file',
    documentId: note?.id,
  }));
});
