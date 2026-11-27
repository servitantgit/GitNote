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

test('restores each note editor state and undo history after switching tabs', async ({ page }) => {
  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  const editor = page.locator('.cm-content');

  await editor.fill('Note A');
  await editor.press('End');
  await editor.pressSequentially(' edited');
  await editor.press('Home');
  await editor.press('ArrowRight');

  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  await editor.fill('Note B');

  await page.getByRole('tab', { name: 'Без назви', exact: true }).first().click();
  await expect(editor).toContainText('Note A edited');

  // The caret was between the first and second characters when this tab was left.
  await editor.pressSequentially('X');
  await expect(editor).toContainText('NXote A edited');

  // Undo must operate on note A's own history, never note B's.
  await editor.press('Control+z');
  await expect(editor).toContainText('Note A edited');
  await expect(editor).not.toContainText('Note B');

  await page.getByRole('tab', { name: 'Без назви', exact: true }).last().click();
  await expect(editor).toContainText('Note B');
});

test('Ctrl+I applies italic formatting to the selected text', async ({ page }) => {
  const editor = page.locator('.cm-content');
  await editor.fill('selected text');
  await editor.press('Control+a');
  await editor.press('Control+i');
  await expect(editor).toContainText('*selected text*');
});
