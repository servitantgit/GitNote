import type { DocumentRecord, BinaryDocumentRecord } from '../../core/domain/document-source';
import { detectDocumentFormat, type DocumentFormatId } from '../../core/domain/document-format';
import { binaryDocumentSource } from '../../infrastructure/storage/local-document-source';
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

  if (format === 'svg') {
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

export async function searchWorkspaceDocuments(
  notes: DocumentRecord[],
  query: string,
  onProgress?: (progress: WorkspaceSearchProgress) => void,
): Promise<WorkspaceSearchReport> {
  const term = query.trim();
  if (!term) return { results: [], scannedCount: 0, skippedPdfCount: 0, errors: [] };

  const binaryMetas = await binaryDocumentSource.list();
  const total = notes.length + binaryMetas.length;
  const report: WorkspaceSearchReport = { results: [], scannedCount: 0, skippedPdfCount: 0, errors: [] };

  const addResult = (
    document: Pick<DocumentRecord, 'id' | 'title' | 'path'> | Pick<BinaryDocumentRecord, 'id' | 'title' | 'path'>,
    documentType: 'note' | 'binary',
    format: DocumentFormatId,
    content: string,
  ) => {
    const match = findTextMatches(content, term);
    if (!match) return;
    report.results.push({
      documentId: document.id,
      documentType,
      title: document.title || 'Без назви',
      path: document.path,
      format,
      matchCount: match.count,
      snippet: match.snippet,
    });
  };

  for (const note of notes) {
    onProgress?.({ completed: report.scannedCount, total, currentTitle: note.title });
    addResult(note, 'note', 'markdown', note.content);
    report.scannedCount += 1;
  }

  for (const meta of binaryMetas) {
    onProgress?.({ completed: report.scannedCount, total, currentTitle: meta.title });
    const format = detectDocumentFormat(meta.title, meta.mediaType).id;
    if (format === 'pdf') {
      report.skippedPdfCount += 1;
      report.scannedCount += 1;
      continue;
    }
    try {
      const document = await binaryDocumentSource.read(meta.id);
      const content = await extractBinaryText(document, format);
      if (content !== null) addResult(document, 'binary', format, content);
    } catch (error) {
      report.errors.push(meta.title + ': ' + (error instanceof Error ? error.message : String(error)));
    }
    report.scannedCount += 1;
  }

  onProgress?.({ completed: total, total, currentTitle: '' });
  report.results.sort((a, b) => a.title.localeCompare(b.title));
  return report;
}
