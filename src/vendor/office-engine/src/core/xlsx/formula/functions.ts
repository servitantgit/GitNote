/** Function registry (upper-case names, `_xlfn.` prefixes already stripped by the lexer). */
import { AGGREGATES } from './fn-aggregate'
import { ARRAY } from './fn-array'
import { DATABASE } from './fn-database'
import { DATE } from './fn-date'
import { DESCRIBE } from './fn-describe'
import { DIST } from './fn-dist'
import { ENGINEERING } from './fn-engineering'
import { FINANCIAL } from './fn-financial'
import { FORECAST } from './fn-forecast'
import { GOOGLE } from './fn-google'
import { INFO } from './fn-info'
import { LOGIC } from './fn-logic'
import { LOOKUP } from './fn-lookup'
import { MATH } from './fn-math'
import { STATS } from './fn-stats'
import { TEXT } from './fn-text'
import { WEB } from './fn-web'
import type { FnDef } from './fn'

export const FUNCTIONS: Readonly<Record<string, FnDef>> = {
  ...MATH,
  ...STATS,
  ...LOGIC,
  ...TEXT,
  ...DATE,
  ...LOOKUP,
  ...DIST,
  ...DESCRIBE,
  ...DATABASE,
  ...FINANCIAL,
  ...ENGINEERING,
  ...ARRAY,
  ...AGGREGATES,
  ...INFO,
  ...FORECAST,
  ...WEB,
  ...GOOGLE,
  SINGLE: { kind: 'eager', min: 1, max: 1, scalarArgs: false, fn: ([v], ev) => ev.scalar(v) },
}

/** Names of all supported functions (not the operators kept as functions: the space of an intersection). */
export function supportedFunctions(): string[] {
  return Object.keys(FUNCTIONS)
    .filter((n) => /^[A-Z]/.test(n))
    .sort()
}
