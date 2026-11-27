export type DocumentFormatId =
  | 'markdown' | 'html' | 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'text'
  | 'csv' | 'image' | 'audio' | 'video' | 'archive' | 'unknown';

export type DocumentFormatCategory = 'text' | 'office' | 'pdf' | 'media' | 'archive' | 'unknown';

export interface DocumentFormat {
  id: DocumentFormatId;
  category: DocumentFormatCategory;
  extension: string | null;
  mimeType: string | null;
}

interface FormatDefinition {
  id: DocumentFormatId;
  category: DocumentFormatCategory;
  extensions: readonly string[];
  mimeTypes: readonly string[];
}

const FORMATS: readonly FormatDefinition[] = [
  { id: 'markdown', category: 'text', extensions: ['md', 'markdown', 'mdown', 'mkd'], mimeTypes: ['text/markdown', 'text/x-markdown'] },
  { id: 'html', category: 'text', extensions: ['html', 'htm'], mimeTypes: ['text/html', 'application/xhtml+xml'] },
  { id: 'docx', category: 'office', extensions: ['docx'], mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] },
  { id: 'xlsx', category: 'office', extensions: ['xlsx'], mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] },
  { id: 'pptx', category: 'office', extensions: ['pptx'], mimeTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'] },
  { id: 'pdf', category: 'pdf', extensions: ['pdf'], mimeTypes: ['application/pdf'] },
  { id: 'csv', category: 'text', extensions: ['csv', 'tsv'], mimeTypes: ['text/csv', 'text/tab-separated-values'] },
  { id: 'text', category: 'text', extensions: ['txt', 'log'], mimeTypes: ['text/plain'] },
  { id: 'image', category: 'media', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico'], mimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif', 'image/bmp', 'image/x-icon'] },
  { id: 'audio', category: 'media', extensions: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac'], mimeTypes: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/flac'] },
  { id: 'video', category: 'media', extensions: ['mp4', 'webm', 'mov', 'm4v', 'ogv'], mimeTypes: ['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg'] },
  { id: 'archive', category: 'archive', extensions: ['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz'], mimeTypes: ['application/zip', 'application/x-7z-compressed', 'application/vnd.rar', 'application/x-tar', 'application/gzip', 'application/x-bzip2', 'application/x-xz'] },
];

const EXTENSION_INDEX = new Map(FORMATS.flatMap(format => format.extensions.map(extension => [extension, format] as const)));
const MIME_INDEX = new Map(FORMATS.flatMap(format => format.mimeTypes.map(mimeType => [mimeType, format] as const)));

function extensionOf(fileName: string): string | null {
  const name = fileName.trim().split(/[\\/]/u).at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/** Detects a file format without reading its contents. Extensions take precedence over generic browser MIME metadata. */
export function detectDocumentFormat(fileName: string, mimeType = ''): DocumentFormat {
  const extension = extensionOf(fileName);
  const normalizedMime = (mimeType.split(';', 1)[0] ?? '').trim().toLowerCase();
  const definition = (extension ? EXTENSION_INDEX.get(extension) : undefined) ?? MIME_INDEX.get(normalizedMime);
  return {
    id: definition?.id ?? 'unknown',
    category: definition?.category ?? 'unknown',
    extension,
    mimeType: normalizedMime || null,
  };
}
