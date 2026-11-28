/** Formula text rewriting (fill/copy, row/col insert/delete, sheet rename) and dependency extraction. */
import { tokenize, type Token } from './lexer'
import { parseFormula, type Ast } from './parser'
import { fmtRef, normalizeRef, quoteSheet, refInBounds, sameSheet, type RefAddr } from './refs'
import { MAX_COL, MAX_REF_ROW, MAX_ROW, type CellRef, type RangeRef } from './types'

/** Re-emit `text`, replacing tokens for which `map` returns a string. Unlexable text is returned unchanged. */
function rewrite(text: string, map: (t: Token) => string | undefined): string {
  const lead = text.startsWith('=') ? '=' : ''
  const src = text.slice(lead.length)
  let toks: Token[]
  try {
    toks = tokenize(src)
  } catch {
    return text
  }
  let out = lead
  let pos = 0
  for (const t of toks) {
    const rep = map(t)
    if (rep === undefined) continue
    out += src.slice(pos, t.s) + rep
    pos = t.e
  }
  return out + src.slice(pos)
}

const refError = (t: Token & { t: 'ref' }) => (t.ref.sheet === undefined ? '' : `${t.sheetText ?? quoteSheet(t.ref.sheet)}!`) + '#REF!'

function translateRef(t: Token & { t: 'ref' }, dr: number, dc: number): string {
  const a: RefAddr = { ...t.ref }
  if (a.kind !== 'cols') {
    if (!a.ar0) a.r0 += dr
    if (!a.ar1) a.r1 += dr
  }
  if (a.kind !== 'rows') {
    if (!a.ac0) a.c0 += dc
    if (!a.ac1) a.c1 += dc
  }
  // (a reference past Excel's last row, to a row of a large text file, may move on past it)
  if (!refInBounds(a, t.ref.r1 > MAX_ROW ? MAX_REF_ROW : MAX_ROW)) return refError(t)
  return fmtRef(normalizeRef(a), t.sheetText)
}

/** Copy/fill: shift relative parts of every reference by (dr, dc). Out-of-sheet results become #REF!. */
export function translateFormula(text: string, dr: number, dc: number): string {
  if (!dr && !dc) return text
  return rewrite(text, (t) => (t.t === 'ref' ? translateRef(t, dr, dc) : undefined))
}

/**
 * `translateFormula` of one text by many offsets (the cells of a shared formula): the text is read once.
 * Unlexable text is returned unchanged, as there.
 */
export function translator(text: string): (dr: number, dc: number) => string {
  const lead = text.startsWith('=') ? '=' : ''
  const src = text.slice(lead.length)
  let refs: (Token & { t: 'ref' })[]
  try {
    refs = tokenize(src).filter((t): t is Token & { t: 'ref' } => t.t === 'ref')
  } catch {
    return () => text
  }
  // the text between the references, kept as it is
  const between: string[] = []
  let pos = 0
  for (const t of refs) {
    between.push(src.slice(pos, t.s))
    pos = t.e
  }
  const tail = src.slice(pos)
  return (dr, dc) => {
    if (!dr && !dc) return text
    let out = lead
    for (let i = 0; i < refs.length; i++) out += between[i] + translateRef(refs[i], dr, dc)
    return out + tail
  }
}

/** New [lo, hi] after inserting (delta>0) / deleting (delta<0) at `at`; null when entirely deleted. */
function shiftSpan(lo: number, hi: number, at: number, delta: number, max: number): [number, number] | null {
  if (delta > 0) {
    if (lo >= at) lo += delta
    if (hi >= at) hi += delta
    if (lo > max) return null
    return [lo, Math.min(hi, max)]
  }
  const n = -delta
  const end = at + n
  if (hi < at) return [lo, hi]
  if (lo >= end) return [lo - n, hi - n]
  if (lo >= at && hi < end) return null
  return [lo < at ? lo : at, hi >= end ? hi - n : at - 1]
}

export interface ShiftOp {
  /** sheet whose rows/cols change (undefined: the formula's own sheet) */
  sheet?: string
  /** sheet the formula lives on (unqualified refs belong to it; undefined: same as `sheet`) */
  formulaSheet?: string
  axis: 'row' | 'col'
  /** 0-based index of the first inserted/deleted row/col */
  at: number
  /** >0 insert count, <0 delete count */
  delta: number
}

