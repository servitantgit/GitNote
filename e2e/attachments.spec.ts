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
  await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
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


test('inserts note-owned images from the toolbar and renders them after reload', async ({ page }) => {
  await page.getByRole('tab', { name: 'Source' }).click();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=', 'base64');
  await page.getByLabel('Вибрати зображення').setInputFiles({
    name: 'tiny.png', mimeType: 'image/png', buffer: png,
  });
  const source = page.locator('.cm-content');
  await expect(source).toContainText('![tiny.png](attachment:');
  await page.waitForTimeout(700);

  await page.getByRole('tab', { name: 'Preview' }).click();
  const image = page.locator('.markdown-preview img');
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('src', /^blob:/);

  await page.reload();
  await page.getByRole('tab', { name: 'Preview' }).click();
  const restoredImage = page.locator('.markdown-preview img');
  await expect(restoredImage).toBeVisible();
  await expect(restoredImage).toHaveAttribute('src', /^blob:/);
});

test('pastes and drops image files into the active Markdown note', async ({ page }) => {
  await page.getByRole('tab', { name: 'Source' }).click();
  const source = page.locator('.cm-content');
  await source.evaluate(element => {
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'clipboard.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));

    const dropped = new DataTransfer();
    dropped.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'dropped.png', { type: 'image/png' }));
    const dragOver = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dropped });
    element.dispatchEvent(dragOver);
    expect(dragOver.defaultPrevented).toBe(true);
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dropped, clientX: 10, clientY: 10 }));
  });
  await expect(source).toContainText('![clipboard.png](attachment:');
  await expect(source).toContainText('![dropped.png](attachment:');
});
