/** Symbol / Wingdings text: the characters of these fonts sit in U+F020…U+F0FF; where Unicode has the glyph, it is used instead */

// Adobe Symbol encoding, 0x20…0xFF (a space where the font has no glyph)
const SYMBOL =
  ' !∀#∃%&∋()∗+,−./0123456789:;<=>?≅ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ[∴]⊥_‾αβχδεφγηιϕκλμνοπθρστυϖωξψζ{|}∼ ' +
  ' '.repeat(32) +
  '€ϒ′≤⁄∞ƒ♣♦♥♠↔←↑→↓°±″≥×∝∂•÷≠≡≈…⏐⎯↵ℵℑℜ℘⊗⊕∅∩∪⊃⊇⊄⊂⊆∈∉∠∇®©™∏√⋅¬∧∨⇔⇐⇑⇒⇓◊〈®©™∑⎛⎜⎝⎡⎢⎣⎧⎨⎩⎪ 〉∫⌠⎮⌡⎞⎟⎠⎤⎥⎦⎫⎬⎭ '

// the Wingdings glyphs that have a Unicode counterpart in common use (pictograms, bullets, check marks, arrows)
const WINGDINGS: Record<number, string> = {
  0x21: '✏', 0x22: '✂', 0x23: '✁', 0x28: '☎', 0x29: '✆', 0x2a: '✉', 0x36: '⌛', 0x37: '⌨', 0x46: '✌', 0x4a: '☺', 0x4c: '☹', 0x4e: '☠', 0x4f: '⚐',
  0x51: '✈', 0x52: '☼', 0x54: '❄', 0x58: '✠', 0x59: '✡', 0x5a: '☪', 0x5b: '☯', 0x5d: '☸', 0x5e: '♈', 0x61: '♌', 0x6c: '●', 0x6d: '❍', 0x6e: '■',
  0x6f: '□', 0x70: '◻', 0x71: '❑', 0x72: '❒', 0x75: '◆', 0x76: '❖', 0x77: '⬥', 0x78: '⌧', 0x79: '⍓', 0x7a: '⌘', 0x7b: '❀', 0x7c: '✿', 0x7d: '❝', 0x7e: '❞',
  0xa1: '○', 0xa7: '▪', 0xa8: '◻', 0xab: '★', 0xac: '✪', 0xd8: '➢', 0xe0: '➔', 0xe8: '➔', 0xf0: '⇨', 0xfb: '✗', 0xfc: '✓', 0xfd: '☒', 0xfe: '☑',
}

/**
 * `text` set in the font `font` with the characters it has no Unicode glyph for left as they are (U+F0xx, shown in the font).
 * Other fonts' text comes back unchanged.
 */
export function symbolToUnicode(text: string, font: string | undefined): string {
  const f = font?.toLowerCase().trim()
  const sym = f === 'symbol'
  if (!sym && f !== 'wingdings') return text
  let out = ''
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k)
    let m: string | undefined
    if (c >= 0xf020 && c <= 0xf0ff) {
      if (sym) m = SYMBOL[c - 0xf020]
      else m = WINGDINGS[c - 0xf000]
    }
    out += m && m !== ' ' ? m : text[k]
  }
  return out
}
