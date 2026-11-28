/**
 * TeX math → Office Math (OMML), for the Word file a Markdown document is: Word shows a real equation. The TeX and its
 * delimiters go along in two attributes of our own namespace (declared ignorable, so Word reads the file and drops
 * them), which is how the document gives the formula back as it was written.
 */
import { dict } from '../dict'
import { escAttr, escText } from '../raw'
import type { TexMath } from './scan'
import { textOf, texToMathml, type MNode } from './tex'

export const M_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math'
export const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
/** the namespace of the TeX attributes (`oe:tex`, `oe:delim`) on an equation */
export const OE_NS = 'urn:p10node:office-engine:math'

/** accents → the combining mark OMML puts over the base */
const ACC: Record<string, string> = dict({
  '^': '\u0302', '\u02c7': '\u030c', '~': '\u0303', '\u00b4': '\u0301', '`': '\u0300', '\u02d9': '\u0307', '\u00a8': '\u0308',
  '\u20db': '\u20db', '\u20dc': '\u20dc', '\u02d8': '\u0306', '\u00af': '\u0305', '\u2192': '\u20d7', '\u2190': '\u20d6', '\u2194': '\u20e1', '\u02da': '\u030a',
})
/** relations and punctuation: where the operand of a big operator ends */
const STOP = new Set([...'=<>≤≥≠≈≡∼≃≅≪≫∈∉⊂⊃⊆⊇→←↔⇒⇐⇔⟶⟹⟺↦∝,;:|'])
/** colors Word takes by name, as hex (other names are left out) */
const NAMED: Record<string, string> = dict({
  black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', cyan: '00FFFF', magenta: 'FF00FF',
  gray: '808080', grey: '808080', orange: 'FFA500', purple: '800080', brown: 'A52A2A', pink: 'FFC0CB', violet: 'EE82EE', teal: '008080',
  olive: '808000', lime: '00FF00', navy: '000080', maroon: '800000', silver: 'C0C0C0', aqua: '00FFFF', fuchsia: 'FF00FF', darkgray: 'A9A9A9',
  lightgray: 'D3D3D3', darkgreen: '006400', darkblue: '00008B', darkred: '8B0000',
})