/** Rewrite references after inserting/deleting rows or columns. */
export function shiftFormula(text: string, op: ShiftOp): string {
  if (!op.delta) return text
  const affects = (refSheet: string | undefined): boolean => {
    if (op.sheet === undefined) return refSheet === undefined || (op.formulaSheet !== undefined && sameSheet(refSheet, op.formulaSheet))
    const s = refSheet ?? op.formulaSheet
    return s === undefined || sameSheet(s, op.sheet)
  }
  return rewrite(text, (t) => {
    if (t.t !== 'ref' || !affects(t.ref.sheet)) return undefined
    const a: RefAddr = { ...t.ref }
    if (op.axis === 'row') {
      if (a.kind === 'cols') return undefined
      const s = shiftSpan(a.r0, a.r1, op.at, op.delta, a.r1 > MAX_ROW ? MAX_REF_ROW : MAX_ROW)
      if (!s) return refError(t)
      ;[a.r0, a.r1] = s
    } else {
      if (a.kind === 'rows') return undefined
      const s = shiftSpan(a.c0, a.c1, op.at, op.delta, MAX_COL)
      if (!s) return refError(t)
      ;[a.c0, a.c1] = s
    }
    if (a.r0 === t.ref.r0 && a.r1 === t.ref.r1 && a.c0 === t.ref.c0 && a.c1 === t.ref.c1) return undefined
    return fmtRef(a, t.sheetText)
  })
}

/** cells moved from one place to another (cut and pasted): the block, as it was, and how far it went */
export interface MoveOp {
  from: string
  to: string
  r0: number
  c0: number
  r1: number
  c1: number
  dr: number
  dc: number
}

/**
 * Rewrite references after cells were moved: a reference to cells of the block (all of them inside it) follows them,
 * the others stay. `home`: the sheet the formula is on now; `was`: the sheet it was on, for a formula that moved with
 * the block to another sheet (what it read of its old sheet, it still reads there).
 */
export function moveRefsInFormula(text: string, op: MoveOp, home: string, was = home): string {
  return rewrite(text, (t) => {
    if (t.t !== 'ref') return undefined
    const a = t.ref
    const sheet = a.sheet ?? was
    const inside = sameSheet(sheet, op.from) && (a.kind === 'cell' || a.kind === 'area') && a.r0 >= op.r0 && a.r1 <= op.r1 && a.c0 >= op.c0 && a.c1 <= op.c1
    const target = inside ? op.to : sheet
    const local = sameSheet(target, home)
    // as written: nothing of it moved, and it names its sheet as it has to
    if (!inside && (a.sheet === undefined) === local) return undefined
    const b: RefAddr = inside ? { ...a, r0: a.r0 + op.dr, r1: a.r1 + op.dr, c0: a.c0 + op.dc, c1: a.c1 + op.dc } : { ...a }
    return fmtRef({ ...b, sheet: local ? undefined : target }, !local && a.sheet !== undefined && sameSheet(a.sheet, target) ? t.sheetText : undefined)
  })
}

/** whether a sheet qualifier names the sheet: alone, or as an end of a 3-D reference `First:Last` */
function namesSheet(q: string, name: string): boolean {
  if (sameSheet(q, name)) return true
  const at = q.indexOf(':')
  return at > 0 && (sameSheet(q.slice(0, at), name) || sameSheet(q.slice(at + 1), name))
}

/** References to a sheet that is no more (deleted): each becomes #REF!, as the names and errors qualified by it. */
export function dropSheetInFormula(text: string, name: string): string {
  return rewrite(text, (t) => {
    if ((t.t === 'ref' && t.ref.sheet !== undefined && namesSheet(t.ref.sheet, name)) || ((t.t === 'err' || t.t === 'name') && t.sheet !== undefined && sameSheet(t.sheet, name))) return '#REF!'
    return undefined
  })
}

/** Rename sheet qualifiers (`Old!A1`, `'Old'!A1:B2`, `Old!#REF!`, `Old!Name`, `Old:Last!A1`). */
export function renameSheetInFormula(text: string, oldName: string, newName: string): string {
  const pre = `${quoteSheet(newName)}!`
  return rewrite(text, (t) => {
    if (t.t === 'ref' && t.ref.sheet !== undefined && sameSheet(t.ref.sheet, oldName))
      return fmtRef({ ...t.ref, sheet: newName })
    if (t.t === 'ref' && t.ref.sheet !== undefined && t.ref.sheet.includes(':') && namesSheet(t.ref.sheet, oldName)) {
      const at = t.ref.sheet.indexOf(':')
      const ends = [t.ref.sheet.slice(0, at), t.ref.sheet.slice(at + 1)].map((x) => (sameSheet(x, oldName) ? newName : x))
      return fmtRef({ ...t.ref, sheet: ends.join(':') })
    }
    if ((t.t === 'err' || t.t === 'name') && t.sheet !== undefined && sameSheet(t.sheet, oldName)) return pre + t.v
    return undefined
  })
}

