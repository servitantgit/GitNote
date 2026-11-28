import { expect, test, type Page } from '@playwright/test';

const databaseName = 'gitnote-local';
const repositoryId = 'local-workspace';

async function seedLegacyDatabase(
  page: Page,
  version: 1 | 2 | 3 | 4 | 6,
  data: {
    notes?: Array<Record<string, unknown>>;
    draft?: Record<string, unknown>;
    workspace?: Record<string, unknown>;
    fileNodes?: Array<Record<string, unknown>>;
    binaryDocuments?: Array<Record<string, unknown>>;
  } = {},
) {
  // IndexedDB is unavailable on about:blank because it has an opaque origin.
  // Use an inert document served on the app's origin without booting the app.
  await page.route('**/__playwright_seed__', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><body></body></html>',
  }));
  await page.goto('/__playwright_seed__');
  await page.evaluate(({ databaseName, version, data }) => new Promise<void>((resolve, reject) => {
    // Dexie maps schema version 1.0 to native IndexedDB version 10, 2.0 to 20, etc.
    // Seed the same native version used by a real database created through Dexie.
    const request = indexedDB.open(databaseName, version * 10);
    request.onupgradeneeded = () => {
      const db = request.result;
      const drafts = db.createObjectStore('drafts', { keyPath: 'id' });
      for (const index of ['repositoryId', 'path', 'updatedAt']) drafts.createIndex(index, index);

      if (version >= 2) {
        const notes = db.createObjectStore('notes', { keyPath: 'id' });
        for (const index of ['repositoryId', 'title', 'createdAt', 'updatedAt']) notes.createIndex(index, index);
        if (version >= 4) {
          notes.createIndex('path', 'path');
          notes.createIndex('syncState', 'syncState');
        }
        for (const note of data.notes ?? []) notes.add(note);
      }

      if (version >= 3) {
        const workspaces = db.createObjectStore('workspaces', { keyPath: 'id' });
        workspaces.createIndex('updatedAt', 'updatedAt');
        if (data.workspace) workspaces.add(data.workspace);
      }
      if (version >= 5) {
        const nodes = db.createObjectStore('fileNodes', { keyPath: 'id' });
        nodes.createIndex('repositoryId', 'repositoryId');
        nodes.createIndex('[repositoryId+path]', ['repositoryId', 'path']);
        nodes.createIndex('[repositoryId+parentPath]', ['repositoryId', 'parentPath']);
        nodes.createIndex('[repositoryId+kind]', ['repositoryId', 'kind']);
        nodes.createIndex('documentId', 'documentId');
        for (const node of data.fileNodes ?? []) nodes.add(node);
      }

      if (version >= 6) {
        const binaries = db.createObjectStore('binaryDocuments', { keyPath: 'id' });
        for (const index of ['repositoryId', 'title', 'createdAt', 'updatedAt', 'path', 'syncState']) {
          binaries.createIndex(index, index);
        }
        for (const document of data.binaryDocuments ?? []) {
          binaries.add({
            ...document,
            content: new Blob(['legacy binary payload'], { type: String(document.mediaType ?? 'application/octet-stream') }),
          });
        }
      }

      if (data.draft) drafts.add(data.draft);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (db.version !== version * 10) {
        db.close();
        reject(new Error(`Expected native IndexedDB version ${version * 10}, received ${db.version}.`));
        return;
      }
      db.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  }), { databaseName, version, data });
}

async function readDatabase(page: Page) {
  return page.evaluate(databaseName => new Promise<{
    nativeVersion: number;
    drafts: Array<Record<string, unknown>>;
    notes: Array<Record<string, unknown>>;
    nodes: Array<Record<string, unknown>>;
    binaryDocuments: Array<{ id: string; title: string; mediaType: string; contentSize: number }>;
    searchIndex?: { count: number; indexes: Array<{ name: string; multiEntry: boolean }> };
    workspace?: Record<string, unknown>;
  }>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const stores = ['drafts', 'notes', 'fileNodes', 'workspaces', 'binaryDocuments', 'searchDocuments'].filter(name => db.objectStoreNames.contains(name));
      const result: {
        nativeVersion: number;
        drafts: Array<Record<string, unknown>>;
        notes: Array<Record<string, unknown>>;
        nodes: Array<Record<string, unknown>>;
        binaryDocuments: Array<{ id: string; title: string; mediaType: string; contentSize: number }>;
        searchIndex?: { count: number; indexes: Array<{ name: string; multiEntry: boolean }> };
        workspace?: Record<string, unknown>;
      } = { nativeVersion: db.version, drafts: [], notes: [], nodes: [], binaryDocuments: [] };
      const transaction = db.transaction(stores, 'readonly');
      if (stores.includes('drafts')) transaction.objectStore('drafts').getAll().onsuccess = event => {
        result.drafts = (event.target as IDBRequest).result;
      };
      if (stores.includes('notes')) transaction.objectStore('notes').getAll().onsuccess = event => {
        result.notes = (event.target as IDBRequest).result;
      };
      if (stores.includes('fileNodes')) transaction.objectStore('fileNodes').getAll().onsuccess = event => {
        result.nodes = (event.target as IDBRequest).result;
      };
      if (stores.includes('workspaces')) transaction.objectStore('workspaces').get('default').onsuccess = event => {
        result.workspace = (event.target as IDBRequest).result;
      };
      if (stores.includes('binaryDocuments')) transaction.objectStore('binaryDocuments').getAll().onsuccess = event => {
        result.binaryDocuments = ((event.target as IDBRequest).result as Array<Record<string, unknown>>).map(document => ({
          id: String(document.id),
          title: String(document.title),
          mediaType: String(document.mediaType),
          contentSize: (document.content as Blob).size,
        }));
      };
      if (stores.includes('searchDocuments')) {
        const store = transaction.objectStore('searchDocuments');
        result.searchIndex = {
          count: 0,
          indexes: Array.from(store.indexNames).map(name => ({ name, multiEntry: store.index(name).multiEntry })),
        };
        store.count().onsuccess = event => { result.searchIndex!.count = (event.target as IDBRequest<number>).result; };
      }
      transaction.oncomplete = () => {
        db.close();
        resolve(result);
      };
      transaction.onerror = () => reject(transaction.error);
    };
  }), databaseName);
}


