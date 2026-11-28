/** Date & time functions (serial numbers; 1900 system with Lotus bug or 1904). */
import { dateToSerial, daysInMonth, getDate1904, parseDateText, serialSeconds, serialToYmd, ymdToSerial } from './dates'
import { days360, yearfrac } from './daycount'
import { A, opt, S, type Ev, type FnDef } from './fn'
import { ERR, FormulaError, type Value } from './types'
import { bool, num, RangeV, str, UnionV, type Val } from './values'

/** 31/12/9999: past it Excel has no date (a code like 20240115 is not one) */
const MAX_SERIAL = 2958466

function serial(v: Value): number {
  const n = num(v)
  if (n < 0 || n >= MAX_SERIAL) throw ERR.NUM
  return n
}
const day = (v: Value) => Math.floor(serial(v))

function addMonths(start: number, months: number, eom: boolean): number {
  const p = serialToYmd(start)
  const total = p.y * 12 + (p.m - 1) + Math.trunc(months)
  const y = Math.floor(total / 12)
  const m = (total % 12) + 1
  const d = eom ? daysInMonth(y, m) : Math.min(p.d, daysInMonth(y, m))
  const s = ymdToSerial(y, m, d)
  if (s < 0) throw ERR.NUM
  return s
}

const WEEKDAY_START: Record<number, [number, number]> = {
  // type: [day the week starts on (0=Sun), number of the first day]
  1: [0, 1],
  2: [1, 1],
  3: [1, 0],
  11: [1, 1],
  12: [2, 1],
  13: [3, 1],
  14: [4, 1],
  15: [5, 1],
  16: [6, 1],
  17: [0, 1],
}

function datedif(s: number, e: number, unit: string): number {
  if (s > e) throw ERR.NUM
  const a = serialToYmd(s)
  const b = serialToYmd(e)
  const months = (b.y - a.y) * 12 + (b.m - a.m) - (b.d < a.d ? 1 : 0)
  switch (unit.toUpperCase()) {
    case 'D':
      return e - s
    case 'M':
      return months
    case 'Y':
      return Math.floor(months / 12)
    case 'YM':
      return months % 12
    case 'MD': {
      if (b.d >= a.d) return b.d - a.d
      const pm = b.m === 1 ? 12 : b.m - 1
      const py = b.m === 1 ? b.y - 1 : b.y
      return daysInMonth(py, pm) - a.d + b.d
    }
    case 'YD': {
      // the anniversary of 29 Feb in a year without one is 1 March (DATE overflows the day), not 28 Feb
      let anniv = ymdToSerial(b.y, a.m, a.d)
      if (anniv > e) anniv = ymdToSerial(b.y - 1, a.m, a.d)
      return e - anniv
    }
  }
  throw ERR.NUM
}

function networkdays(s: number, e: number, holidays: Set<number>): number {
  const sign = s <= e ? 1 : -1
  const [lo, hi] = s <= e ? [s, e] : [e, s]
  // whole weeks by count, the days left one by one (never the span day by day: it can be as long as the numbers go)
  const days = hi - lo + 1
  let n = Math.floor(days / 7) * 5
  for (let d = hi - (days % 7) + 1; d <= hi; d++) {
    const dow = serialToYmd(d).dow
    if (dow !== 0 && dow !== 6) n++
  }
  for (const h of holidays) {
    if (h < lo || h > hi) continue
    const dow = serialToYmd(h).dow
    if (dow !== 0 && dow !== 6) n--
  }
  return sign * n
}

