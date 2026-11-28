import type { DocumentRecord, BinaryDocumentRecord } from '../../core/domain/document-source';
import { detectDocumentFormat, type DocumentFormatId } from '../../core/domain/document-format';
import { binaryDocumentSource } from '../../infrastructure/storage/local-document-source';
import { database, type LocalSearchDocument } from '../../infrastructure/storage/database';
import { createSearchGrams, hasCurrentSearchGrams } from './search-index';
import { findSimilarTextMatches } from './search-query';
import { DocumentClient } from '../../vendor/office-engine';
import type { Block } from '../../vendor/office-engine/src/core/docx/types';
import { docxToText, slidesToText } from '../../vendor/office-engine/src/react/file/text';

export interface WorkspaceSearchResult {
  documentId: string;
  documentType: 'note' | 'binary';
  title: string;
  path?: string;
  format: DocumentFormatId;
  matchCount: number;
  matchKind: 'exact' | 'similar';
  snippet: string;
}

export interface WorkspaceSearchReport {
  results: WorkspaceSearchResult[];
  scannedCount: number;
  skippedPdfCount: number;
  errors: string[];
}

export interface WorkspaceSearchProgress {
  completed: number;
  total: number;
  currentTitle: string;
}

export function findTextMatches(text: string, query: string): { count: number; snippet: string } | null {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return null;
  const normalized = text.toLocaleLowerCase();
  const first = normalized.indexOf(needle);
  if (first < 0) return null;

  let count = 0;
  let cursor = 0;
  while (cursor < normalized.length) {
    const index = normalized.indexOf(needle, cursor);
    if (index < 0) break;
    count += 1;
    cursor = index + needle.length;
  }

  const start = Math.max(0, first - 72);
  const end = Math.min(text.length, first + needle.length + 96);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const snippet = prefix + text.slice(start, end).replace(/\s+/g, ' ').trim() + suffix;
  return { count, snippet };
}

