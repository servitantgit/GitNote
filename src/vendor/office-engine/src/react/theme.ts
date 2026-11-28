import type { CSSProperties } from 'react'
import { useDarkTheme, type ThemeMode } from './common/hooks'

export type { ThemeMode }

/**
 * Every design token of the viewer, as named in the stylesheet without its `--de-` prefix. The stylesheet defines each
 * on `.de-root` (light) and the colors again on `.de-root.de-dark`; `test/theme.test.ts` keeps this list and the
 * stylesheet in step.
 */
export const THEME_TOKENS = [
  // chrome
  'bg', 'chrome', 'border', 'text', 'muted', 'accent', 'accent-hover', 'accent-ink', 'accent-soft',
  'on', 'on-ink', 'on-ink-strong', 'ink', 'ink-strong', 'ink-soft', 'hover', 'hover-solid', 'hover-soft',
  'ebar', 'tb-sep', 'pop', 'pop-shadow', 'sep', 'input-bg', 'input-border', 'swatch-border', 'disabled',
  'danger', 'danger-border', 'ok', 'tab-hover', 'tab-on', 'tab-ink', 'toast-bg', 'toast-ink', 'backdrop', 'shadow',
  // sheet headers and grid
  'grid', 'head', 'head-ink', 'head-border', 'corner-border', 'freeze',
  // comments
  'cm-bg', 'cm-on', 'cm-line', 'cm-line-on', 'cm-card', 'cm-quote',
  // type and shape
  'font', 'font-mono', 'font-size', 'radius-sm', 'radius', 'radius-lg', 'radius-xl', 'shadow-sm', 'shadow-md', 'shadow-lg',
  // file kind badges, people's colors, find, tooltips, slideshow, connection state
  'kind-docx', 'kind-xlsx', 'kind-pptx', 'kind-ink', 'avatar-ink',
  'find', 'find-on', 'find-cell', 'find-cell-on', 'find-cell-line',
  'tip-bg', 'tip-ink', 'present-bg', 'present-ink',
  'status-idle', 'status-live', 'status-busy', 'status-error',
  // paper: pages, slides and sheets (the same in both modes, as documents keep their own colors)
  'page', 'page-ink', 'sheet-ink', 'skeleton', 'ph-border', 'ph-a', 'ph-b', 'ph-ink', 'ph-outline', 'ph-hint',
  // source editor and code view (Markdown, HTML, diagrams, source files)
  'src-bg', 'src-gutter', 'src-sel', 'src-font', 'src-comment', 'src-keyword', 'src-string', 'src-operator',
  'src-number', 'src-heading', 'src-attr', 'src-tag', 'src-meta', 'src-function', 'src-type',
  // code blocks on the page and printed code (paper: the same in both modes)
  'code-comment', 'code-keyword', 'code-string', 'code-operator', 'code-number', 'code-attr', 'code-tag', 'code-meta',
  'code-function', 'code-type',
] as const

export type ThemeToken = (typeof THEME_TOKENS)[number]

type Camel<S extends string> = S extends `${infer H}-${infer T}` ? `${H}${Capitalize<Camel<T>>}` : S

/** Token values by camelCase name (`accentHover` for `--de-accent-hover`); any CSS value, `var()` included. */
export type ThemeTokens = { [K in ThemeToken as Camel<K>]?: string }

export interface ThemeOptions {
  /** Light, dark, or following the OS. Default 'light'. */
  mode?: ThemeMode
  /** Tokens for both modes: type, shape, a brand accent that works on both. */
  tokens?: ThemeTokens
  /** Tokens for the light mode only, over `tokens`. */
  light?: ThemeTokens
  /** Tokens for the dark mode only, over `tokens`. */
  dark?: ThemeTokens
}

/** The `theme` prop: a mode, or a mode with token overrides. */
export type Theme = ThemeMode | ThemeOptions

/** Types a theme object (no runtime work: for editor completion where the object is written apart from the prop). */
export const createTheme = (theme: ThemeOptions): ThemeOptions => theme

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())

export const themeMode = (theme: Theme | undefined): ThemeMode => (typeof theme === 'object' ? (theme.mode ?? 'light') : (theme ?? 'light'))

/** The custom properties a theme sets on the viewer root in the given mode. */
export function themeStyle(theme: Theme | undefined, dark: boolean): CSSProperties {
  if (!theme || typeof theme !== 'object') return {}
  const out: Record<string, string> = {}
  for (const set of [theme.tokens, dark ? theme.dark : theme.light]) {
    if (!set) continue
    for (const [k, v] of Object.entries(set)) if (v != null && v !== '') out['--de-' + kebab(k)] = v
  }
  return out as CSSProperties
}

/**
 * The class name and style of a viewer root for `theme`: what `DocViewer` puts on its root element, for hosts that
 * mount the views (`DocxView`, `XlsxView`, `PptxView`) in a root of their own. `host` is for a container of controls
 * (ZoomBar, FormatBar…) rather than a view: sized by its content, and its popups (menus, the size list) show beyond it.
 */
export function useThemeRoot(theme?: Theme, style?: CSSProperties, opts?: { host?: boolean }): { className: string; style: CSSProperties; dark: boolean } {
  const dark = useDarkTheme(themeMode(theme))
  const className = 'de-root' + (dark ? ' de-dark' : '') + (opts?.host ? ' de-host' : '')
  return { className, style: { ...themeStyle(theme, dark), ...style }, dark }
}