export const DATE: Record<string, FnDef> = {
  TODAY: A(0, 0, (_a, ev) => Math.floor(dateToSerial(ev.now()))),
  NOW: A(0, 0, (_a, ev) => dateToSerial(ev.now())),
  DATE: S(3, 3, ([y, m, d]) => {
    let yy = Math.trunc(num(y))
    if (yy >= 0 && yy < 1900) yy += 1900
    if (yy < 0 || yy > 9999) throw ERR.NUM
    const s = ymdToSerial(yy, Math.trunc(num(m)), Math.trunc(num(d)))
    if (s < 0) throw ERR.NUM
    return s
  }),
  TIME: S(3, 3, ([h, m, s]) => {
    const t = Math.trunc(num(h)) * 3600 + Math.trunc(num(m)) * 60 + Math.trunc(num(s))
    if (t < 0) throw ERR.NUM
    return (t % 86400) / 86400
  }),
  YEAR: S(1, 1, ([x]) => serialToYmd(day(x)).y),
  MONTH: S(1, 1, ([x]) => serialToYmd(day(x)).m),
  DAY: S(1, 1, ([x]) => serialToYmd(day(x)).d),
  HOUR: S(1, 1, ([x]) => Math.floor(serialSeconds(serial(x)) / 3600)),
  MINUTE: S(1, 1, ([x]) => Math.floor((serialSeconds(serial(x)) % 3600) / 60)),
  SECOND: S(1, 1, ([x]) => serialSeconds(serial(x)) % 60),
  WEEKDAY: S(1, 2, (a) => {
    const dow = serialToYmd(day(a[0])).dow
    const spec = WEEKDAY_START[Math.trunc(opt(a, 1, 1))]
    if (!spec) throw ERR.NUM
    return ((dow - spec[0] + 7) % 7) + spec[1]
  }),
  EDATE: S(2, 2, ([s, m]) => addMonths(day(s), num(m), false)),
  EOMONTH: S(2, 2, ([s, m]) => addMonths(day(s), num(m), true)),
  DATEDIF: S(3, 3, ([s, e, u]) => datedif(day(s), day(e), str(u))),
  DAYS: S(2, 2, ([e, s]) => Math.floor(num(e)) - Math.floor(num(s))),
  NETWORKDAYS: A(2, 3, (a, ev) => {
    const hol = new Set(a.length > 2 ? holidays(a[2], ev) : [])
    return networkdays(day(ev.scalar(a[0])), day(ev.scalar(a[1])), hol)
  }),
  'NETWORKDAYS.INTL': A(2, 4, (a, ev) => {
    const off = weekend(a.length > 2 ? ev.scalar(a[2]) : 1)
    const hol = new Set(a.length > 3 ? holidays(a[3], ev) : [])
    const s = day(ev.scalar(a[0]))
    const e = day(ev.scalar(a[1]))
    const [lo, hi] = s <= e ? [s, e] : [e, s]
    // whole weeks by count, the days left one by one
    const days = hi - lo + 1
    let n = Math.floor(days / 7) * off.filter((x) => !x).length
    for (let d = hi - (days % 7) + 1; d <= hi; d++) if (!off[serialToYmd(d).dow]) n++
    for (const h of hol) if (h >= lo && h <= hi && !off[serialToYmd(h).dow]) n--
    return s <= e ? n : -n
  }),
  WORKDAY: A(2, 3, (a, ev) => workday(day(ev.scalar(a[0])), Math.trunc(num(ev.scalar(a[1]))), weekend(1), a.length > 2 ? holidays(a[2], ev) : [])),
  'WORKDAY.INTL': A(2, 4, (a, ev) =>
    workday(day(ev.scalar(a[0])), Math.trunc(num(ev.scalar(a[1]))), weekend(a.length > 2 ? ev.scalar(a[2]) : 1), a.length > 3 ? holidays(a[3], ev) : []),
  ),
  DATEVALUE: S(1, 1, ([x], ev) => {
    if (typeof x !== 'string') throw ERR.VALUE
    const t = x.trim()
    let n = parseDateText(t)
    // a day and a month without a year (5-Jul, 7/5): of this year
    if (n === null) {
      const y = ev.now().getFullYear()
      n = parseDateText(`${t}-${y}`) ?? parseDateText(`${t}/${y}`) ?? parseDateText(`${t} ${y}`)
    }
    if (n === null) throw ERR.VALUE
    return Math.floor(n)
  }),
  TIMEVALUE: S(1, 1, ([x]) => {
    if (typeof x !== 'string') throw ERR.VALUE
    const n = parseDateText(x.trim())
    if (n === null) throw ERR.VALUE
    return n - Math.floor(n)
  }),
  DAYS360: S(2, 3, (a) => days360(day(a[0]), day(a[1]), a.length > 2 && bool(a[2]))),
  YEARFRAC: S(2, 3, (a) => {
    const basis = Math.trunc(opt(a, 2, 0))
    if (basis < 0 || basis > 4) throw ERR.NUM
    return yearfrac(day(a[0]), day(a[1]), basis)
  }),
  ISOWEEKNUM: S(1, 1, ([x]) => isoWeek(day(x))),
  WEEKNUM: S(1, 2, (a) => {
    const d = day(a[0])
    const type = Math.trunc(opt(a, 1, 1))
    if (type === 21) return isoWeek(d)
    // the day the week starts on (0 = Sunday); week 1 is the week 1 January is in
    const start = type === 1 || type === 17 ? 0 : type === 2 || type === 11 ? 1 : type >= 12 && type <= 16 ? type - 10 : -1
    if (start < 0) throw ERR.NUM
    const jan1 = ymdToSerial(serialToYmd(d).y, 1, 1)
    const lead = (serialToYmd(jan1).dow - start + 7) % 7
    return Math.floor((d - jan1 + lead) / 7) + 1
  }),
  // Google Sheets: a Unix time (seconds, 2: milliseconds, 3: microseconds) as a date, in UTC
  EPOCHTODATE: S(1, 2, (a) => {
    const unit = Math.trunc(opt(a, 1, 1))
    if (unit < 1 || unit > 3) throw ERR.NUM
    const t = num(a[0])
    if (t < 0) throw ERR.NUM
    return 25569 - (getDate1904() ? 1462 : 0) + t / (86400 * Math.pow(1000, unit - 1))
  }),
}

