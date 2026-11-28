import { expect, test } from '@playwright/test';

test('renames, moves by drag and drop, and recursively deletes workspace tree entries', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Назва нотатки')).toHaveValue('Моя перша нотатка');

  page.once('dialog', dialog => dialog.accept('Tree A'));
  await page.getByLabel('Створити папку').click();
  const treeA = page.getByRole('button', { name: 'Tree A', exact: true });
  await expect(treeA).toBeVisible();
  const treeAEntry = page.locator('.file-tree-entry').filter({ has: treeA });
  await expect(treeAEntry.locator('.file-tree-more')).toHaveCSS('opacity', '1');

  page.once('dialog', dialog => dialog.accept('Tree B'));
  await page.getByLabel('Створити папку').click();
  const treeB = page.getByRole('button', { name: 'Tree B', exact: true });
  await expect(treeB).toBeVisible();

  await treeA.click();
  await page.getByLabel('Файл для імпорту').setInputFiles({
    name: 'sample.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf5sAAAAASUVORK5CYII=', 'base64'),
  });
  const sample = page.getByRole('button', { name: 'sample.png', exact: true });
  await expect(sample).toBeVisible();
  const sampleEntry = page.locator('.file-tree-entry').filter({ has: sample });
  await expect(sampleEntry.locator('.file-tree-more')).toHaveCSS('opacity', '1');

  await sampleEntry.locator('.file-tree-more').click();
  page.once('dialog', dialog => dialog.accept('renamed.png'));
  await page.getByRole('menuitem', { name: 'Перейменувати' }).click();
  const renamed = page.getByRole('button', { name: 'renamed.png', exact: true });
  await expect(renamed).toBeVisible();

  await page.locator('.file-tree-entry').filter({ has: page.getByRole('button', { name: 'renamed.png', exact: true }) }).locator('.file-tree-more').click();
  await page.getByLabel('Перемістити renamed.png до папки').selectOption('Tree B');
  await page.getByRole('button', { name: 'Перемістити', exact: true }).click();
  await treeB.click();
  const moved = page.getByRole('button', { name: 'renamed.png', exact: true });
  await expect(moved).toBeVisible();

  await moved.dragTo(treeA);
  await expect.poll(async () => page.evaluate(async () => {
    const request = indexedDB.open('gitnote-local');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const nodes = await new Promise<Array<{ path: string }>>((resolve, reject) => {
      const transaction = db.transaction('fileNodes', 'readonly');
      const get = transaction.objectStore('fileNodes').getAll();
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    db.close();
    return nodes.some(node => node.path === 'Tree A/renamed.png');
  })).toBe(true);

  await treeA.locator('..').locator('.file-tree-more').click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('menuitem', { name: 'Видалити' }).click();
  await expect(treeA).toHaveCount(0);

  const remaining = await page.evaluate(async () => {
    const request = indexedDB.open('gitnote-local');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction(['fileNodes', 'binaryDocuments'], 'readonly');
    const nodesRequest = transaction.objectStore('fileNodes').getAll();
    const binariesRequest = transaction.objectStore('binaryDocuments').getAll();
    const result = await new Promise<{ paths: string[]; binaryCount: number }>((resolve, reject) => {
      transaction.oncomplete = () => resolve({
        paths: nodesRequest.result.map((node: { path: string }) => node.path),
        binaryCount: binariesRequest.result.length,
      });
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    return result;
  });
  expect(remaining.paths.some(path => path === 'Tree A' || path.startsWith('Tree A/'))).toBe(false);
  expect(remaining.binaryCount).toBe(0);
});
