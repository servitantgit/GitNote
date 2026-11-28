/**
 * The TeX commands the math converter knows that stand for one character (letters, symbols, operators, arrows,
 * delimiters) or a function name, and the Unicode letters of the math alphabets (bold, script, double-struck…).
 */
import { dict } from '../dict'

/** "name char name char…" → { name: char } */
const table = (s: string): Record<string, string> => {
  const out: Record<string, string> = dict({})
  const parts = s.trim().split(/\s+/)
  for (let k = 0; k + 1 < parts.length; k += 2) out[parts[k]] = parts[k + 1]
  return out
}

/** letters and other ordinary symbols: an `mi` */
export const ORD = table(`
  alpha α beta β gamma γ delta δ epsilon ϵ varepsilon ε zeta ζ eta η theta θ vartheta ϑ iota ι kappa κ varkappa ϰ
  lambda λ mu μ nu ν xi ξ omicron ο pi π varpi ϖ rho ρ varrho ϱ sigma σ varsigma ς tau τ upsilon υ phi ϕ varphi φ
  chi χ psi ψ omega ω digamma ϝ
  infty ∞ partial ∂ nabla ∇ forall ∀ exists ∃ nexists ∄ emptyset ∅ varnothing ∅ hbar ℏ hslash ℏ ell ℓ Re ℜ Im ℑ
  aleph ℵ beth ℶ gimel ℷ daleth ℸ wp ℘ angle ∠ measuredangle ∡ sphericalangle ∢ triangle △ triangledown ▽
  square □ Box □ blacksquare ■ Diamond ◊ lozenge ◊ blacklozenge ⧫ bigstar ★ clubsuit ♣ diamondsuit ♢ heartsuit ♡
  spadesuit ♠ flat ♭ natural ♮ sharp ♯ backprime ‵ top ⊤ bot ⊥ degree ° checkmark ✓ mho ℧ eth ð imath ı jmath ȷ
  complement ∁ Finv Ⅎ Game ⅁ circledS Ⓢ S § P ¶ copyright © pounds £ yen ¥ euro € dag † ddag ‡
  vartriangle △ blacktriangle ▴ blacktriangledown ▾ diagup ╱ diagdown ╲
`)

/** capital Greek letters: upright, as TeX sets them */
export const UPRIGHT = table(`
  Gamma Γ Delta Δ Theta Θ Lambda Λ Xi Ξ Pi Π Sigma Σ Upsilon Υ Phi Φ Psi Ψ Omega Ω
  Alpha Α Beta Β Epsilon Ε Zeta Ζ Eta Η Iota Ι Kappa Κ Mu Μ Nu Ν Omicron Ο Rho Ρ Tau Τ Chi Χ
`)

