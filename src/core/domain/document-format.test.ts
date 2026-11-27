import { describe, expect, it } from 'vitest';
import { detectDocumentFormat } from './document-format';

describe('detectDocumentFormat', () => {
  it.each([
    ['notes/Plan.MD', '', 'markdown'],
    ['report.docx', 'application/octet-stream', 'docx'],
    ['budget.xlsx', '', 'xlsx'],
    ['slides.pptx', '', 'pptx'],
    ['manual.pdf', 'application/octet-stream', 'pdf'],
    ['page.html', '', 'html'],
    ['data.csv', 'text/plain', 'csv'],
    ['photo.jpeg', '', 'image'],
    ['voice.m4a', '', 'audio'],
    ['clip.webm', '', 'video'],
    ['backup.tar.gz', '', 'archive'],
  ])('detects %s', (fileName, mimeType, expected) => {
    expect(detectDocumentFormat(fileName, mimeType).id).toBe(expected);
  });

  it('uses MIME type when the extension is missing', () => {
    expect(detectDocumentFormat('download', 'application/pdf').id).toBe('pdf');
  });

  it('normalizes MIME parameters and case', () => {
    expect(detectDocumentFormat('download', 'Text/HTML; charset=utf-8').id).toBe('html');
  });

  it('prefers a recognized extension over a conflicting MIME type', () => {
    expect(detectDocumentFormat('report.docx', 'text/plain').id).toBe('docx');
  });

  it('does not treat a dotfile as an extension', () => {
    const result = detectDocumentFormat('.gitignore', 'text/plain');
    expect(result.id).toBe('text');
    expect(result.extension).toBeNull();
  });

  it('returns unknown for unsupported files', () => {
    expect(detectDocumentFormat('database.sqlite').id).toBe('unknown');
  });
});
