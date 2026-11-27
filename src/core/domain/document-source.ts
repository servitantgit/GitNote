export type DocumentSyncState = 'local' | 'clean' | 'dirty' | 'conflict';

export interface DocumentMeta {
  id: string;
  repositoryId: string;
  title: string;
  /** Repository-relative document path. Local-only documents do not have one. */
  path?: string;
  /** Blob SHA of the remote version this document was based on. */
  baseSha?: string;
  syncState: DocumentSyncState;
  createdAt: number;
  updatedAt: number;
}

export interface DocumentRecord extends DocumentMeta {
  content: string;
}

export interface DocumentRead {
  content: string;
  baseSha?: string;
}

export interface DocumentWriteResult {
  /** SHA of the newly written remote version; local sources do not return one. */
  sha?: string;
}

/** The editor and workspace depend on this contract, not on IndexedDB or GitHub. */
export interface DocumentSource {
  list(): Promise<DocumentMeta[]>;
  read(id: string): Promise<DocumentRead>;
  write(id: string, content: string, baseSha?: string): Promise<DocumentWriteResult>;
  remove(id: string): Promise<void>;
}

/** Local application lifecycle operations not needed by a read/write-only source. */
export interface MutableDocumentSource extends DocumentSource {
  create(meta: DocumentMeta, content: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
}

/** Attachment paths are relative to the directory containing their parent document. */
export interface DocumentAttachmentMeta {
  id: string;
  noteId: string;
  path: string;
  mediaType: string;
  size: number;
  createdAt: number;
  updatedAt: number;
}

/** Binary documents are stored separately from editable text notes. */
export interface BinaryDocumentRecord extends DocumentMeta {
  content: Blob;
  mediaType: string;
  size: number;
}

/** Storage contract for binary workspace documents. */
export interface BinaryDocumentSource {
  list(): Promise<Omit<BinaryDocumentRecord, 'content'>[]>;
  read(id: string): Promise<BinaryDocumentRecord>;
  write(id: string, content: Blob, baseSha?: string): Promise<DocumentWriteResult>;
  remove(id: string): Promise<void>;
  create(document: BinaryDocumentRecord): Promise<void>;
}