/** binary operators, relations, arrows, punctuation: an `mo` */
export const OP = table(`
  pm ± mp ∓ times × div ÷ cdot ⋅ ast ∗ star ⋆ circ ∘ bullet ∙ oplus ⊕ ominus ⊖ otimes ⊗ oslash ⊘ odot ⊙ cap ∩ cup ∪
  sqcap ⊓ sqcup ⊔ uplus ⊎ wedge ∧ land ∧ vee ∨ lor ∨ setminus ∖ smallsetminus ∖ wr ≀ amalg ⨿ diamond ⋄
  bigtriangleup △ bigtriangledown ▽ triangleleft ◃ triangleright ▹ lhd ⊲ rhd ⊳ unlhd ⊴ unrhd ⊵ cdotp ⋅ centerdot ⋅
  intercal ⊺ ltimes ⋉ rtimes ⋊ leftthreetimes ⋋ rightthreetimes ⋌ dotplus ∔ divideontimes ⋇ barwedge ⌅ veebar ⊻
  curlywedge ⋏ curlyvee ⋎ boxplus ⊞ boxminus ⊟ boxtimes ⊠ boxdot ⊡ circledast ⊛ circledcirc ⊚ circleddash ⊝
  Cap ⋒ Cup ⋓ gtrdot ⋗ lessdot ⋖ dagger † ddagger ‡ neg ¬ lnot ¬ prime ′ surd √ ldotp . colon :
  leq ≤ le ≤ geq ≥ ge ≥ neq ≠ ne ≠ equiv ≡ approx ≈ approxeq ≊ sim ∼ simeq ≃ cong ≅ propto ∝ ll ≪ gg ≫ lll ⋘ ggg ⋙
  prec ≺ succ ≻ preceq ⪯ succeq ⪰ subset ⊂ supset ⊃ subseteq ⊆ supseteq ⊇ subsetneq ⊊ supsetneq ⊋ sqsubset ⊏
  sqsupset ⊐ sqsubseteq ⊑ sqsupseteq ⊒ in ∈ ni ∋ owns ∋ notin ∉ vdash ⊢ dashv ⊣ models ⊨ vDash ⊨ Vdash ⊩ Vvdash ⊪
  perp ⊥ parallel ∥ nparallel ∦ mid ∣ nmid ∤ asymp ≍ bowtie ⋈ Join ⋈ smile ⌣ frown ⌢ doteq ≐ doteqdot ≑ Doteq ≑
  leqslant ⩽ geqslant ⩾ leqq ≦ geqq ≧ lesssim ≲ gtrsim ≳ lessapprox ⪅ gtrapprox ⪆ lessgtr ≶ gtrless ≷ nless ≮ ngtr ≯
  nleq ≰ ngeq ≱ nsim ≁ ncong ≇ nsubseteq ⊈ nsupseteq ⊉ triangleq ≜ coloneqq ≔ eqqcolon ≕ thicksim ∼ thickapprox ≈
  backsim ∽ backsimeq ⋍ eqsim ≂ risingdotseq ≓ fallingdotseq ≒ circeq ≗ bumpeq ≏ Bumpeq ≎ therefore ∴ because ∵
  varpropto ∝ between ≬ pitchfork ⋔ vartriangleleft ⊲ vartriangleright ⊳ trianglelefteq ⊴ trianglerighteq ⊵
  lneq ⪇ gneq ⪈ lneqq ≨ gneqq ≩ precsim ≾ succsim ≿ nprec ⊀ nsucc ⊁ nvdash ⊬ nvDash ⊭ Subset ⋐ Supset ⋑
  subseteqq ⫅ supseteqq ⫆ eqcirc ≖ gtreqless ⋛ lesseqgtr ⋚ shortmid ∣ shortparallel ∥ smallsmile ⌣ smallfrown ⌢
  to → rightarrow → leftarrow ← gets ← leftrightarrow ↔ Rightarrow ⇒ Leftarrow ⇐ Leftrightarrow ⇔ implies ⟹
  impliedby ⟸ iff ⟺ longrightarrow ⟶ longleftarrow ⟵ longleftrightarrow ⟷ Longrightarrow ⟹ Longleftarrow ⟸
  Longleftrightarrow ⟺ mapsto ↦ longmapsto ⟼ hookrightarrow ↪ hookleftarrow ↩ uparrow ↑ downarrow ↓ updownarrow ↕
  Uparrow ⇑ Downarrow ⇓ Updownarrow ⇕ nearrow ↗ searrow ↘ swarrow ↙ nwarrow ↖ rightharpoonup ⇀ rightharpoondown ⇁
  leftharpoonup ↼ leftharpoondown ↽ rightleftharpoons ⇌ leftrightharpoons ⇋ upharpoonleft ↿ upharpoonright ↾
  downharpoonleft ⇃ downharpoonright ⇂ rightrightarrows ⇉ leftleftarrows ⇇ rightleftarrows ⇄ leftrightarrows ⇆
  twoheadrightarrow ↠ twoheadleftarrow ↞ rightarrowtail ↣ leftarrowtail ↢ looparrowright ↬ looparrowleft ↫
  curvearrowright ↷ curvearrowleft ↶ circlearrowright ↻ circlearrowleft ↺ Rrightarrow ⇛ Lleftarrow ⇚
  rightsquigarrow ⇝ leadsto ⇝ leftrightsquigarrow ↭ nrightarrow ↛ nleftarrow ↚ nRightarrow ⇏ nLeftarrow ⇍
  nleftrightarrow ↮ nLeftrightarrow ⇎ dashrightarrow ⇢ dashleftarrow ⇠ Lsh ↰ Rsh ↱ multimap ⊸ restriction ↾
  upuparrows ⇈ downdownarrows ⇊
  ldots … dots … cdots ⋯ vdots ⋮ ddots ⋱ dotsb ⋯ dotsc … dotsi ⋯ dotsm ⋯ dotso … iddots ⋰ mathellipsis …
`)

/** big operators (`n` kind: limits under / over in display style, or always beside for the integrals) */
export const BIG = table(`
  sum ∑ prod ∏ coprod ∐ bigcup ⋃ bigcap ⋂ bigsqcup ⨆ bigvee ⋁ bigwedge ⋀ bigoplus ⨁ bigotimes ⨂ bigodot ⨀
  biguplus ⨄ int ∫ iint ∬ iiint ∭ iiiint ⨌ oint ∮ oiint ∯ oiiint ∰ intop ∫ smallint ∫
`)
export const INTEGRAL = new Set(['∫', '∬', '∭', '⨌', '∮', '∯', '∰'])
/** big operator characters typed as themselves */
export const BIG_CHARS = new Set(Object.values(BIG))