/**
 * Functions newer than the file format (Excel 2010 and later): a file names them with a prefix, and Excel takes one
 * written without for a name it does not know (#NAME?).
 */
const FUTURE = new Set(
  (
    'ACOT ACOTH AGGREGATE ARABIC ARRAYTOTEXT BASE BETA.DIST BETA.INV BINOM.DIST BINOM.DIST.RANGE BINOM.INV BITAND BITLSHIFT BITOR BITRSHIFT BITXOR BYCOL BYROW ' +
    'CEILING.MATH CEILING.PRECISE CHISQ.DIST CHISQ.DIST.RT CHISQ.INV CHISQ.INV.RT CHISQ.TEST CHOOSECOLS CHOOSEROWS COMBINA CONCAT CONFIDENCE.NORM CONFIDENCE.T COT COTH ' +
    'COVARIANCE.P COVARIANCE.S CSC CSCH DAYS DECIMAL DROP ERF.PRECISE ERFC.PRECISE EXPAND EXPON.DIST F.DIST F.DIST.RT F.INV F.INV.RT F.TEST FILTERXML FLOOR.MATH ' +
    'FLOOR.PRECISE FORECAST.ETS FORECAST.ETS.CONFINT FORECAST.ETS.SEASONALITY FORECAST.ETS.STAT FORECAST.LINEAR FORMULATEXT GAMMA GAMMA.DIST GAMMA.INV GAMMALN.PRECISE ' +
    'GAUSS HSTACK HYPGEOM.DIST IFNA IFS IMAGE IMCOSH IMCOT IMCSC IMCSCH IMSEC IMSECH IMSINH IMTAN ISFORMULA ISOMITTED ISOWEEKNUM LAMBDA LET LOGNORM.DIST LOGNORM.INV ' +
    'MAKEARRAY MAP MAXIFS MINIFS MODE.MULT MODE.SNGL MUNIT NEGBINOM.DIST NORM.DIST NORM.INV NORM.S.DIST NORM.S.INV NUMBERVALUE PDURATION PERCENTILE.EXC PERCENTILE.INC ' +
    'PERCENTRANK.EXC PERCENTRANK.INC PERMUTATIONA PHI POISSON.DIST QUARTILE.EXC QUARTILE.INC QUERYSTRING RANDARRAY RANK.AVG RANK.EQ REDUCE RRI SCAN SEC SECH SEQUENCE ' +
    'SHEET SHEETS SINGLE SKEW.P SORTBY STDEV.P STDEV.S SWITCH T.DIST T.DIST.2T T.DIST.RT T.INV T.INV.2T T.TEST TAKE TEXTAFTER TEXTBEFORE TEXTJOIN TEXTSPLIT TOCOL TOROW ' +
    'UNICHAR UNICODE UNIQUE VALUETOTEXT VAR.P VAR.S VSTACK WEBSERVICE WEIBULL.DIST WRAPCOLS WRAPROWS XLOOKUP XMATCH XOR Z.TEST ' +
    'ANCHORARRAY GROUPBY PIVOTBY PERCENTOF TRIMRANGE REGEXTEST REGEXEXTRACT REGEXREPLACE TRANSLATE DETECTLANGUAGE STOCKHISTORY'
  ).split(' '),
)
/** these are of the worksheet namespace as well */
const FUTURE_WS = new Set(['FILTER', 'SORT'])

/**
 * `@x` as a file writes it: `SINGLE(x)`. What `@` applies to is the reference, name or call after it (with what
 * `:` joins to it).
 */
