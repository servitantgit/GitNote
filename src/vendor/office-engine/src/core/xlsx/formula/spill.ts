/** Which formulas may give more than one value: those are dynamic array formulas, whose values spill over the cells next to them. */
import { FUNCTIONS } from './functions'
import { INTERSECT, type Ast } from './parser'

/** functions that give an array or a reference whatever they are given */
const ARRAYS = new Set(
  (
    'SEQUENCE RANDARRAY TRANSPOSE FILTER SORT SORTBY UNIQUE CHOOSECOLS CHOOSEROWS HSTACK VSTACK TOCOL TOROW WRAPCOLS WRAPROWS TAKE DROP EXPAND TRIMRANGE GROUPBY PIVOTBY ' +
    'MAP REDUCE SCAN BYROW BYCOL MAKEARRAY MMULT MINVERSE MUNIT ARRAYFORMULA FLATTEN ARRAY_CONSTRAIN SORTN QUERY FILTERXML TEXTSPLIT SPLIT REGEXEXTRACT ' +
    'FREQUENCY MODE.MULT LINEST LOGEST TREND GROWTH INDIRECT ANCHORARRAY'
  ).split(' '),
)

/**
 * Whether a formula, evaluated without implicit intersection, may give several values: it reads a range where one
 * value is taken, holds an array, or calls a function that gives one. Such a formula is a dynamic array formula.
 */
/** rows and columns of a reference written as such (undefined: not one, its size is not known before it is evaluated) */
function shape(a: Ast | undefined): { h: number; w: number } | undefined {
  return a?.type === 'ref' ? { h: a.ref.r1 - a.ref.r0 + 1, w: a.ref.c1 - a.ref.c0 + 1 } : undefined
}

const isNumber = (a: Ast, n: number) => a.type === 'num' && a.value === n

/**
 * The functions that give one cell or several depending on what they are asked: several when their arguments say so
 * as written (a whole row of INDEX, a height of OFFSET, a return range of XLOOKUP wider than a cell).
 */
function lookupSpills(name: string, args: Ast[], spills: (a: Ast) => boolean): boolean | undefined {
  switch (name) {
    case 'INDEX': {
      if (args.slice(1).some(spills)) return true
      const src = shape(args[0])
      const twoD = src ? src.h > 1 && src.w > 1 : false
      // row or column 0 (or left out): the whole column / row
      if (args.slice(1, 3).some((a) => a.type === 'missing' || isNumber(a, 0))) return src ? src.h > 1 || src.w > 1 : true
      return args.length === 2 && twoD
    }
    case 'OFFSET': {
      if (args.slice(1).some(spills)) return true
      const size = args.slice(3).filter((a) => a.type !== 'missing')
      if (size.some((a) => !isNumber(a, 1))) return true
      return size.length < 2 && !!args[0] && spills(args[0])
    }
    case 'XLOOKUP': {
      if (args[0] && spills(args[0])) return true
      const look = shape(args[1])
      const ret = shape(args[2])
      if (!look || !ret) return false
      // looked up down a column: a row of the return range; along a row: a column of it
      return look.w === 1 ? ret.w > 1 : ret.h > 1
    }
    case 'ROW':
    case 'COLUMN':
      return args.length > 0 && spills(args[0])
  }
  return undefined
}

/** what a name of the workbook stands for (a defined name), for `spills` to look into; undefined when there is none */
export type NameOf = (name: string, sheet: string | undefined) => Ast | undefined

/** a name of LET / LAMBDA as it is looked up */
const key = (name: string) => name.toLowerCase().replace(/^\[|\]$/g, '').trim().replace(/^_xlpm\./, '')

/**
 * Whether a formula, evaluated without implicit intersection, may give several values: it reads a range where one
 * value is taken, holds an array, or calls a function that gives one. Such a formula is a dynamic array formula.
 * `names`: the defined names of the workbook (without it any name may stand for a range).
 */
export function spills(ast: Ast, names?: NameOf, scope: ReadonlyMap<string, boolean> = new Map(), depth = 0): boolean {
  const go = (a: Ast) => spills(a, names, scope, depth)
  switch (ast.type) {
    case 'ref':
      return ast.ref.r1 > ast.ref.r0 || ast.ref.c1 > ast.ref.c0
    case 'array':
      return ast.rows.length > 1 || ast.rows[0].length > 1
    case 'range':
    case 'union':
      return true
    case 'name': {
      if (ast.sheet === undefined && scope.has(key(ast.name))) return scope.get(key(ast.name))!
      // a defined name: what it stands for; a table, a structured reference, a name not known: several cells, maybe
      const def = depth < 8 && !ast.name.includes('[') ? names?.(ast.name, ast.sheet) : undefined
      return def ? spills(def, names, new Map(), depth + 1) : true
    }
    case 'invoke':
      return go(ast.fn) || ast.args.some(go)
    case 'unary':
    case 'percent':
      return go(ast.arg)
    case 'binary':
      return go(ast.left) || go(ast.right)
    case 'call': {
      const { name, args } = ast
      if (name === 'SINGLE' || name === 'ISOMITTED') return false
      // the cells two references both have: several, maybe
      if (name === INTERSECT) return true
      // a name of LET called as a function gives what its function gives
      if (scope.has(key(name))) return scope.get(key(name))! || args.some(go)
      if (name === 'LET') {
        // each name is what its value is; the formula is what its last part is
        const inner = new Map(scope)
        for (let i = 0; i + 1 < args.length; i += 2) {
          const n = args[i]
          const value = spills(args[i + 1], names, inner, depth)
          if (n.type === 'name') inner.set(key(n.name), value)
        }
        return args.length > 0 && spills(args[args.length - 1], names, inner, depth)
      }
      if (name === 'LAMBDA') {
        // (what its parameters will be is not known: single values, as most are)
        const inner = new Map(scope)
        for (const p of args.slice(0, -1)) if (p.type === 'name') inner.set(key(p.name), false)
        return args.length > 0 && spills(args[args.length - 1], names, inner, depth)
      }
      if (!Object.hasOwn(FUNCTIONS, name)) {
        // a defined name that is a LAMBDA: what its formula gives; a function not known: anything
        const def = depth < 8 ? names?.(name, undefined) : undefined
        return def ? spills(def, names, new Map(), depth + 1) || args.some(go) : true
      }
      if (ARRAYS.has(name)) return true
      const lookup = lookupSpills(name, args, go)
      if (lookup !== undefined) return lookup
      const def = FUNCTIONS[name]
      // IF, IFERROR, CHOOSE…: what they give is one of their arguments; a function of single values is computed for each value of an array
      if (def.kind === 'lazy' || def.scalarArgs) return args.some(go)
      const single = def.single
      return !!single && args.some((a, i) => single(i, args.length) && go(a))
    }
    default:
      return false
  }
}
