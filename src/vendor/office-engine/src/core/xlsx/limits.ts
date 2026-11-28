/** OOXML worksheet limits. Imported CSV row counts and the generic view axes may exceed these. */
export const MAX_COL = 16_384
export const MAX_ROWS = 1_048_576
export const MAX_ROW_HEIGHT_PT = 409.5
export const MAX_COL_WIDTH = 255

/** Conservative drawing geometry budget: a whole worksheet at its largest cell sizes, in CSS px. */
export const MAX_SHEET_WIDTH_PX = MAX_COL * (MAX_COL_WIDTH * 7 + 8)
export const MAX_SHEET_HEIGHT_PX = MAX_ROWS * MAX_ROW_HEIGHT_PT * (4 / 3)

export function ooxmlNumber(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !value.trim()) return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined
}

/**
 * A size of the file, at most `max`: a width or a height past what Excel allows is the largest it allows (other
 * programs write them, and show them). Undefined when it is no number, or under `min`.
 */
export function ooxmlCapped(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !value.trim()) return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= min ? Math.min(max, n) : undefined
}

export function ooxmlInt(value: string | undefined, min: number, max: number): number | undefined {
  const n = ooxmlNumber(value, min, max)
  return Number.isSafeInteger(n) ? n : undefined
}