function withoutAt(text: string): string {
  if (!text.includes('@') && !text.includes('#')) return text
  const lead = text.startsWith('=') ? '=' : ''
  const src = text.slice(lead.length)
  let toks: Token[]
  try {
    toks = tokenize(src)
  } catch {
    return text
  }
  const sig = toks.filter((t) => t.t !== 'ws')
  /** the index after the operand that starts at `i` */
  const operand = (i: number): number => {
    const close = (k: number): number => {
      let depth = 0
      for (; k < sig.length; k++) {
        const t = sig[k]
        if (t.t !== 'punc') continue
        if (t.v === '(') depth++
        else if (t.v === ')' && --depth === 0) return k + 1
      }
      return sig.length
    }
    const t = sig[i]
    if (!t) return i
    let end = i + 1
    if (t.t === 'op' && t.v === '@') end = operand(i + 1)
    else if (t.t === 'func' || (t.t === 'punc' && t.v === '(')) end = close(i)
    const next = sig[end]
    return next && next.t === 'op' && next.v === ':' ? operand(end + 1) : end
  }
  const open = new Set<Token>()
  const shut = new Map<Token, number>()
  /** x#: the tokens that start an operand of `#` (ANCHORARRAY( goes before), and the `#` themselves (a `)` in their place) */
  const anchored = new Map<Token, number>()
  const hash = new Set<Token>()
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i]
    if (t.t === 'op' && t.v === '#') {
      // what it applies to: the reference or name before it, or the parenthesized expression / call that ends there
      let k = i - 1
      if (sig[k]?.t === 'punc' && (sig[k] as { v: string }).v === ')') {
        let depth = 0
        for (; k >= 0; k--) {
          const u = sig[k]
          if (u.t !== 'punc') continue
          if (u.v === ')') depth++
          else if (u.v === '(' && --depth === 0) break
        }
        if (k > 0 && sig[k - 1].t === 'func') k--
      }
      if (k < 0) return text
      anchored.set(sig[k], (anchored.get(sig[k]) ?? 0) + 1)
      hash.add(t)
      continue
    }
    if (t.t !== 'op' || t.v !== '@') continue
    // (an @ inside the brackets of a structured reference is part of its name token, not an operator)
    const last = sig[operand(i + 1) - 1]
    if (!last || last === t) return text
    open.add(t)
    shut.set(last, (shut.get(last) ?? 0) + 1)
  }
  if (!open.size && !hash.size) return text
  let out = lead
  let pos = 0
  for (const t of sig) {
    out += src.slice(pos, t.s)
    out += '_xlfn.ANCHORARRAY('.repeat(anchored.get(t) ?? 0)
    out += open.has(t) ? '_xlfn.SINGLE(' : hash.has(t) ? ')' : src.slice(t.s, t.e)
    out += ')'.repeat(shut.get(t) ?? 0)
    pos = t.e
  }
  return out + src.slice(pos)
}

/** the names LET and LAMBDA give values and parameters in a formula (lower case) */
function parameters(ast: Ast, out = new Set<string>()): Set<string> {
  const name = (n: Ast | undefined) => {
    if (n?.type === 'name' && n.sheet === undefined) out.add(n.name.replace(/^\[|\]$/g, '').trim().toLowerCase())
  }
  switch (ast.type) {
    case 'call':
      if (ast.name === 'LET') for (let i = 0; i + 1 < ast.args.length; i += 2) name(ast.args[i])
      else if (ast.name === 'LAMBDA') ast.args.slice(0, -1).forEach(name)
      ast.args.forEach((a) => parameters(a, out))
      break
    case 'invoke':
      parameters(ast.fn, out)
      ast.args.forEach((a) => parameters(a, out))
      break
    case 'unary':
    case 'percent':
      parameters(ast.arg, out)
      break
    case 'binary':
    case 'range':
      parameters(ast.left, out)
      parameters(ast.right, out)
      break
    case 'union':
      ast.items.forEach((a) => parameters(a, out))
      break
  }
  return out
}