/** named functions, upright; the second set takes its limits under it in display style */
export const FUNC = new Set('arccos arcsin arctan arg cos cosh cot coth csc deg dim exp hom ker lg ln log sec sin sinh tan tanh sgn sech csch arccot arcsec arccsc'.split(' '))
export const FUNC_LIMITS = new Set('det gcd inf lim liminf limsup max min Pr sup injlim projlim'.split(' '))
const FUNC_TEXT: Record<string, string> = dict({ liminf: 'lim inf', limsup: 'lim sup', injlim: 'inj lim', projlim: 'proj lim' })
export const funcText = (name: string) => FUNC_TEXT[name] ?? name

/** delimiters after \left, \right, \big…, and on their own */
export const DELIM = table(`
  langle ⟨ rangle ⟩ lvert | rvert | vert | lVert ‖ rVert ‖ Vert ‖ lfloor ⌊ rfloor ⌋ lceil ⌈ rceil ⌉ lbrace { rbrace }
  lbrack [ rbrack ] lgroup ⟮ rgroup ⟯ lmoustache ⎰ rmoustache ⎱ ulcorner ┌ urcorner ┐ llcorner └ lrcorner ┘
  backslash \\ uparrow ↑ downarrow ↓ updownarrow ↕ Uparrow ⇑ Downarrow ⇓ Updownarrow ⇕ { { } } | ‖
`)
/** characters that are delimiters after \left / \right */
export const DELIM_CHARS = new Set(['(', ')', '[', ']', '|', '/', '<', '>'])

/** spaces, in em */
export const SPACE: Record<string, number> = dict({
  ',': 0.1667, ':': 0.2222, '>': 0.2222, ';': 0.2778, '!': -0.1667, ' ': 0.3333, quad: 1, qquad: 2, enspace: 0.5, enskip: 0.5,
  thinspace: 0.1667, medspace: 0.2222, thickspace: 0.2778, negthinspace: -0.1667, negmedspace: -0.2222, negthickspace: -0.2778, space: 0.3333,
})

/** accents: the mark, whether it grows with what is under it, and whether it goes under */
export const ACCENT: Record<string, { c: string; wide?: boolean; under?: boolean; accent?: boolean }> = dict({
  hat: { c: '^', accent: true }, widehat: { c: '^', wide: true, accent: true }, check: { c: 'ˇ', accent: true }, widecheck: { c: 'ˇ', wide: true, accent: true },
  tilde: { c: '~', accent: true }, widetilde: { c: '~', wide: true, accent: true }, acute: { c: '´', accent: true }, grave: { c: '`', accent: true },
  dot: { c: '˙', accent: true }, ddot: { c: '¨', accent: true }, dddot: { c: '⃛', accent: true }, ddddot: { c: '⃜', accent: true }, breve: { c: '˘', accent: true },
  bar: { c: '¯', accent: true }, vec: { c: '→', accent: true }, mathring: { c: '˚', accent: true },
  overline: { c: '‾', wide: true, accent: true }, underline: { c: '_', wide: true, under: true },
  overrightarrow: { c: '→', wide: true }, overleftarrow: { c: '←', wide: true }, overleftrightarrow: { c: '↔', wide: true },
  underrightarrow: { c: '→', wide: true, under: true }, underleftarrow: { c: '←', wide: true, under: true }, underleftrightarrow: { c: '↔', wide: true, under: true },
  overbrace: { c: '⏞', wide: true }, underbrace: { c: '⏟', wide: true, under: true }, overgroup: { c: '⏠', wide: true }, undergroup: { c: '⏡', wide: true, under: true },
  utilde: { c: '~', wide: true, under: true },
})

/** relation (and arrow) characters a `\not` turns into their negated form; others get a long solidus overlay */
export const NEGATED: Record<string, string> = dict({
  '=': '≠', '<': '≮', '>': '≯', '≤': '≰', '≥': '≱', '∈': '∉', '∋': '∌', '⊂': '⊄', '⊃': '⊅', '⊆': '⊈', '⊇': '⊉', '≡': '≢', '∼': '≁', '≈': '≉',
  '≅': '≇', '∣': '∤', '∥': '∦', '→': '↛', '←': '↚', '↔': '↮', '⇒': '⇏', '⇐': '⇍', '⇔': '⇎', '≺': '⊀', '≻': '⊁', '⊢': '⊬', '⊨': '⊭', '∃': '∄',
  '≃': '≄', '≍': '≭', '⊑': '⋢', '⊒': '⋣', '⊲': '⋪', '⊳': '⋫', '⊴': '⋬', '⊵': '⋭',
})