test('upgrades a version 6 database by adding the search index without changing existing data', async ({ page }) => {
  const noteId = 'legacy-note-v6';
  const binaryId = 'legacy-binary-v6';
  await seedLegacyDatabase(page, 6, {
    notes: [{
      id: noteId,
      repositoryId,
      title: 'Version six note',
      content: 'Existing Markdown content must survive',
      path: 'Notes/version-six.md',
      syncState: 'dirty',
      baseSha: 'legacy-base-sha',
      createdAt: 600,
      updatedAt: 700,
    }],
    fileNodes: [
      {
        id: 'legacy-v6-note-node',
        repositoryId,
        path: 'Notes/version-six.md',
        parentPath: 'Notes',
        name: 'version-six.md',
        kind: 'file',
        documentId: noteId,
        createdAt: 600,
        updatedAt: 700,
      },
      {
        id: 'legacy-v6-binary-node',
        repositoryId,
        path: 'Documents/keep.txt',
        parentPath: 'Documents',
        name: 'keep.txt',
        kind: 'file',
        documentId: binaryId,
        createdAt: 610,
        updatedAt: 710,
      },
    ],
    binaryDocuments: [{
      id: binaryId,
      repositoryId,
      title: 'keep.txt',
      mediaType: 'text/plain',
      size: 21,
      syncState: 'clean',
      createdAt: 610,
      updatedAt: 710,
      path: 'Documents/keep.txt',
    }],
  });

  await page.goto('/');
  await expect(page.getByLabel('Назва нотатки')).toHaveValue('Version six note');
  const stored = await readDatabase(page);
  expect(stored.nativeVersion).toBe(80);
  expect(stored.notes).toContainEqual(expect.objectContaining({
    id: noteId,
    content: 'Existing Markdown content must survive',
    path: 'Notes/version-six.md',
    syncState: 'dirty',
    baseSha: 'legacy-base-sha',
  }));
  expect(stored.nodes).toContainEqual(expect.objectContaining({
    id: 'legacy-v6-note-node',
    documentId: noteId,
    path: 'Notes/version-six.md',
  }));
  expect(stored.nodes).toContainEqual(expect.objectContaining({
    id: 'legacy-v6-binary-node',
    documentId: binaryId,
    path: 'Documents/keep.txt',
  }));
  expect(stored.binaryDocuments).toContainEqual(expect.objectContaining({
    id: binaryId,
    title: 'keep.txt',
    mediaType: 'text/plain',
    contentSize: 21,
  }));
  expect(stored.searchIndex).toEqual(expect.objectContaining({
    count: 0,
    indexes: expect.arrayContaining([
      expect.objectContaining({ name: 'documentType', multiEntry: false }),
      expect.objectContaining({ name: 'sourceUpdatedAt', multiEntry: false }),
      expect.objectContaining({ name: 'grams', multiEntry: true }),
    ]),
  }));
});

test('upgrades a version 1 database without losing existing drafts', async ({ page }) => {
  await seedLegacyDatabase(page, 1, {
    draft: {
      id: 'legacy-draft-v1',
      repositoryId,
      path: 'Notes/draft.md',
      content: 'Draft from schema version 1',
      updatedAt: 100,
    },
  });

  await page.goto('/');
  await expect(page.getByLabel('Назва нотатки')).toHaveValue('Моя перша нотатка');
  const stored = await readDatabase(page);
  expect(stored.nativeVersion).toBe(80);
  expect(stored.drafts).toContainEqual(expect.objectContaining({
    id: 'legacy-draft-v1',
    content: 'Draft from schema version 1',
  }));
  expect(stored.notes.length).toBe(1);
  expect(stored.nodes).toContainEqual(expect.objectContaining({ kind: 'folder', path: 'Notes' }));
});