/** The names of LET and the parameters of LAMBDA as a file writes them: with the prefix `_xlpm.` (Excel takes one without for a defined name). */
function withParameterPrefixes(text: string): string {
  if (!/\b(?:LET|LAMBDA)\s*\(/i.test(text)) return text
  let params: Set<string>
  try {
    params = parameters(parseFormula(text))
  } catch {
    return text
  }
  if (!params.size) return text
  const lead = text.startsWith('=') ? 1 : 0
  return rewrite(text, (t) => {
    const src = text.slice(t.s + lead, t.e + lead)
    if (t.t === 'name' && t.sheet === undefined && !/^\[?_xlpm\./i.test(src)) {
      const optional = /^\[.*\]$/.test(src)
      const bare = optional ? src.slice(1, -1).trim() : src
      if (params.has(bare.toLowerCase())) return optional ? `[_xlpm.${bare}]` : `_xlpm.${bare}`
    }
    // a name of LET called as a function
    if (t.t === 'func' && !src.startsWith('_') && params.has(src.toLowerCase())) return `_xlpm.${src}`
    return undefined
  })
}

/**
 * Structured references to the row of the formula as a file writes them: `Table[@Qty]` is `Table[[#This Row],[Qty]]`,
 * and one without a table (`[@Qty]`) names the table the formula is in (`table`).
 */
function withThisRow(text: string, table: string | undefined): string {
  if (!text.includes('[@') && !(table !== undefined && text.includes('['))) return text
  // (an optional parameter of LAMBDA is written in brackets too: `[y]` is no column)
  let params: Set<string> | undefined
  if (/\bLAMBDA\s*\(/i.test(text)) {
    try {
      params = parameters(parseFormula(text))
    } catch {
      return text
    }
  }
  return rewrite(text, (t) => {
    if (t.t !== 'name' || t.sheet !== undefined) return undefined
    const open = t.v.indexOf('[')
    if (open < 0 || !t.v.endsWith(']')) return undefined
    if (open === 0 && params?.has(t.v.slice(1, -1).trim().toLowerCase())) return undefined
    const name = open > 0 ? t.v.slice(0, open) : table
    if (name === undefined) return undefined
    const inner = t.v.slice(open + 1, -1).trim()
    if (!inner.startsWith('@')) return open > 0 ? undefined : `${name}[${inner}]`
    const rest = inner.slice(1).trim()
    return `${name}[${rest === '' ? '#This Row' : `[#This Row],${rest.startsWith('[') ? rest : `[${rest}]`}`}]`
  })
}

/**
 * The formula as a file holds it: the functions newer than the format given their prefix (one typed has none), the
 * operators and shorthands a file has no word for written out. `table`: the table the formula's cell is in.
 */
export function withFunctionPrefixes(text: string, table?: string): string {
  text = withParameterPrefixes(withoutAt(withThisRow(text, table)))
  if (!/[A-Za-z]\(/.test(text)) return text
  return rewrite(text, (t) => {
    if (t.t !== 'func') return undefined
    const src = text.slice(text.startsWith('=') ? t.s + 1 : t.s, text.startsWith('=') ? t.e + 1 : t.e)
    if (src.startsWith('_')) return undefined
    if (FUTURE.has(t.v)) return `_xlfn.${src}`
    if (FUTURE_WS.has(t.v)) return `_xlfn._xlws.${src}`
    return undefined
  })
}

/**
 * The operators a file writes as functions, as they are typed: `SINGLE(A1:A3)` is `@A1:A3`, `ANCHORARRAY(A1)` is
 * `A1#`. Only where the argument is one reference, name or call: `@` and `#` apply to no more.
 */
function withOperators(text: string): string {
  if (!/(?:SINGLE|ANCHORARRAY)\(/i.test(text)) return text
  const src = text.startsWith('=') ? text.slice(1) : text
  let toks: Token[]
  try {
    toks = tokenize(src).filter((t) => t.t !== 'ws')
  } catch {
    return text
  }
  /** the index of the `)` that closes the call whose name is at `i` */
  const close = (list: Token[], i: number): number => {
    let depth = 0
    for (let k = i + 1; k < list.length; k++) {
      const u = list[k]
      if (u.t !== 'punc') continue
      if (u.v === '(') depth++
      else if (u.v === ')' && --depth === 0) return k
    }
    return -1
  }
  const edits = new Map<number, string>()
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.t !== 'func' || (t.v !== 'SINGLE' && t.v !== 'ANCHORARRAY')) continue
    const end = close(toks, i)
    if (end < 0) continue
    const inner = toks.slice(i + 2, end)
    const one = inner.length === 1 && (inner[0].t === 'ref' || inner[0].t === 'name')
    const call = inner.length > 2 && inner[0].t === 'func' && close(inner, 0) === inner.length - 1
    if (t.v === 'ANCHORARRAY' ? !one : !one && !call) continue
    edits.set(t.s, t.v === 'SINGLE' ? '@' : '')
    edits.set(toks[i + 1].s, '')
    edits.set(toks[end].s, t.v === 'SINGLE' ? '' : '#')
  }
  return edits.size ? rewrite(text, (t) => edits.get(t.s)) : text
}

/** The formula as it is typed: without the prefixes a file gives the newer functions, its operators as operators. */
export function stripFunctionPrefixes(text: string): string {
  if (!text.includes('_xl') && !text.includes('_XL')) return text
  return withOperators(stripPrefixes(text))
}

function stripPrefixes(text: string): string {
  return rewrite(text, (t) => {
    const src = text.slice(text.startsWith('=') ? t.s + 1 : t.s, text.startsWith('=') ? t.e + 1 : t.e)
    // (the names of LET and the parameters of LAMBDA have a prefix of their own)
    if (t.t === 'name' && t.sheet === undefined && /_xlpm\./i.test(src)) return src.replace(/^(\[?)_xlpm\./i, '$1')
    if (t.t !== 'func') return undefined
    const bare = src.replace(/^(?:_xlfn\.|_xlws\.|_xludf\.|_xlpm\.)+/i, '')
    return bare === src ? undefined : bare
  })
}

/** functions computed at every change: what they read is known when they run, or what they give changes by itself */
// (what ANCHORARRAY — A1# — reads is known when its formula has spilled)
const VOLATILE = new Set(['INDIRECT', 'OFFSET', 'NOW', 'TODAY', 'RAND', 'RANDBETWEEN', 'RANDARRAY', 'ANCHORARRAY'])

/** whether the formula calls a volatile function */
export function isVolatile(ast: Ast): boolean {
  switch (ast.type) {
    case 'call':
      return VOLATILE.has(ast.name) || ast.args.some(isVolatile)
    case 'invoke':
      return isVolatile(ast.fn) || ast.args.some(isVolatile)
    case 'unary':
    case 'percent':
      return isVolatile(ast.arg)
    case 'binary':
    case 'range':
      return isVolatile(ast.left) || isVolatile(ast.right)
    case 'union':
      return ast.items.some(isVolatile)
    default:
      return false
  }
}

function toRef(a: RefAddr): CellRef | RangeRef {
  const sheet = a.sheet === undefined ? {} : { sheet: a.sheet }
  if (a.kind === 'cell') return { ...sheet, r: a.r0, c: a.c0, absR: a.ar0, absC: a.ac0 }
  return { ...sheet, r0: a.r0, c0: a.c0, r1: a.r1, c1: a.c1 }
}

/** Every cell/range the formula reads directly (static references; INDIRECT/OFFSET targets are dynamic). */
export function references(ast: Ast): (CellRef | RangeRef)[] {
  const out: (CellRef | RangeRef)[] = []
  const walk = (n: Ast): void => {
    switch (n.type) {
      case 'ref':
        out.push(toRef(n.ref))
        break
      case 'range':
        if (n.left.type === 'ref' && n.right.type === 'ref' && sameSheet(n.left.ref.sheet, n.right.ref.sheet)) {
          const l = n.left.ref
          const r = n.right.ref
          out.push(
            toRef({ ...l, kind: 'area', r0: Math.min(l.r0, r.r0), c0: Math.min(l.c0, r.c0), r1: Math.max(l.r1, r.r1), c1: Math.max(l.c1, r.c1) }),
          )
        } else {
          walk(n.left)
          walk(n.right)
        }
        break
      case 'unary':
      case 'percent':
        walk(n.arg)
        break
      case 'binary':
        walk(n.left)
        walk(n.right)
        break
      case 'union':
        n.items.forEach(walk)
        break
      case 'call':
        n.args.forEach(walk)
        break
      case 'invoke':
        walk(n.fn)
        n.args.forEach(walk)
        break
    }
  }
  walk(ast)
  return out
}

/** The names a formula uses that are not references: defined names, tables, structured references, and the functions it calls. */
export function namesIn(ast: Ast): { name: string; sheet?: string; call: boolean }[] {
  const out: { name: string; sheet?: string; call: boolean }[] = []
  const walk = (n: Ast): void => {
    switch (n.type) {
      case 'name':
        out.push({ name: n.name, sheet: n.sheet, call: false })
        break
      case 'unary':
      case 'percent':
        walk(n.arg)
        break
      case 'binary':
      case 'range':
        walk(n.left)
        walk(n.right)
        break
      case 'union':
        n.items.forEach(walk)
        break
      case 'call':
        out.push({ name: n.name, call: true })
        n.args.forEach(walk)
        break
      case 'invoke':
        walk(n.fn)
        n.args.forEach(walk)
        break
    }
  }
  walk(ast)
  return out
}
