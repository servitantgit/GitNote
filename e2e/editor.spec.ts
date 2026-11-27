import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Playwright creates a fresh browser context for each test, including a clean IndexedDB.
  await page.goto('/');
});

test('opens the workspace and initializes the local note', async ({ page }) => {
  await expect(page.getByText('GitNotes', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('list', { name: 'Список нотаток' })).toBeVisible();
  await expect(page.getByLabel('Назва нотатки')).toHaveValue('Моя перша нотатка');
  await expect(page.getByRole('tab', { name: 'Source' })).toHaveAttribute('aria-selected', 'true');
});

test('creates a note, autosaves its content and restores it after reload', async ({ page }) => {
  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  await page.getByLabel('Назва нотатки').fill('Browser test note');

  const editor = page.locator('.cm-content');
  await editor.fill('# Persisted heading\n\nText saved by the browser test.');

  const saveIndicator = page.locator('.save-indicator');
  await expect(saveIndicator).toHaveText('Збереження…');
  await expect(saveIndicator).toHaveText('Збережено локально');
  await page.reload();

  await expect(page.getByLabel('Назва нотатки')).toHaveValue('Browser test note');
  await expect(page.locator('.cm-content')).toContainText('Persisted heading');
  await expect(page.locator('.cm-content')).toContainText('Text saved by the browser test.');
});

test('switches between Source, Live Preview and Preview without losing content', async ({ page }) => {
  const editor = page.locator('.cm-content');
  await editor.fill('# Browser heading\n\n**Formatted text**');
  // Collapse the programmatic fill selection before checking rendered decorations.
  await editor.click({ position: { x: 8, y: 8 } });

  await page.getByRole('tab', { name: 'Live Preview' }).click();
  await expect(page.locator('.gn-heading-1')).toContainText('Browser heading');
  await expect(page.locator('.gn-strong')).toContainText('Formatted text');

  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.markdown-preview')).toBeVisible();
  await expect(page.locator('.markdown-preview h1')).toHaveText('Browser heading');
  await expect(page.locator('.markdown-preview strong')).toHaveText('Formatted text');

  await page.getByRole('tab', { name: 'Source' }).click();
  await expect(page.locator('.cm-content')).toContainText('**Formatted text**');
});

test('applies Markdown formatting from the toolbar to the selected text', async ({ page }) => {
  const editor = page.locator('.cm-content');
  await editor.fill('selected text');
  await editor.press('Control+A');
  await page.getByRole('button', { name: 'Жирний' }).click();
  await expect(editor).toContainText('**selected text**');
});

test('deletes a note after confirmation', async ({ page }) => {
  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  await page.getByLabel('Назва нотатки').fill('Note to delete');
  await expect(page.getByRole('list', { name: 'Список нотаток' })).toContainText('Note to delete');

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Видалити нотатку' }).click();

  await expect(page.getByRole('list', { name: 'Список нотаток' })).not.toContainText('Note to delete');
});


test('mouse selection in Live Preview keeps text and selects the intended phrase', async ({ page }) => {
  const editor = page.locator('.cm-content');
  const source = '**select this phrase** and keep the rest';

  await editor.fill(source);
  await page.getByRole('tab', { name: 'Live Preview' }).click();

  const point = await editor.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const index = node.textContent?.indexOf('select this phrase') ?? -1;
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 'select this phrase'.length);
      const rect = range.getBoundingClientRect();
      return {
        startX: rect.left + 1,
        endX: rect.right - 1,
        y: rect.top + rect.height / 2,
      };
    }
    throw new Error('Target phrase was not found in the editor DOM');
  });

  await page.mouse.move(point.startX, point.y);
  await page.mouse.down();
  await page.mouse.move(point.endX, point.y, { steps: 8 });
  await page.mouse.up();

  await expect(editor).toContainText(source);
  const selected = await editor.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected).toContain('select this phrase');
});


test('mouse selection in Source keeps text and selects the intended phrase', async ({ page }) => {
  const editor = page.locator('.cm-content');
  const source = 'select this phrase and keep the rest';

  await editor.fill(source);
  await editor.click({ position: { x: 8, y: 8 } });

  const point = await editor.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const index = node.textContent?.indexOf('select this phrase') ?? -1;
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 'select this phrase'.length);
      const rect = range.getBoundingClientRect();
      return {
        startX: rect.left + 1,
        endX: rect.right - 1,
        y: rect.top + rect.height / 2,
      };
    }
    throw new Error('Target phrase was not found in the editor DOM');
  });

  await page.mouse.move(point.startX, point.y);
  await page.mouse.down();
  await page.mouse.move(point.endX, point.y, { steps: 8 });
  await page.mouse.up();

  await expect(editor).toContainText(source);
  const selected = await editor.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected).toContain('select this phrase');
});
