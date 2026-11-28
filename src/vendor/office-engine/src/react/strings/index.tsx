import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { en, type Strings } from './en'

export type { Strings } from './en'
export { en } from './en'

/** BCP 47 number/date formatting tag. It does not select or load a language table. */
export type Locale = string

type DeepPartial<T> = { [K in keyof T]?: NonNullable<T[K]> extends string | ((...args: never[]) => unknown) ? T[K] : DeepPartial<T[K]> }

/** A partial table: groups merge key by key over the enclosing provider's texts, or English. */
export type StringsOverride = DeepPartial<Strings>

const isGroup = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'

function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue
    const cur = out[k]
    out[k] = isGroup(cur) && isGroup(v) ? merge(cur, v) : v
  }
  return out
}

/** Validate once when resolving a table; malformed tags do not override a valid enclosing tag. */
function formattingLocale(locale: string | undefined): string | undefined {
  if (!locale) return undefined
  try {
    return Intl.getCanonicalLocales(locale)[0]
  } catch {
    return undefined
  }
}

/** Merge texts over `base`; an explicit formatting prop takes precedence over the table's locale. */
export function resolveStrings(locale?: Locale, override?: StringsOverride, base: Strings = en): Strings {
  const value = override ? (merge(base, override as Record<string, unknown>) as Strings) : base
  const tag = formattingLocale(locale) ?? formattingLocale(value.locale) ?? formattingLocale(base.locale)
  return value.locale === tag ? value : { ...value, locale: tag }
}

const formats = new Map<string, Intl.NumberFormat>()

function number(locale: string | undefined, n: number, opts?: Intl.NumberFormatOptions): string {
  const key = locale + JSON.stringify(opts ?? {})
  let f = formats.get(key)
  if (!f) formats.set(key, (f = new Intl.NumberFormat(locale, { useGrouping: false, ...opts })))
  return f.format(n)
}

/** Measurements and controls retain ASCII digits and a decimal point unless a locale is supplied. */
export const formatNumber = (s: Strings, n: number, opts?: Intl.NumberFormatOptions): string => number(s.locale ?? 'en-US', n, opts)

/** A count (pages, words, rows) with digit grouping. */
export const formatCount = (s: Strings, n: number) => number(s.locale, n, { useGrouping: true })

/** A byte count as B / KB / MB. */
export function formatBytes(s: Strings, n: number): string {
  if (n < 1024) return `${formatNumber(s, n)} B`
  if (n < 1024 * 1024) return `${formatNumber(s, n / 1024, { maximumFractionDigits: 0 })} KB`
  return `${formatNumber(s, n / 1024 / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`
}

const StringsContext = createContext<Strings>(en)

/** Inherits the enclosing table and applies local text/formatting overrides. Hoist override objects to keep consumers stable. */
export function StringsProvider({ locale, strings, children }: { locale?: Locale; strings?: StringsOverride; children?: ReactNode }) {
  const outer = useContext(StringsContext)
  const value = useMemo(() => resolveStrings(locale, strings, outer), [locale, strings, outer])
  return <StringsContext.Provider value={value}>{children}</StringsContext.Provider>
}

/** The UI texts of the nearest `StringsProvider` (English without one). */
export const useStrings = () => useContext(StringsContext)
