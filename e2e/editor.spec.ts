import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Playwright creates a fresh browser context for each test, including a clean IndexedDB.
  await page.goto('/');
  await expect.poll(async () => {
    const alert = page.getByRole('alert');
    if (await alert.count()) return `error: ${await alert.innerText()}`;
    if (await page.getByLabel('Назва нотатки').count()) return 'ready';
    return 'loading';
  }, { message: 'The local workspace should initialize before editor tests run' }).toBe('ready');
});

test('opens the workspace and initializes the local note', async ({ page }) => {
  await expect(page.getByText('GitNotes', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('list', { name: 'Список нотаток' })).toBeVisible();
  await expect(page.getByLabel('Назва нотатки')).toHaveValue('Моя перша нотатка');
  await expect(page.getByRole('tab', { name: 'Source' })).toHaveAttribute('aria-selected', 'true');
});

test('creates a note, autosaves its content and restores it after reload', async ({ page }) => {
  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  await expect(page.getByRole('tab', { name: 'Без назви', exact: true })).toHaveCount(1);
  await expect(page.getByLabel('Назва нотатки')).toHaveValue('Без назви');
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
  await expect(page.getByRole('tab', { name: 'Без назви', exact: true })).toHaveCount(1);
  await page.getByLabel('Назва нотатки').fill('Note to delete');
  await expect(page.getByRole('list', { name: 'Список нотаток' })).toContainText('Note to delete');

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Видалити нотатку' }).click();

  await expect(page.getByRole('list', { name: 'Список нотаток' })).not.toContainText('Note to delete');
});

test('restores each note editor state and undo history after switching tabs', async ({ page }) => {
  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  await expect(page.getByRole('tab', { name: 'Без назви', exact: true })).toHaveCount(1);
  const editor = page.locator('.cm-content');

  await editor.fill('Note A');
  await editor.press('End');
  await editor.pressSequentially(' edited');
  await editor.press('Home');
  await editor.press('ArrowRight');

  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  await expect(page.getByRole('tab', { name: 'Без назви', exact: true })).toHaveCount(2);
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

test('restores one logical scroll position per note across Source and Preview', async ({ page }) => {
  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  await expect(page.getByRole('tab', { name: 'Без назви', exact: true })).toHaveCount(1);

  const content = Array.from({ length: 80 }, (_, index) =>
    `Paragraph ${index + 1} with enough text to occupy a visible line in the editor and preview.`,
  ).join('\n\n');
  const editor = page.locator('.cm-content');
  await editor.fill(content);

  const source = page.locator('.cm-scroller');
  await source.evaluate(element => { element.scrollTop = element.scrollHeight * 0.55; element.dispatchEvent(new Event('scroll')); });
  await expect.poll(() => source.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const initialSourceTop = await source.evaluate(element => element.scrollTop);

  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  await expect(page.getByRole('tab', { name: 'Без назви', exact: true })).toHaveCount(2);
  await page.getByRole('tab', { name: 'Без назви', exact: true }).first().click();
  await expect.poll(() => source.evaluate(element => element.scrollTop))
    .toBeGreaterThan(initialSourceTop * 0.8);

  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  const preview = page.locator('.markdown-preview');
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  await preview.evaluate(element => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.75;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const savedPreviewTop = await preview.evaluate(element => element.scrollTop);

  await page.getByRole('tab', { name: 'Source' }).click();
  await expect.poll(() => source.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect.poll(() => preview.evaluate(element => element.scrollTop))
    .toBeGreaterThan(savedPreviewTop * 0.8);

  await page.getByRole('tab', { name: 'Без назви', exact: true }).last().click();
  await page.getByRole('tab', { name: 'Без назви', exact: true }).first().click();
  await expect.poll(() => preview.evaluate(element => element.scrollTop))
    .toBeGreaterThan(savedPreviewTop * 0.8);
});

test('Ctrl+I applies italic formatting to the selected text', async ({ page }) => {
  const editor = page.locator('.cm-content');
  await editor.fill('selected text');
  await editor.press('Control+a');
  await editor.press('Control+i');
  await expect(editor).toContainText('*selected text*');
});

test('captures Source and Live Preview visual states for browser review', async ({ page }) => {
  const editor = page.locator('.cm-content');
  await editor.fill('# Visual heading\n\n**Formatted text**\n\n```ts\nconst value = 1;\n```');
  await page.screenshot({ path: 'test-results/gitnotes-source.png', fullPage: true });

  await page.getByRole('tab', { name: 'Live Preview' }).click();
  await expect(page.locator('.gn-heading-1')).toContainText('Visual heading');
  await expect(page.locator('.gn-strong')).toContainText('Formatted text');
  await page.screenshot({ path: 'test-results/gitnotes-live-preview.png', fullPage: true });
});

test('stores newly created notes as files in the local VFS', async ({ page }) => {
  await expect(page.getByLabel('Назва нотатки')).toHaveValue('Моя перша нотатка');
  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  await expect(page.getByRole('tab', { name: 'Без назви', exact: true })).toHaveCount(1);

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
  const note = vfs.notes.find(item => item.title === 'Без назви');
  expect(note?.path).toMatch(/^Notes\/.+\.md$/);
  expect(vfs.nodes).toContainEqual(expect.objectContaining({
    path: note?.path,
    kind: 'file',
    documentId: note?.id,
  }));
});

test('renames and moves VFS nodes atomically and recursively removes linked documents', async ({ page }) => {
  await expect(page.getByLabel('Назва нотатки')).toHaveValue('Моя перша нотатка');

  const result = await page.evaluate(async () => {
    const { workspaceFileSystem } = await import('/src/infrastructure/storage/local-workspace-file-system.ts');
    const { documentSource } = await import('/src/infrastructure/storage/local-document-source.ts');
    const { database } = await import('/src/infrastructure/storage/database.ts');
    const repositoryId = 'local-workspace';
    const id = crypto.randomUUID();
    const now = Date.now();

    await workspaceFileSystem.createFolder(repositoryId, 'Notes', 'VfsTest');
    await workspaceFileSystem.createFolder(repositoryId, 'Notes/VfsTest', 'Nested');
    await documentSource.create({
      id, repositoryId, title: 'VFS test document', syncState: 'local',
      createdAt: now, updatedAt: now,
    }, 'VFS test content');
    await workspaceFileSystem.registerDocument(repositoryId, id, 'Notes/VfsTest/Nested/file.md');

    await workspaceFileSystem.rename(repositoryId, 'Notes/VfsTest', 'VfsRenamed');
    await workspaceFileSystem.move(repositoryId, 'Notes/VfsRenamed/Nested/file.md', 'Notes/VfsRenamed');
    await workspaceFileSystem.rename(repositoryId, 'Notes/VfsRenamed/file.md', 'renamed.md');

    const updatedNote = await database.notes.get(id);
    await workspaceFileSystem.remove(repositoryId, 'Notes/VfsRenamed');
    const deletedNote = await database.notes.get(id);

    return { path: updatedNote?.path, deleted: deletedNote === undefined };
  });

  expect(result.path).toBe('Notes/VfsRenamed/renamed.md');
  expect(result.deleted).toBe(true);
});
