import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect.poll(async () => {
    if (await page.getByRole('alert').count()) return 'error';
    if (await page.getByLabel('Назва нотатки').count()) return 'ready';
    return 'loading';
  }).toBe('ready');
});

test('persists appearance and editor preferences across reload', async ({ page }) => {
  await page.getByRole('button', { name: 'Налаштування' }).click();
  const dialog = page.getByRole('dialog', { name: 'Налаштування' });
  await dialog.getByLabel('Тема інтерфейсу').selectOption('dark');
  await dialog.getByLabel('Розмір шрифту редактора').selectOption('16');
  await dialog.getByLabel('Режим Markdown за замовчуванням').selectOption('live');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(async () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gitnote-local');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = await new Promise<{ value?: { theme?: string; editorFontSize?: number; defaultMode?: string } } | undefined>((resolve, reject) => {
      const request = db.transaction('settings', 'readonly').objectStore('settings').get('default');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return record?.value ?? null;
  })).toMatchObject({ theme: 'dark', editorFontSize: 16, defaultMode: 'live' });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.mode-switch [data-mode="live"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.editor-frame')).toHaveCSS('--editor-font-size', '16px');
  await expect(page.locator('.cm-editor')).toHaveCSS('background-color', 'rgb(32, 38, 48)');
  await expect(page.locator('.cm-editor')).toHaveCSS('color', 'rgb(231, 235, 241)');
  await expect(page.locator('.markdown-preview')).toHaveCSS('background-color', 'rgb(32, 38, 48)');
  await page.locator('.mode-switch [data-mode="source"]').click();
  await expect(page.locator('.cm-editor')).toHaveCSS('background-color', 'rgb(32, 38, 48)');
});


test('persists the Black OLED theme and applies it to Markdown surfaces', async ({ page }) => {
  await page.getByRole('button', { name: 'Налаштування' }).click();
  const dialog = page.getByRole('dialog', { name: 'Налаштування' });
  await dialog.getByLabel('Тема інтерфейсу').selectOption('black');

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'black');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(9, 11, 14)');
  await expect(page.locator('.cm-editor')).toHaveCSS('background-color', 'rgb(9, 11, 14)');
  await expect(page.locator('.markdown-preview')).toHaveCSS('background-color', 'rgb(9, 11, 14)');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'black');
  await expect(page.locator('.cm-editor')).toHaveCSS('background-color', 'rgb(9, 11, 14)');
  await expect(page.locator('.markdown-preview')).toHaveCSS('background-color', 'rgb(9, 11, 14)');
});

test('persists editor layout toggles and does not restore tabs when disabled', async ({ page }) => {
  await page.getByRole('button', { name: 'Налаштування' }).click();
  const dialog = page.getByRole('dialog', { name: 'Налаштування' });
  await dialog.getByLabel('Показувати номери рядків').uncheck();
  await dialog.getByLabel('Автоматично відкривати зміст').check();
  await dialog.getByLabel('Відновлювати відкриті вкладки після запуску').uncheck();
  await expect.poll(async () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gitnote-local');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = await new Promise<{ value?: { restoreTabs?: boolean } } | undefined>((resolve, reject) => {
      const request = db.transaction('settings', 'readonly').objectStore('settings').get('default');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return record?.value?.restoreTabs;
  })).toBe(false);
  await dialog.getByRole('button', { name: 'Закрити налаштування' }).click();
  await expect(page.locator('.editor-outline')).toBeVisible();
  await page.reload();
  await expect(page.locator('.document-tabs [role="tab"]')).toHaveCount(0);
  await expect(page.locator('.empty-workspace')).toBeVisible();
  await page.getByRole('button', { name: 'Налаштування' }).click();
  await expect(page.getByRole('dialog', { name: 'Налаштування' }).getByLabel('Показувати номери рядків')).not.toBeChecked();
});
