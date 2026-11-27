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

test('switches between Source, Live and Preview without losing content', async ({ page }) => {
  const editor = page.locator('.cm-content');
  await editor.fill('# Browser heading\n\n**Formatted text**');

  await page.getByRole('tab', { name: 'Live', exact: true }).click();
  await expect(page.locator('.editor-main.live-mode')).toBeVisible();
  await expect(editor).toBeVisible();
  await expect(page.locator('.markdown-preview h1')).toHaveText('Browser heading');
  await expect(page.locator('.markdown-preview strong')).toHaveText('Formatted text');

  await editor.fill('# Updated heading\n\n**Updated text**');
  await expect(page.locator('.markdown-preview h1')).toHaveText('Updated heading');
  await expect(page.locator('.markdown-preview strong')).toHaveText('Updated text');

  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.markdown-preview')).toBeVisible();
  await expect(page.locator('.markdown-preview h1')).toHaveText('Updated heading');

  await page.getByRole('tab', { name: 'Source' }).click();
  await expect(editor).toContainText('**Updated text**');
});

test('wraps long Markdown lines in Source and Live without horizontal overflow', async ({ page }) => {
  const longLine = Array.from({ length: 90 }, (_, index) => `word${index + 1}`).join(' ');
  const editor = page.locator('.cm-content');
  const scroller = page.locator('.cm-scroller');
  await editor.fill(longLine);

  const assertWrapped = async () => {
    const metrics = await scroller.evaluate(element => {
      const line = element.querySelector('.cm-line');
      if (!line) return null;
      return {
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        lineHeight: Number.parseFloat(getComputedStyle(line).lineHeight),
        renderedHeight: line.getBoundingClientRect().height,
      };
    });
    expect(metrics).not.toBeNull();
    expect(metrics!.scrollWidth).toBeLessThanOrEqual(metrics!.clientWidth + 1);
    expect(metrics!.renderedHeight).toBeGreaterThan(metrics!.lineHeight * 2);
  };

  await assertWrapped();
  await page.getByRole('tab', { name: 'Live', exact: true }).click();
  await expect(page.locator('.editor-main.live-mode')).toBeVisible();
  await assertWrapped();
  await expect(page.locator('.markdown-preview')).toContainText('word90');
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
    `## Section ${index + 1} with enough text to wrap across multiple visual rows in the narrower Live source pane and remain a distinct heading in the rendered preview.`,
  ).join('\\n');
  const editor = page.locator('.cm-content');
  await editor.fill(content);

  type LogicalPosition = { line: number; offset: number };
  type ScrollDebugState = {
    coordinator: LogicalPosition;
    source: LogicalPosition | null;
  };
  const readScrollState = () => page.evaluate(() => {
    const hook = (window as Window & {
      __gitnoteScrollDebug?: {
        readCoordinatorPosition: () => LogicalPosition;
        readSourcePosition: () => LogicalPosition | null;
      };
    }).__gitnoteScrollDebug;
    return hook ? {
      coordinator: hook.readCoordinatorPosition(),
      source: hook.readSourcePosition(),
    } : null;
  });
  const matchesPosition = (
    actual: LogicalPosition | null,
    expected: LogicalPosition,
  ) => Boolean(actual
    && Math.abs(actual.line - expected.line) < 0.02
    && Math.abs(actual.offset - expected.offset) < 0.03);

  const source = page.locator('.cm-scroller');
  const preview = page.locator('.markdown-preview');
  await source.evaluate(element => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.55;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(async () => (await readScrollState())?.coordinator.line ?? 0)
    .toBeGreaterThan(0);
  const initialState = await readScrollState();
  expect(initialState).not.toBeNull();
  if (!initialState) throw new Error('Scroll debug hook is unavailable');
  expect(matchesPosition(initialState.source, initialState.coordinator)).toBe(true);
  const initialSourceTop = await source.evaluate(element => element.scrollTop);

  // The coordinator and the CodeMirror adapter must retain the same logical
  // position when Live changes the source pane width and wraps lines differently.
  await page.getByRole('tab', { name: 'Live' }).click();
  await expect(page.locator('.editor-main.live-mode')).toBeVisible();
  await expect.poll(async () => {
    const next = await readScrollState();
    return Boolean(next
      && matchesPosition(next.coordinator, initialState.coordinator)
      && matchesPosition(next.source, initialState.coordinator));
  }).toBe(true);
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  const previewTopBeforeSourceScroll = await preview.evaluate(element => element.scrollTop);
  await source.evaluate(element => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.65;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => preview.evaluate(element => element.scrollTop))
    .not.toBe(previewTopBeforeSourceScroll);
  await expect.poll(async () => {
    const before = await preview.evaluate(element => element.scrollTop);
    await page.waitForTimeout(50);
    const after = await preview.evaluate(element => element.scrollTop);
    return Math.abs(after - before) < 0.5;
  }).toBe(true);

  const liveState = await readScrollState();
  expect(liveState).not.toBeNull();
  if (!liveState) throw new Error('Scroll debug hook is unavailable');
  expect(matchesPosition(liveState.source, liveState.coordinator)).toBe(true);
  const liveLogicalPosition = liveState.coordinator;

  await page.getByRole('tab', { name: 'Source' }).click();
  await expect(page.locator('.editor-main.live-mode')).toHaveCount(0);
  await page.waitForFunction(() => {
    const scroller = document.querySelector('.cm-scroller');
    return scroller instanceof HTMLElement && scroller.clientWidth > 0;
  });
  await expect.poll(async () => {
    const next = await readScrollState();
    return Boolean(next
      && matchesPosition(next.coordinator, liveLogicalPosition)
      && matchesPosition(next.source, liveLogicalPosition));
  }).toBe(true);

  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  await expect(page.getByRole('tab', { name: 'Без назви', exact: true })).toHaveCount(2);
  await page.getByRole('tab', { name: 'Без назви', exact: true }).first().click();
  await expect.poll(() => source.evaluate(element => element.scrollTop))
    .toBeGreaterThan(initialSourceTop * 0.8);

  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
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

test('captures Source and Live visual states for browser review', async ({ page }) => {
  const editor = page.locator('.cm-content');
  await editor.fill('# Visual heading\n\n**Formatted text**\n\n```ts\nconst value = 1;\n```');
  await page.screenshot({ path: 'test-results/gitnotes-source.png', fullPage: true });

  await page.getByRole('tab', { name: 'Live' }).click();
  await expect(page.locator('.editor-main.live-mode')).toBeVisible();
  await expect(page.locator('.markdown-preview h1')).toContainText('Visual heading');
  await expect(page.locator('.markdown-preview strong')).toContainText('Formatted text');
  await page.screenshot({ path: 'test-results/gitnotes-live.png', fullPage: true });
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

test('keeps independent scroll positions for two notes across all editor modes', async ({ page }) => {
  const editor = page.locator('.cm-content');
  const source = page.locator('.cm-scroller');
  const tabs = page.getByRole('tab', { name: 'Без назви', exact: true });

  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  await expect(tabs).toHaveCount(1);
  await editor.fill(Array.from({ length: 100 }, (_, index) => `Note A paragraph ${index + 1}`).join('\n\n'));
  await source.evaluate(element => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.3;
    element.dispatchEvent(new Event('scroll'));
  });
  const noteAScroll = await source.evaluate(element => element.scrollTop);

  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  await expect(tabs).toHaveCount(2);
  await editor.fill(Array.from({ length: 100 }, (_, index) => `Note B paragraph ${index + 1}`).join('\n\n'));
  await source.evaluate(element => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.72;
    element.dispatchEvent(new Event('scroll'));
  });
  const noteBScroll = await source.evaluate(element => element.scrollTop);
  expect(noteBScroll).toBeGreaterThan(noteAScroll * 1.5);

  await tabs.first().click();
  await expect.poll(() => source.evaluate(element => element.scrollTop))
    .toBeGreaterThan(noteAScroll * 0.8);
  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  const preview = page.locator('.markdown-preview');
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  await tabs.last().click();
  await page.getByRole('tab', { name: 'Source' }).click();
  await expect.poll(() => source.evaluate(element => element.scrollTop))
    .toBeGreaterThan(noteBScroll * 0.8);
  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  await tabs.first().click();
  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
});



test('Live shows Source and Preview together with bidirectional synchronized scrolling', async ({ page }) => {
  const content = Array.from({ length: 100 }, (_, index) =>
    `## Live section ${index + 1}\n\nParagraph ${index + 1} with enough text to create a scrollable rendered preview and editor surface.`,
  ).join('\n\n');
  const editor = page.locator('.cm-content');
  await editor.fill(content);
  await page.getByRole('tab', { name: 'Live', exact: true }).click();

  const split = page.locator('.editor-main.live-mode');
  const source = page.locator('.cm-scroller');
  const preview = page.locator('.markdown-preview');
  await expect(split).toBeVisible();
  await expect(source).toBeVisible();
  await expect(preview).toBeVisible();
  await expect(preview.locator('h2').first()).toHaveText('Live section 1');

  const widths = await Promise.all([
    page.locator('.source-editor').evaluate(element => element.getBoundingClientRect().width),
    preview.evaluate(element => element.getBoundingClientRect().width),
  ]);
  expect(Math.abs(widths[0] - widths[1])).toBeLessThan(12);

  await editor.fill(content + '\n\n## Newly edited section');
  await expect(preview.locator('h2').last()).toHaveText('Newly edited section');

  await source.evaluate(element => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.68;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const sourceBeforeReverse = await source.evaluate(element => element.scrollTop);

  await preview.evaluate(element => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.24;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => source.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(async () => Math.abs(
    (await source.evaluate(element => element.scrollTop)) - sourceBeforeReverse,
  )).toBeGreaterThan(100);

  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(preview).toBeVisible();
  await page.getByRole('tab', { name: 'Source' }).click();
  await expect(editor).toContainText('Newly edited section');
});

test('Live responds to small mouse-wheel increments', async ({ page }) => {
  const content = Array.from({ length: 120 }, (_, index) =>
    `Paragraph ${index + 1} with enough text to occupy a visible line in the rendered preview.`,
  ).join('\n\n');
  await page.locator('.cm-content').fill(content);
  await page.getByRole('tab', { name: 'Live', exact: true }).click();

  const preview = page.locator('.markdown-preview');
  await expect(preview).toBeVisible();
  const bounds = await preview.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(
    (bounds?.x ?? 0) + (bounds?.width ?? 0) / 2,
    (bounds?.y ?? 0) + (bounds?.height ?? 0) / 2,
  );

  // Fractional wheel deltas model a deliberately slow wheel movement. These
  // must not be mistaken for the coordinator's pending programmatic echo.
  for (let index = 0; index < 12; index += 1) {
    await page.mouse.wheel(0, 0.25);
  }

  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0.5);
  await expect.poll(() => page.locator('.cm-scroller').evaluate(element => element.scrollTop))
    .toBeGreaterThan(0);
});

test('minimap follows the active editor surface and drives synchronized scrolling', async ({ page }) => {
  const content = Array.from({ length: 90 }, (_, index) =>
    '## Section ' + (index + 1) + '\n\nParagraph ' + (index + 1) + ' with enough content to create a scrollable document.',
  ).join('\n\n');
  await page.locator('.cm-content').fill(content);

  await page.getByRole('button', { name: 'Показати мінімапу' }).click();
  const minimap = page.getByRole('img', { name: 'Мінімапа документа' });
  await expect(minimap).toBeVisible();

  const bounds = await minimap.boundingBox();
  expect(bounds).not.toBeNull();
  const source = page.locator('.cm-scroller');
  await minimap.click({ position: { x: 45, y: Math.floor((bounds?.height ?? 1) * 0.78) } });
  await expect.poll(() => source.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  await page.getByRole('tab', { name: 'Live' }).click();
  const livePreviewTop = await source.evaluate(element => element.scrollTop);
  await minimap.click({ position: { x: 45, y: Math.floor((bounds?.height ?? 1) * 0.46) } });
  await expect.poll(async () => Math.abs(
    (await source.evaluate(element => element.scrollTop)) - livePreviewTop,
  )).toBeGreaterThan(100);

  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  const preview = page.locator('.markdown-preview');
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  const previewBounds = await minimap.boundingBox();
  expect(previewBounds).not.toBeNull();
  await minimap.click({ position: { x: 45, y: Math.floor((previewBounds?.height ?? 1) * 0.32) } });
  const previewMax = await preview.evaluate(element => element.scrollHeight - element.clientHeight);
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeLessThan(previewMax * 0.6);

  const dragStart = { x: (previewBounds?.x ?? 0) + 45, y: (previewBounds?.y ?? 0) + 20 };
  const dragEnd = { x: dragStart.x, y: (previewBounds?.y ?? 0) + (previewBounds?.height ?? 1) * 0.7 };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(previewMax * 0.4);

  await page.getByRole('button', { name: 'Приховати мінімапу' }).click();
  await expect(minimap).toBeHidden();
});