async function loadXlsxSheet(client: DocumentClient, sheet: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {};
    unsubscribe = client.on('xlsx:progress', progress => {
      if (progress.sheet !== sheet || !progress.done) return;
      unsubscribe();
      if (progress.error) reject(new Error(progress.error));
      else resolve();
    });
    void client.call('xlsx.load', sheet).catch(error => {
      unsubscribe();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

async function extractOfficeText(document: BinaryDocumentRecord, format: DocumentFormatId): Promise<string> {
  const client = await DocumentClient.open(document.content, { name: document.title });
  try {
    if (format === 'docx' && client.kind === 'docx') {
      const blocks: Block[] = [];
      await new Promise<void>((resolve, reject) => {
        let removeBlocks = () => {};
        let removeDone = () => {};
        const cleanup = () => { removeBlocks(); removeDone(); };
        removeBlocks = client.on('docx:blocks', chunk => blocks.push(...chunk));
        removeDone = client.on('docx:done', result => {
          cleanup();
          if (result.error) reject(new Error(result.error));
          else resolve();
        });
        void client.call('docx.start').catch(error => {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
      return docxToText(blocks);
    }

    if (format === 'xlsx' && client.kind === 'xlsx') {
      const sheets = client.info.xlsx?.sheets ?? [];
      const contents = await Promise.all(sheets.map(async sheet => {
        await loadXlsxSheet(client, sheet.index);
        const blob = await client.call('xlsx.text', sheet.index, '\t') as Blob;
        return sheet.name + '\n' + await blob.text();
      }));
      return contents.join('\n');
    }

    if (format === 'pptx' && client.kind === 'pptx') {
      const slides = client.info.pptx?.slides ?? [];
      const models = await Promise.all(slides.map(slide => client.call('pptx.slide', slide.index)));
      return slidesToText(models);
    }

    return await client.call('plain.source') ?? '';
  } finally {
    client.destroy();
  }
}

async function extractBinaryText(document: BinaryDocumentRecord, format: DocumentFormatId): Promise<string | null> {
  if (format === 'pdf') return null;
  if (format === 'markdown' || format === 'text' || format === 'csv') return document.content.text();

  if (format === 'html') {
    const source = await document.content.text();
    const parsed = new DOMParser().parseFromString(source, 'text/html');
    parsed.querySelectorAll('script,style,noscript,template').forEach(element => element.remove());
    return parsed.body.textContent ?? '';
  }

  if (document.title.toLocaleLowerCase().endsWith('.svg')) {
    const source = await document.content.text();
    const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
    if (parsed.querySelector('parsererror')) throw new Error('Некоректний SVG-документ.');
    return parsed.documentElement.textContent ?? '';
  }

  if (format === 'docx' || format === 'xlsx' || format === 'pptx') {
    return extractOfficeText(document, format);
  }

  return null;
}

async function saveSearchDocument(
  document: Pick<DocumentRecord, 'id' | 'title' | 'path' | 'updatedAt'> | Pick<BinaryDocumentRecord, 'id' | 'title' | 'path' | 'updatedAt'>,
  documentType: 'note' | 'binary',
  format: DocumentFormatId,
  text: string,
): Promise<void> {
  const record: LocalSearchDocument = {
    id: document.id,
    documentType,
    title: document.title || 'Без назви',
    path: document.path,
    format,
    text,
    grams: createSearchGrams(text),
    sourceUpdatedAt: document.updatedAt,
  };
  await database.searchDocuments.put(record);
}

async function syncSearchIndex(
  notes: DocumentRecord[],
  onProgress?: (progress: WorkspaceSearchProgress) => void,
): Promise<{ total: number; skippedPdfCount: number; errors: string[] }> {
  const binaryMetas = await binaryDocumentSource.list();
  const sourceIds = new Set([...notes.map(note => note.id), ...binaryMetas.map(document => document.id)]);
  const indexedIds = await database.searchDocuments.toCollection().primaryKeys();
  const staleIds = indexedIds.filter(id => !sourceIds.has(String(id)));
  if (staleIds.length) await database.searchDocuments.bulkDelete(staleIds);

  const total = notes.length + binaryMetas.length;
  const errors: string[] = [];
  let completed = 0;
  let skippedPdfCount = 0;

  for (const note of notes) {
    const cached = await database.searchDocuments.get(note.id);
    if (!cached || cached.documentType !== 'note' || cached.sourceUpdatedAt !== note.updatedAt || cached.text !== note.content || !hasCurrentSearchGrams(cached.grams, note.content)) {
      await saveSearchDocument(note, 'note', 'markdown', note.content);
    } else if (cached.title !== note.title || cached.path !== note.path) {
      await database.searchDocuments.update(note.id, { title: note.title || 'Без назви', path: note.path });
    }
    completed += 1;
    onProgress?.({ completed, total, currentTitle: note.title });
  }

  for (const meta of binaryMetas) {
    const format = detectDocumentFormat(meta.title, meta.mediaType).id;
    if (format === 'pdf') {
      skippedPdfCount += 1;
      await database.searchDocuments.delete(meta.id);
      completed += 1;
      onProgress?.({ completed, total, currentTitle: meta.title });
      continue;
    }

    const cached = await database.searchDocuments.get(meta.id);
    if (cached && cached.documentType === 'binary' && cached.sourceUpdatedAt === meta.updatedAt) {
      const updates: Partial<LocalSearchDocument> = {};
      if (cached.title !== meta.title || cached.path !== meta.path || cached.format !== format) {
        updates.title = meta.title || 'Без назви';
        updates.path = meta.path;
        updates.format = format;
      }
      if (!hasCurrentSearchGrams(cached.grams, cached.text)) updates.grams = createSearchGrams(cached.text);
      if (Object.keys(updates).length) await database.searchDocuments.update(meta.id, updates);
      completed += 1;
      onProgress?.({ completed, total, currentTitle: meta.title });
      continue;
    }

    try {
      const document = await binaryDocumentSource.read(meta.id);
      const content = await extractBinaryText(document, format);
      if (content !== null) await saveSearchDocument(document, 'binary', format, content);
      else await database.searchDocuments.delete(meta.id);
    } catch (error) {
      // Never leave stale text searchable after a source document changed.
      await database.searchDocuments.delete(meta.id);
      errors.push(meta.title + ': ' + (error instanceof Error ? error.message : String(error)));
    }
    completed += 1;
    onProgress?.({ completed, total, currentTitle: meta.title });
  }

  return { total, skippedPdfCount, errors };
}

export async function searchWorkspaceDocuments(
  notes: DocumentRecord[],
  query: string,
  onProgress?: (progress: WorkspaceSearchProgress) => void,
): Promise<WorkspaceSearchReport> {
  const term = query.trim();
  if (!term) return { results: [], scannedCount: 0, skippedPdfCount: 0, errors: [] };

  const synced = await syncSearchIndex(notes, onProgress);
  const grams = createSearchGrams(term);
  let exactCandidates: LocalSearchDocument[];

  if (grams.length) {
    const frequencies = await Promise.all(grams.map(async gram => ({
      gram,
      count: await database.searchDocuments.where('grams').equals(gram).count(),
    })));
    const rarest = frequencies.reduce((best, current) => current.count < best.count ? current : best);
    exactCandidates = await database.searchDocuments.where('grams').equals(rarest.gram).toArray();
  } else {
    exactCandidates = await database.searchDocuments.toArray();
  }

  const results: WorkspaceSearchResult[] = [];
  for (const document of exactCandidates) {
    const match = findTextMatches(document.text, term);
    if (!match) continue;
    results.push({
      documentId: document.id,
      documentType: document.documentType,
      title: document.title || 'Без назви',
      path: document.path,
      format: document.format as DocumentFormatId,
      matchCount: match.count,
      matchKind: 'exact',
      snippet: match.snippet,
    });
  }

  let scannedCount = exactCandidates.length;
  // Fuzzy/prefix matching is a fallback: exact substring results always win.
  if (results.length === 0) {
    const queryTokens = term.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const fuzzyGrams = [...new Set(queryTokens.flatMap(token => createSearchGrams(token)))];
    if (queryTokens.length && queryTokens.every(token => token.length >= 3) && fuzzyGrams.length) {
      const fuzzyCandidates = await database.searchDocuments.where('grams').anyOf(fuzzyGrams).toArray();
      scannedCount = fuzzyCandidates.length;

      for (const document of fuzzyCandidates) {
        const match = findSimilarTextMatches(document.text, term);
        if (!match) continue;
        results.push({
          documentId: document.id,
          documentType: document.documentType,
          title: document.title || 'Без назви',
          path: document.path,
          format: document.format as DocumentFormatId,
          matchCount: match.count,
          matchKind: 'similar',
          snippet: match.snippet,
        });
      }
    }
  }

  const report: WorkspaceSearchReport = {
    results,
    scannedCount,
    skippedPdfCount: synced.skippedPdfCount,
    errors: synced.errors,
  };

  onProgress?.({ completed: scannedCount, total: scannedCount, currentTitle: '' });
  report.results.sort((a, b) => a.title.localeCompare(b.title));
  return report;
}
