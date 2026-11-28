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
    expect([...new Uint8Array(await blob.slice(0, 4).arrayBuffer())]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });
});