test('upgrades version 2 notes into VFS files without changing document IDs or content', async ({ page }) => {
  await seedLegacyDatabase(page, 2, {
    notes: [{
      id: 'legacy-note-v2',
      repositoryId,
      title: 'Legacy note',
      content: 'Content from schema version 2',
      createdAt: 200,
      updatedAt: 300,
    }],
  });

  await page.goto('/');
  await expect(page.getByLabel('Назва нотатки')).toHaveValue('Legacy note');
  const stored = await readDatabase(page);
  const note = stored.notes.find(item => item.id === 'legacy-note-v2');
  expect(note).toMatchObject({
    id: 'legacy-note-v2',
    content: 'Content from schema version 2',
    path: 'Notes/legacy-note-legacy-n.md',
    syncState: 'local',
  });
  expect(stored.nodes).toContainEqual(expect.objectContaining({
    repositoryId,
    path: note?.path,
    kind: 'file',
    documentId: 'legacy-note-v2',
  }));
});

test('upgrades version 3 while preserving the saved workspace and open tab', async ({ page }) => {
  const noteId = 'legacy-note-v3';
  const snapshot = {
    repositories: [{ id: repositoryId, owner: 'local', name: 'Legacy workspace', defaultBranch: 'main' }],
    tabs: [{ id: `note:${noteId}`, repositoryId, branch: 'main', noteId, title: 'Workspace note', openedAt: 400 }],
    activeRepositoryId: repositoryId,
    activeTabId: `note:${noteId}`,
  };
  await seedLegacyDatabase(page, 3, {
    notes: [{
      id: noteId,
      repositoryId,
      title: 'Workspace note',
      content: 'Workspace state must survive migration',
      createdAt: 200,
      updatedAt: 300,
    }],
    workspace: { id: 'default', snapshot, updatedAt: 400 },
  });

  await page.goto('/');
  await expect(page.getByLabel('Назва нотатки')).toHaveValue('Workspace note');
  await expect(page.getByText('Legacy workspace', { exact: true })).toBeVisible();
  const stored = await readDatabase(page);
  expect(stored.workspace?.snapshot).toEqual(snapshot);
  expect(stored.nodes).toContainEqual(expect.objectContaining({
    path: 'Notes/workspace-note-legacy-n.md',
    documentId: noteId,
    kind: 'file',
  }));
});

test('upgrades version 4 paths safely, resolves duplicate paths and preserves sync metadata', async ({ page }) => {
  await seedLegacyDatabase(page, 4, {
    notes: [
      {
        id: 'legacy-v4-a',
        repositoryId,
        title: 'Legacy A',
        content: 'First document',
        path: 'Archive/legacy.md',
        syncState: 'dirty',
        baseSha: 'base-sha-a',
        createdAt: 100,
        updatedAt: 200,
      },
      {
        id: 'legacy-v4-b',
        repositoryId,
        title: 'Legacy B',
        content: 'Second document',
        path: 'Archive/legacy.md',
        syncState: 'local',
        createdAt: 110,
        updatedAt: 210,
      },
      {
        id: 'legacy-v4-c',
        repositoryId,
        title: 'Traversal',
        content: 'Unsafe legacy path',
        path: 'Notes/../../outside.md',
        syncState: 'conflict',
        baseSha: 'base-sha-c',
        createdAt: 120,
        updatedAt: 220,
      },
    ],
  });

  await page.goto('/');
  // The app opens the most recently updated note first; all three records are
  // checked below, so this assertion does not depend on insertion order.
  await expect(page.getByLabel('Назва нотатки')).toHaveValue('Traversal');
  const stored = await readDatabase(page);
  const migrated = stored.notes.filter(item => String(item.id).startsWith('legacy-v4-'));
  expect(migrated).toHaveLength(3);
  const paths = migrated.map(item => String(item.path));
  expect(new Set(paths).size).toBe(3);
  expect(paths).toContain('Archive/legacy.md');
  expect(paths.every(path => !path.split('/').includes('..'))).toBe(true);
  expect(migrated.find(item => item.id === 'legacy-v4-a')).toMatchObject({
    syncState: 'dirty',
    baseSha: 'base-sha-a',
  });
  expect(migrated.find(item => item.id === 'legacy-v4-c')).toMatchObject({
    syncState: 'conflict',
    baseSha: 'base-sha-c',
  });
  for (const note of migrated) {
    expect(stored.nodes).toContainEqual(expect.objectContaining({
      repositoryId,
      path: note.path,
      kind: 'file',
      documentId: note.id,
    }));
  }
});
