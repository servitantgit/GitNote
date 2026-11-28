/**
 * The text of a Visio shape: characters with markers between them that name the Character (`cp`) and Paragraph
 * (`pp`) rows in force from there on, and fields (`fld`) holding their shown value.
 */
import type { VNode } from './sheet'

export interface VRun {
  text: string
  /** Character row */
  cp: string
  /** a line break inside the paragraph */
  br?: boolean
}

export interface VPara {
  /** Paragraph row */
  pp: string
  runs: VRun[]
}

/** The paragraphs of a `Text` element; none when it holds no characters. */
export function readText(el: VNode | undefined): VPara[] {
  if (!el) return []
  let cp = '0'
  let pp = '0'
  let para: VPara = { pp, runs: [] }
  const paras: VPara[] = [para]
  let any = false
  const add = (text: string) => {
    // a paragraph ends at a line feed (alone, or after a carriage return); U+2028 breaks the line inside it
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    lines.forEach((line, i) => {
      if (i > 0) paras.push((para = { pp, runs: [] }))
      const parts = line.split('\u2028')
      parts.forEach((part, k) => {
        if (k > 0) para.runs.push({ text: '', cp, br: true })
        if (part) {
          any = true
          const last = para.runs[para.runs.length - 1]
          if (last && !last.br && last.cp === cp) last.text += part
          else para.runs.push({ text: part, cp })
        }
      })
    })
  }
  for (const c of el.c) {
    if (c.n === '#text') add(c.t)
    else if (c.n === 'fld') add(c.t)
    else if (c.n === 'cp') cp = c.a.IX ?? '0'
    else if (c.n === 'pp') {
      pp = c.a.IX ?? '0'
      if (!para.runs.length) para.pp = pp
    }
  }
  if (!any) return []
  // the text ends with the line feed of its last paragraph
  while (paras.length > 1 && !paras[paras.length - 1].runs.length) paras.pop()
  return paras
}
