import type { EditorMode } from '../editor/types';

export type AppTheme = 'system' | 'light' | 'dark';
export type UiDensity = 'comfortable' | 'compact';

export interface AppPreferences {
  theme: AppTheme;
  density: UiDensity;
  defaultMode: EditorMode;
  editorFontSize: number;
  lineWrapping: boolean;
  lineNumbers: boolean;
  outlineOpenByDefault: boolean;
  minimapOpenByDefault: boolean;
  restoreTabs: boolean;
  rememberSidebarState: boolean;
  sidebarOpen: boolean;
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  theme: 'system', density: 'comfortable', defaultMode: 'source', editorFontSize: 13,
  lineWrapping: true, lineNumbers: true, outlineOpenByDefault: false, minimapOpenByDefault: false,
  restoreTabs: true, rememberSidebarState: false, sidebarOpen: true,
};
