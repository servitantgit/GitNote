/** Date serials (1900 system with the Lotus leap-year bug, or 1904) and date/time text parsing. */

const MS_DAY = 86400000
const EPOCH_1900 = Date.UTC(1899, 11, 30)
const EPOCH_1904 = Date.UTC(1904, 0, 1)

/** Active date system for the evaluation in progress (set/restored by evaluate()). */
let date1904 = false
export function getDate1904(): boolean {
  return date1904
}
export function setDate1904(v: boolean): void {
  date1904 = v
}

function utc(y: number, m: number, d: number): number {
  const t = new Date(0)
  t.setUTCFullYear(y, m - 1, d)
  return t.getTime()
}

/** Serial for y/m/d (m 1-based; month/day overflow normalized like DATE()). */
export function ymdToSerial(y: number, m: number, d: number): number {
  if (date1904) return Math.round((utc(y, m, d) - EPOCH_1904) / MS_DAY)
  // The first day of the month (the month normalized), then the days counted on in Excel's own calendar, which has a
  // 29 February 1900 (serial 60; the 1904 system has no such day): DATE(1900,2,29), DATE(1900,3,0) and DATE(1900,1,60)
  // are that day, DATE(1900,1,61) is 1 March.
  const first = Math.round((utc(y, m, 1) - EPOCH_1900) / MS_DAY)
  return (first < 61 ? first - 1 : first) + Math.trunc(d) - 1
}

export interface DateParts {
  y: number
  m: number
  d: number
  /** 0 = Sunday */
  dow: number
}

export function serialToYmd(serial: number): DateParts {
  const n = Math.floor(serial)
  if (date1904) {
    const dt = new Date(EPOCH_1904 + n * MS_DAY)
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow: (((n + 5) % 7) + 7) % 7 }
  }
  const dow = (((n - 1) % 7) + 7) % 7
  if (n === 60) return { y: 1900, m: 2, d: 29, dow }
  if (n === 0) return { y: 1900, m: 1, d: 0, dow }
  const dt = new Date(EPOCH_1900 + (n < 60 ? n + 1 : n) * MS_DAY)
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow }
}

/** Seconds of the day (rounded to the nearest second). */
export function serialSeconds(serial: number): number {
  return Math.round((serial - Math.floor(serial)) * 86400) % 86400
}

export function daysInMonth(y: number, m: number): number {
  // (February 1900 has 29 days in Excel's calendar: EOMONTH and EDATE end the month on serial 60)
  if (!date1904 && y === 1900 && m === 2) return 29
  return new Date(utc(y, m + 1, 0)).getUTCDate()
}

/** Serial of a JS Date using its local calendar components. */
export function dateToSerial(dt: Date): number {
  const day = ymdToSerial(dt.getFullYear(), dt.getMonth() + 1, dt.getDate())
  const secs = dt.getHours() * 3600 + dt.getMinutes() * 60 + dt.getSeconds() + dt.getMilliseconds() / 1000
  return day + secs / 86400
}

const TIME_RE = /^(\d{1,4}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?\s*([ap]m?)?$/i
const ISO_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s]+(.+))?$/i
const US_RE = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4}|\d{2})(?:\s+(.+))?$/
// 15-Jan-2024, 15 January 2024, 15/Jan/24
const DMY_NAME_RE = /^(\d{1,2})[-\s/]+([A-Za-z]{3,9})\.?[-\s/,]+(\d{4}|\d{2})(?:\s+(.+))?$/
// Jan 15, 2024, January 15th 2024, Jan-15-2024
const MDY_NAME_RE = /^([A-Za-z]{3,9})\.?[-\s/]+(\d{1,2})(?:st|nd|rd|th)?[-\s/,]+(\d{4}|\d{2})(?:\s+(.+))?$/
// Jan 2024: the first of the month
const MY_NAME_RE = /^([A-Za-z]{3,9})\.?[-\s/,]+(\d{4})$/

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/** 1-12 for an English month name or its first three letters (and "Sept"), else 0 */
function monthOf(name: string): number {
  const n = name.toLowerCase()
  if (n === 'sept') return 9
  const i = MONTH_NAMES.findIndex((m) => m === n || (n.length === 3 && m.startsWith(n)))
  return i + 1
}

const year2 = (y: string) => (y.length === 2 ? Number(y) + (Number(y) < 30 ? 2000 : 1900) : Number(y))

function parseTime(s: string): number | null {
  const m = TIME_RE.exec(s.trim())
  if (!m) return null
  let h = Number(m[1])
  const mi = Number(m[2])
  const sec = m[3] ? Number(m[3]) : 0
  if (mi > 59 || sec >= 60) return null
  if (m[4]) {
    if (h < 1 || h > 12) return null
    const pm = m[4][0].toLowerCase() === 'p'
    h = (h % 12) + (pm ? 12 : 0)
  }
  return (h * 3600 + mi * 60 + sec) / 86400
}

function dateSerial(y: number, m: number, d: number): number | null {
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null
  const s = ymdToSerial(y, m, d)
  return s < 0 ? null : s
}

/** Parse date/time text: `yyyy-mm-dd [time]`, `m/d/yyyy [time]`, `15-Jan-2024`, `Jan 15, 2024`, `Jan 2024`, `hh:mm[:ss] [AM/PM]`. */
export function parseDateText(s: string): number | null {
  let m = ISO_RE.exec(s)
  let day: number | null = null
  let rest: string | undefined
  if (m) {
    day = dateSerial(Number(m[1]), Number(m[2]), Number(m[3]))
    rest = m[4]
  } else if ((m = US_RE.exec(s))) {
    let y = Number(m[3])
    if (m[3].length === 2) y += y < 30 ? 2000 : 1900
    day = dateSerial(y, Number(m[1]), Number(m[2]))
    rest = m[4]
  } else if ((m = DMY_NAME_RE.exec(s))) {
    const mo = monthOf(m[2])
    day = mo ? dateSerial(year2(m[3]), mo, Number(m[1])) : null
    rest = m[4]
  } else if ((m = MDY_NAME_RE.exec(s))) {
    const mo = monthOf(m[1])
    day = mo ? dateSerial(year2(m[3]), mo, Number(m[2])) : null
    rest = m[4]
  } else if ((m = MY_NAME_RE.exec(s))) {
    const mo = monthOf(m[1])
    day = mo ? dateSerial(Number(m[2]), mo, 1) : null
  } else return parseTime(s)
  if (day === null) return null
  if (rest === undefined) return day
  const t = parseTime(rest)
  return t === null ? null : day + t
}

/** Serial of an ISO date / date-time as a `t="d"` cell holds it (`2024-01-15`, `2024-01-15T06:00:00Z`, `12:30:00`); null when it is not one. */
export function isoToSerial(iso: string, date1904: boolean): number | null {
  const prev = getDate1904()
  setDate1904(date1904)
  try {
    return parseDateText(iso.trim().replace(/(?:Z|[+-]\d{2}:?\d{2})$/i, ''))
  } finally {
    setDate1904(prev)
  }
}
