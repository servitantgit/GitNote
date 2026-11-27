export interface GitNoteModule {
  readonly id: string;
  readonly version: string;
  initialize(): Promise<void> | void;
  dispose?(): Promise<void> | void;
}

export interface FileHandler extends GitNoteModule {
  readonly extensions: readonly string[];
  canPreview(mimeType: string): boolean;
}