function hexOf(c: string | undefined): string | undefined {
  if (!c) return undefined
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.slice(1).toUpperCase()
  if (/^#[0-9a-f]{3}$/i.test(c)) return [...c.slice(1)].map((x) => x + x).join('').toUpperCase()
  return NAMED[c.toLowerCase()]
}

class Writer {
  constructor(private w: string) {}

  /** a run of math text: `plain` upright (sty p), `text` ordinary text (m:nor) */
  run(t: string, how: { plain?: boolean; text?: boolean }, color?: string): string {
    if (!t) return ''
    const pr = how.text ? '<m:rPr><m:nor/></m:rPr>' : how.plain ? '<m:rPr><m:sty m:val="p"/></m:rPr>' : ''
    const w = this.w
    const rpr = how.text ? (color ? `<${w}rPr><${w}color ${w}val="${color}"/></${w}rPr>` : '') : `<${w}rPr><${w}rFonts ${w}ascii="Cambria Math" ${w}hAnsi="Cambria Math"/>${color ? `<${w}color ${w}val="${color}"/>` : ''}</${w}rPr>`
    return `<m:r>${pr}${rpr}<m:t xml:space="preserve">${escText(t)}</m:t></m:r>`
  }

  /** the content of an argument (m:e, m:num…) */
  arg(tag: string, n: MNode | undefined, color?: string): string {
    const body = n ? this.node(n, color) : ''
    return body ? `<m:${tag}>${body}</m:${tag}>` : `<m:${tag}/>`
  }

  /** children of a row, a big operator taking what follows it (up to a relation) as its operand */
  row(kids: MNode[], color?: string): string {
    let out = ''
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]
      const big = bigOf(k)
      if (big) {
        let j = i + 1
        while (j < kids.length && !isStop(kids[j])) j++
        out += this.nary(big, kids.slice(i + 1, j), color)
        i = j - 1
        continue
      }
      out += this.node(k, color)
    }
    return out
  }

  private nary(b: Big, operand: MNode[], color?: string): string {
    const chr = b.op.x ?? '∫'
    const pr =
      `<m:naryPr><m:chr m:val="${escAttr(chr)}"/><m:limLoc m:val="${b.under ? 'undOvr' : 'subSup'}"/>` +
      (b.sub ? '' : '<m:subHide m:val="1"/>') +
      (b.sup ? '' : '<m:supHide m:val="1"/>') +
      '</m:naryPr>'
    return `<m:nary>${pr}${this.arg('sub', b.sub, color)}${this.arg('sup', b.sup, color)}<m:e>${this.row(operand, color)}</m:e></m:nary>`
  }

  node(n: MNode, color?: string): string {
    const k = n.k ?? []
    switch (n.t) {
      case 'math':
      case 'semantics':
        return k[0] ? this.node(k[0], color) : ''
      case 'mi': {
        const t = n.x ?? ''
        return this.run(t, { plain: n.a?.mathvariant === 'normal' || [...t].length > 1 }, color)
      }
      case 'mn':
        return this.run(n.x ?? '', {}, color)
      case 'mo':
        return this.run((n.x ?? '').replace(/[\u2061\u200b]/g, ''), {}, color)
      case 'mtext':
      case 'merror':
        return this.run(textOf(n), { text: true }, color)
      case 'mspace': {
        const w = parseFloat(n.a?.width ?? '0')
        const sp = w >= 2 ? '\u2003\u2003' : w >= 1 ? '\u2003' : w >= 0.5 ? '\u2002' : w >= 0.27 ? '\u2004' : w >= 0.2 ? '\u2005' : w >= 0.15 ? '\u2009' : ''
        return this.run(sp, {}, color)
      }
      case 'mstyle': {
        const c = hexOf(n.a?.mathcolor) ?? color
        return this.row(k, c)
      }
      case 'mrow':
      case 'mpadded': {
        const f = n.n?.fence
        if (!f) return this.row(k, color)
        // \left( … \middle| … \right): one delimiter object, the parts between \middle as its arguments
        const inner = k.filter((x) => !(x.t === 'mo' && x.a?.fence === 'true'))
        const parts: MNode[][] = [[]]
        let sep = ''
        for (const x of inner) {
          if (x.n?.sep) {
            sep ||= (x.x ?? '').replace('\u200b', '')
            parts.push([])
          } else parts[parts.length - 1].push(x)
        }
        const pr = `<m:dPr><m:begChr m:val="${escAttr(f[0])}"/>${sep ? `<m:sepChr m:val="${escAttr(sep)}"/>` : ''}<m:endChr m:val="${escAttr(f[1])}"/></m:dPr>`
        return `<m:d>${pr}${parts.map((p) => `<m:e>${this.row(p, color)}</m:e>`).join('')}</m:d>`
      }
      case 'mfrac': {
        const pr = n.a?.linethickness === '0' ? '<m:fPr><m:type m:val="noBar"/></m:fPr>' : ''
        return `<m:f>${pr}${this.arg('num', k[0], color)}${this.arg('den', k[1], color)}</m:f>`
      }
      case 'msqrt':
        return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/>${this.arg('e', k[0], color)}</m:rad>`
      case 'mroot':
        return `<m:rad>${this.arg('deg', k[1], color)}${this.arg('e', k[0], color)}</m:rad>`
      case 'msub':
      case 'msup':
      case 'msubsup':
      case 'munder':
      case 'mover':
      case 'munderover': {
        const big = bigOf(n)
        if (big) return this.nary(big, [], color)
        const [b, x, y] = k
        if (n.t === 'msub') return `<m:sSub>${this.arg('e', b, color)}${this.arg('sub', x, color)}</m:sSub>`
        if (n.t === 'msup') return `<m:sSup>${this.arg('e', b, color)}${this.arg('sup', x, color)}</m:sSup>`
        if (n.t === 'msubsup') return `<m:sSubSup>${this.arg('e', b, color)}${this.arg('sub', x, color)}${this.arg('sup', y, color)}</m:sSubSup>`
        const mark = x?.t === 'mo' ? (x.x ?? '') : ''
        if (n.t === 'mover' && (mark === '‾' || mark === '¯') && n.a?.accent === 'true' && (x.a?.stretchy === 'true' || mark === '‾'))
          return `<m:bar><m:barPr><m:pos m:val="top"/></m:barPr>${this.arg('e', b, color)}</m:bar>`
        if (n.t === 'munder' && mark === '_') return `<m:bar><m:barPr><m:pos m:val="bot"/></m:barPr>${this.arg('e', b, color)}</m:bar>`
        if (mark === '⏞' || mark === '⏟' || mark === '⏠' || mark === '⏡') {
          const top = n.t === 'mover'
          return `<m:groupChr><m:groupChrPr><m:chr m:val="${mark}"/><m:pos m:val="${top ? 'top' : 'bot'}"/><m:vertJc m:val="${top ? 'bot' : 'top'}"/></m:groupChrPr>${this.arg('e', b, color)}</m:groupChr>`
        }
        if (n.t === 'mover' && n.a?.accent === 'true' && ACC[mark]) return `<m:acc><m:accPr><m:chr m:val="${ACC[mark]}"/></m:accPr>${this.arg('e', b, color)}</m:acc>`
        if (n.t === 'munder') return `<m:limLow>${this.arg('e', b, color)}${this.arg('lim', x, color)}</m:limLow>`
        if (n.t === 'mover') return `<m:limUpp>${this.arg('e', b, color)}${this.arg('lim', x, color)}</m:limUpp>`
        return `<m:limUpp><m:e><m:limLow>${this.arg('e', b, color)}${this.arg('lim', x, color)}</m:limLow></m:e>${this.arg('lim', y, color)}</m:limUpp>`
      }
      case 'mtable': {
        const rows = k.filter((r) => r.t === 'mtr')
        const cols = Math.max(1, ...rows.map((r) => (r.k ?? []).length))
        const aligns = Array.from({ length: cols }, (_, c) => rows[0]?.k?.[c]?.a?.columnalign ?? 'center')
        let mcs = ''
        for (let c = 0; c < cols; ) {
          let e = c
          while (e < cols && aligns[e] === aligns[c]) e++
          mcs += `<m:mc><m:mcPr><m:count m:val="${e - c}"/><m:mcJc m:val="${aligns[c]}"/></m:mcPr></m:mc>`
          c = e
        }
        const body = rows.map((r) => `<m:mr>${Array.from({ length: cols }, (_, c) => this.arg('e', r.k?.[c]?.k?.[0], color)).join('')}</m:mr>`).join('')
        return `<m:m><m:mPr><m:mcs>${mcs}</m:mcs></m:mPr>${body}</m:m>`
      }
      case 'mphantom':
        return `<m:phant><m:phantPr><m:show m:val="0"/></m:phantPr><m:e>${this.row(k, color)}</m:e></m:phant>`
      case 'menclose':
        return `<m:borderBox><m:e>${this.row(k, color)}</m:e></m:borderBox>`
      case 'annotation':
        return ''
      default:
        return this.row(k, color)
    }
  }
}

interface Big {
  op: MNode
  sub?: MNode
  sup?: MNode
  under: boolean
}

/** a big operator (∑, ∫…), with its limits */
function bigOf(n: MNode): Big | undefined {
  if (n.t === 'mo' && n.n?.op && n.n.op !== 'limits') return { op: n, under: n.n.op === 'display' }
  const b = n.k?.[0]
  if (!b || b.t !== 'mo' || !b.n?.op || b.n.op === 'limits') return undefined
  switch (n.t) {
    case 'msub': return { op: b, sub: n.k![1], under: false }
    case 'msup': return { op: b, sup: n.k![1], under: false }
    case 'msubsup': return { op: b, sub: n.k![1], sup: n.k![2], under: false }
    case 'munder': return { op: b, sub: n.k![1], under: true }
    case 'mover': return { op: b, sup: n.k![1], under: true }
    case 'munderover': return { op: b, sub: n.k![1], sup: n.k![2], under: true }
  }
  return undefined
}

const isStop = (n: MNode) => n.t === 'mo' && STOP.has(n.x ?? '')

/** the attribute value of a text: line breaks and tabs as character references, so they come back as they were */
const attrText = (s: string) => escAttr(s).replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;')

/**
 * The OMML of a formula: `m:oMath` (inline) or `m:oMathPara` (display) holding the equation, with the TeX and its
 * delimiters as `oe:tex` / `oe:delim`. `w` is the WordprocessingML prefix of the document ("w:"); `ns`: the
 * namespaces are declared on the element (where the document root may not declare them).
 */
export function mathOmml(m: TexMath, w = 'w:', ns = false): string {
  const display = m.delim === '$$'
  const body = new Writer(w).node(texToMathml(m.tex, display).node) || '<m:r><m:t> </m:t></m:r>'
  const decl = ns ? ` xmlns:m="${M_NS}" xmlns:oe="${OE_NS}"` : ''
  const attrs = `${decl} oe:tex="${attrText(m.tex)}" oe:delim="${display ? '$$' : '$'}"`
  return display ? `<m:oMathPara${attrs}><m:oMath>${body}</m:oMath></m:oMathPara>` : `<m:oMath${attrs}>${body}</m:oMath>`
}

/** the TeX an equation element of ours carries (its attributes, read by the XML reader without their prefix) */
export function mathOf(a: Record<string, string | undefined>): TexMath | undefined {
  const tex = a.tex
  const delim = a.delim
  return typeof tex === 'string' && (delim === '$' || delim === '$$') ? { tex, delim } : undefined
}
