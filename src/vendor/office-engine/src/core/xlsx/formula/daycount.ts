/** Day-count conventions (the `basis` argument of YEARFRAC and the financial functions) and DAYS360. All dates are whole serial numbers. */
import { daysInMonth, serialToYmd, ymdToSerial } from './dates'

export const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

const lastOfFeb = (y: number, m: number, d: number) => m === 2 && d === daysInMonth(y, 2)

/**
 * DAYS360(start, end, method). US (NASD): a start on the last day of its month counts as the 30th; an end on the
 * 31st is the 1st of the next month when the start is before the 30th, else the 30th. European: every 31st is a 30th.
 */
export function days360(start: number, end: number, european: boolean): number {
  const a = serialToYmd(start)
  const b = serialToYmd(end)
  let { d: d1 } = a
  let { y: y2, m: m2, d: d2 } = b
  if (european) {
    d1 = Math.min(d1, 30)
    d2 = Math.min(d2, 30)
  } else {
    if (d1 === 31 || lastOfFeb(a.y, a.m, d1)) d1 = 30
    if (d2 === 31) {
      if (d1 < 30) {
        d2 = 1
        m2++
        if (m2 > 12) {
          m2 = 1
          y2++
        }
      } else d2 = 30
    }
  }
  return (y2 - a.y) * 360 + (m2 - a.m) * 30 + (d2 - d1)
}

/**
 * Days between two dates under `basis` (0 US 30/360, 1 actual/actual, 2 actual/360, 3 actual/365, 4 European 30/360):
 * the numerator of YEARFRAC, and what the financial functions count between a settlement and a maturity. start ≤ end.
 */
export function basisDays(start: number, end: number, basis: number): number {
  if (basis === 1 || basis === 2 || basis === 3) return end - start
  const a = serialToYmd(start)
  const b = serialToYmd(end)
  let d1 = a.d
  let d2 = b.d
  if (basis === 4) {
    d1 = Math.min(d1, 30)
    d2 = Math.min(d2, 30)
  } else {
    // the 30/360 of YEARFRAC: the ends of February count as 30ths
    if (lastOfFeb(a.y, a.m, a.d) && lastOfFeb(b.y, b.m, b.d)) d2 = 30
    if (lastOfFeb(a.y, a.m, a.d)) d1 = 30
    if (d2 === 31 && d1 >= 30) d2 = 30
    if (d1 === 31) d1 = 30
  }
  return (b.y - a.y) * 360 + (b.m - a.m) * 30 + (d2 - d1)
}

/** days of the year `basis` counts for the span start..end (the denominator of YEARFRAC) */
export function basisYear(start: number, end: number, basis: number): number {
  if (basis === 3) return 365
  if (basis !== 1) return 360
  const a = serialToYmd(start)
  const b = serialToYmd(end)
  // a year or less apart: 366 when the span is in a leap year or holds a 29 February
  if (a.y === b.y || (b.y === a.y + 1 && (a.m > b.m || (a.m === b.m && a.d >= b.d)))) {
    if (a.y === b.y) return isLeap(a.y) ? 366 : 365
    if (isLeap(a.y) && (a.m < 2 || (a.m === 2 && a.d <= 29))) return 366
    if (isLeap(b.y) && (b.m > 2 || (b.m === 2 && b.d === 29))) return 366
    return 365
  }
  // longer: the mean length of the calendar years it touches
  return (ymdToSerial(b.y + 1, 1, 1) - ymdToSerial(a.y, 1, 1)) / (b.y - a.y + 1)
}

/** YEARFRAC(start, end, basis): the fraction of a year between two dates (in either order) */
export function yearfrac(start: number, end: number, basis: number): number {
  if (start > end) [start, end] = [end, start]
  if (start === end) return 0
  return basisDays(start, end, basis) / basisYear(start, end, basis)
}
