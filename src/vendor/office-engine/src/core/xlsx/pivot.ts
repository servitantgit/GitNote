/**
 * The pivot tables of a workbook, as far as GETPIVOTDATA needs them: where each is, the fields on its rows and
 * columns, and what every row and column of its values stands for. The values themselves are the cells of the sheet
 * (the engine does not compute a pivot table: it shows the one the file holds).
 */
import type { OpcPackage } from '../opc'
import { kid, kids, parseXml, type XEl } from '../xml'
import type { PivotInfo, PivotLine, Value } from './formula'
import { isoToSerial } from './formula/dates'
import { parseRange } from './workbook'

/** the values a field of the cache has, by index (what the items of the table's fields name) */
function sharedItems(field: XEl, date1904: boolean): Value[] {
  return (kid(field, 'sharedItems')?.c ?? []).map((it): Value => {
    const v = it.a.v
    switch (it.n) {
      case 'n':
        return Number(v)
      case 'b':
        return v === '1' || v === 'true'
      case 'd':
        return isoToSerial(v ?? '', date1904) ?? v ?? ''
      case 'm':
        return null
      default:
        return v ?? ''
    }
  })
}

/** the rows (or columns) of values: each repeats the first `r` members of the one before, then names its own */
function lines(list: XEl | undefined, fields: number[], member: (field: number, x: number) => Value): PivotLine[] {
  const out: PivotLine[] = []
  let prev: Value[] = []
  for (const it of kids(list, 'i')) {
    const repeat = Number(it.a.r ?? 0)
    const own = kids(it, 'x').map((x) => Number(x.a.v ?? 0))
    const items: Value[] = prev.slice(0, repeat)
    const type = it.a.t ?? 'data'
    if (type !== 'grand') {
      own.forEach((x, k) => {
        const field = fields[repeat + k]
        // (the place of the data fields on the axis holds no member: the line says which data field it is by `i`)
        items.push(field === -2 ? null : member(field, x))
      })
    }
    out.push({ type, data: Number(it.a.i ?? 0), items })
    prev = items
  }
  return out
}

export async function readPivots(pkg: OpcPackage, sheets: { name: string; path: string }[], date1904: boolean): Promise<PivotInfo[]> {
  const out: PivotInfo[] = []
  for (const sheet of sheets) {
    const rels = await pkg.rels(sheet.path).catch(() => undefined)
    for (const r of rels?.values() ?? []) {
      if (!r.type.endsWith('/pivotTable') || r.external || !pkg.has(r.target)) continue
      try {
        const pt = parseXml(await pkg.text(r.target))
        const loc = kid(pt, 'location')
        const ref = loc?.a.ref ? parseRange(loc.a.ref) : undefined
        const cacheRel = [...(await pkg.rels(r.target)).values()].find((x) => x.type.endsWith('/pivotCacheDefinition'))
        if (!loc || !ref || !cacheRel || !pkg.has(cacheRel.target)) continue
        const cache = parseXml(await pkg.text(cacheRel.target))
        const cacheFields = kids(kid(cache, 'cacheFields'), 'cacheField')
        const names = cacheFields.map((f) => f.a.name ?? '')
        const shared = cacheFields.map((f) => sharedItems(f, date1904))
        // the items of each field of the table, in the order the table has them: each names a value of the cache
        const fieldItems = kids(kid(pt, 'pivotFields'), 'pivotField').map((f) => kids(kid(f, 'items'), 'item').map((it) => (it.a.x !== undefined ? Number(it.a.x) : -1)))
        const member = (field: number, x: number): Value => {
          const at = fieldItems[field]?.[x]
          return at === undefined || at < 0 ? null : (shared[field]?.[at] ?? null)
        }
        const axis = (name: string) => kids(kid(pt, name), 'field').map((f) => Number(f.a.x))
        const rowFields = axis('rowFields')
        const colFields = axis('colFields')
        out.push({
          sheet: sheet.name,
          ...ref,
          firstDataRow: Number(loc.a.firstDataRow ?? 1),
          firstDataCol: Number(loc.a.firstDataCol ?? 1),
          rowFields: rowFields.map((f) => (f === -2 ? '' : (names[f] ?? ''))),
          colFields: colFields.map((f) => (f === -2 ? '' : (names[f] ?? ''))),
          dataFields: kids(kid(pt, 'dataFields'), 'dataField').map((f) => ({ name: f.a.name ?? '', field: names[Number(f.a.fld)] ?? '' })),
          rows: lines(kid(pt, 'rowItems'), rowFields, member),
          cols: lines(kid(pt, 'colItems'), colFields, member),
        })
      } catch {
        // a pivot table that does not read: GETPIVOTDATA keeps the value the file has for it
      }
    }
  }
  return out
}
