import { blankPptx, parasToDocx, rowsToXlsx } from '../../vendor/office-engine';

export type OfficeDocumentKind = 'docx' | 'xlsx' | 'pptx';

/** Creates a valid, empty Office package using the vendored engine's native builders. */
export function createOfficeDocumentBlob(kind: OfficeDocumentKind): Promise<Blob> {
  switch (kind) {
    case 'docx':
      return parasToDocx([]);
    case 'xlsx':
      return rowsToXlsx([[]], 'Sheet1');
    case 'pptx':
      return blankPptx();
  }
}
