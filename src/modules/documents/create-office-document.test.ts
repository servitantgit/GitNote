import { describe, expect, it } from 'vitest';
import { createOfficeDocumentBlob, type OfficeDocumentKind } from './create-office-document';

const cases: Array<{ kind: OfficeDocumentKind; mime: string }> = [
  { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { kind: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { kind: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
];

describe('createOfficeDocumentBlob', () => {
  it.each(cases)('creates a non-empty $kind Office package', async ({ kind, mime }) => {
    const blob = await createOfficeDocumentBlob(kind);
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toBe(mime);
    const signature = await new Promise<number[]>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve([...new Uint8Array(reader.result as ArrayBuffer)]);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob.slice(0, 4));
    });
    expect(signature).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });
});
