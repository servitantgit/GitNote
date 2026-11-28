import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect.poll(async () => {
    if (await page.getByRole('alert').count()) return 'error';
    if (await page.getByLabel('Назва нотатки').count()) return 'ready';
    return 'loading';
  }).toBe('ready');
});

test('adds, restores, downloads and removes note-owned attachments', async ({ page }) => {
  await page.getByRole('button', { name: 'Вкладені файли' }).click();
  const dialog = page.getByRole('dialog', { name: 'Вкладені файли' });
  await expect(dialog.getByText('До цієї нотатки ще не додано файлів')).toBeVisible();
  await dialog.getByLabel('Файли для вкладення').setInputFiles({ name: 'reference.txt', mimeType: 'text/plain', buffer: Buffer.from('attachment payload') });
  const item = dialog.getByTestId('attachment-item');
  await expect(item.getByText('reference.txt')).toBeVisible();
  await expect(item.getByText(/18 Б/)).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: 'Вкладені файли' }).click();
  const restored = page.getByRole('dialog', { name: 'Вкладені файли' });
  const restoredItem = restored.getByTestId('attachment-item');
  await expect(restoredItem.getByText('reference.txt')).toBeVisible();
  const download = page.waitForEvent('download');
  await restoredItem.getByRole('button', { name: 'Завантажити reference.txt' }).click();
  expect((await download).suggestedFilename()).toBe('reference.txt');

  page.once('dialog', dialogEvent => dialogEvent.accept());
  await restoredItem.getByRole('button', { name: 'Видалити вкладення reference.txt' }).click();
  await expect(restored.getByText('До цієї нотатки ще не додано файлів')).toBeVisible();
});

test('deleting a note removes its owned attachments', async ({ page }) => {
  await page.getByRole('button', { name: 'Вкладені файли' }).click();
  const dialog = page.getByRole('dialog', { name: 'Вкладені файли' });
  await dialog.getByLabel('Файли для вкладення').setInputFiles({ name: 'owned.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([1, 2, 3, 4]) });
  await expect(dialog.getByTestId('attachment-item')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Закрити' }).click();
  page.once('dialog', dialogEvent => dialogEvent.accept());
  await page.getByRole('button', { name: 'Видалити нотатку' }).click();
  await expect(page.getByLabel('Назва нотатки')).toBeVisible();
  const count = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gitnote-local');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = await new Promise<number>((resolve, reject) => {
      const request = db.transaction('noteAttachments', 'readonly').objectStore('noteAttachments').count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close(); return result;
  });
  expect(count).toBe(0);
});