/**
 * The days of a list of holidays: numbers, and dates written as text ({"2006/1/2","2006/1/16"}). In a range, a cell
 * that holds neither is passed over; a text given as such that is not a date is #VALUE!.
 */
function holidays(v: Val, ev: Ev): number[] {
  const out: number[] = []
  const take = (x: Value, strict: boolean) => {
    if (x instanceof FormulaError) throw x
    if (typeof x === 'number') out.push(Math.floor(x))
    else if (typeof x === 'string') {
      const n = parseDateText(x.trim())
      if (n !== null) out.push(Math.floor(n))
      else if (strict && x !== '') throw ERR.VALUE
    } else if (typeof x === 'boolean' && strict) throw ERR.VALUE
  }
  if (v instanceof RangeV) ev.forEach(v, (x) => take(x, false))
  else if (v instanceof UnionV) for (const rg of v.areas) ev.forEach(rg, (x) => take(x, false))
  else for (const row of ev.toArray(v)) for (const x of row) take(x, true)
  return out
}

/**
 * The days off of a week, by day (0 = Sunday): a number (1 Saturday-Sunday, 2 Sunday-Monday … 7 Friday-Saturday,
 * 11 Sunday only … 17 Saturday only) or seven characters, Monday first, `1` for a day off.
 */
function weekend(v: Value): boolean[] {
  const off = [false, false, false, false, false, false, false]
  if (typeof v === 'string') {
    if (!/^[01]{7}$/.test(v) || v === '1111111') throw ERR.VALUE
    for (let i = 0; i < 7; i++) if (v[i] === '1') off[(i + 1) % 7] = true
    return off
  }
  const n = Math.trunc(num(v))
  if (n >= 1 && n <= 7) {
    // 1: Saturday (6) and Sunday (0); each next number a day later
    off[(n + 5) % 7] = true
    off[(n + 6) % 7] = true
  } else if (n >= 11 && n <= 17) off[(n - 11) % 7] = true
  else throw ERR.NUM
  return off
}

/** the working day `n` working days after (before, when negative) `start` */
function workday(start: number, n: number, off: boolean[], holidays: number[]): number {
  const hol = new Set(holidays.map(Math.floor))
  const work = off.filter((x) => !x).length
  const step = n < 0 ? -1 : 1
  let left = Math.abs(n)
  let d = start
  // whole weeks at once while no holiday can be among them
  if (!hol.size) {
    const weeks = Math.floor(left / work)
    if (weeks > 1) {
      d += step * (weeks - 1) * 7
      left -= (weeks - 1) * work
    }
  }
  while (left > 0) {
    d += step
    if (d < 0 || d >= MAX_SERIAL) throw ERR.NUM
    if (!off[serialToYmd(d).dow] && !hol.has(d)) left--
  }
  return d
}

/** ISO 8601 week: weeks start on Monday, the first is the one holding the year's first Thursday */
function isoWeek(d: number): number {
  const dow = (serialToYmd(d).dow + 6) % 7
  // the Thursday of this week tells the year the week belongs to
  const thursday = d - dow + 3
  const jan1 = ymdToSerial(serialToYmd(thursday).y, 1, 1)
  return Math.floor((thursday - jan1) / 7) + 1
}