/** characters typed as themselves that are operators (the rest of the non-letters are too, but these are common) */
export const OP_CHAR: Record<string, string> = dict({ '-': '−', '*': '∗', "'": '′' })

// ---------------------------------------------------------------- math alphabets

export type Font =
  | 'normal' | 'bold' | 'italic' | 'bold-italic' | 'double-struck' | 'script' | 'bold-script' | 'fraktur' | 'bold-fraktur'
  | 'sans-serif' | 'bold-sans-serif' | 'sans-serif-italic' | 'sans-serif-bold-italic' | 'monospace'

const LATIN: Partial<Record<Font, number>> = {
  bold: 0x1d400, italic: 0x1d434, 'bold-italic': 0x1d468, script: 0x1d49c, 'bold-script': 0x1d4d0, fraktur: 0x1d504, 'double-struck': 0x1d538,
  'bold-fraktur': 0x1d56c, 'sans-serif': 0x1d5a0, 'bold-sans-serif': 0x1d5d4, 'sans-serif-italic': 0x1d608, 'sans-serif-bold-italic': 0x1d63c, monospace: 0x1d670,
}
const DIGIT: Partial<Record<Font, number>> = { bold: 0x1d7ce, 'double-struck': 0x1d7d8, 'sans-serif': 0x1d7e2, 'bold-sans-serif': 0x1d7ec, monospace: 0x1d7f6 }
const GREEK: Partial<Record<Font, number>> = { bold: 0x1d6a8, italic: 0x1d6e2, 'bold-italic': 0x1d71c, 'bold-sans-serif': 0x1d756, 'sans-serif-bold-italic': 0x1d790 }
/** letters of the math alphabets that Unicode had already (the Letterlike Symbols block): their slots are empty */
const HOLES: Record<number, number> = {
  0x1d455: 0x210e, 0x1d49d: 0x212c, 0x1d4a0: 0x2130, 0x1d4a1: 0x2131, 0x1d4a3: 0x210b, 0x1d4a4: 0x2110, 0x1d4a7: 0x2112, 0x1d4a8: 0x2133,
  0x1d4ad: 0x211b, 0x1d4ba: 0x212f, 0x1d4bc: 0x210a, 0x1d4c4: 0x2134, 0x1d506: 0x212d, 0x1d50b: 0x210c, 0x1d50c: 0x2111, 0x1d515: 0x211c,
  0x1d51d: 0x2128, 0x1d53a: 0x2102, 0x1d53f: 0x210d, 0x1d545: 0x2115, 0x1d547: 0x2119, 0x1d548: 0x211a, 0x1d549: 0x211d, 0x1d551: 0x2124,
}
const GREEK_TAIL: Record<number, number> = { 0x3f4: 17, 0x2207: 25, 0x2202: 51, 0x3f5: 52, 0x3d1: 53, 0x3f0: 54, 0x3d5: 55, 0x3f1: 56, 0x3d6: 57 }

/** where a Greek letter (or ∇, ∂ and the variant forms) stands in a math alphabet's block of 58 */
function greekSlot(cp: number): number | undefined {
  if (cp >= 0x391 && cp <= 0x3a9 && cp !== 0x3a2) return cp - 0x391
  if (cp >= 0x3b1 && cp <= 0x3c9) return 26 + cp - 0x3b1
  return GREEK_TAIL[cp]
}

/** a letter or digit in a math alphabet (𝐱, ℝ, 𝔤…); itself when the alphabet has no such character */
export function styled(ch: string, font: Font): string {
  const cp = ch.codePointAt(0)!
  let base: number | undefined
  let at = -1
  if (cp >= 65 && cp <= 90) (base = LATIN[font]), (at = cp - 65)
  else if (cp >= 97 && cp <= 122) (base = LATIN[font]), (at = cp - 97 + 26)
  else if (cp >= 48 && cp <= 57) (base = DIGIT[font]), (at = cp - 48)
  else {
    const slot = greekSlot(cp)
    if (slot !== undefined) (base = GREEK[font]), (at = slot)
  }
  if (base === undefined || at < 0) return ch
  const out = base + at
  return String.fromCodePoint(HOLES[out] ?? out)
}
