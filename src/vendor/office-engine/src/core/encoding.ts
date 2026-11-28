/**
 * Text encodings of files that declare none. Old Excel for Vietnamese Windows saves CSV as Windows-1258, which
 * Windows-1252 (the fallback for bytes that are not UTF-8) reads as `NguyêÞn Vãn Ðýìc`.
 */

/** the tone marks (combining grave, acute, tilde, hook above, dot below) */
const TONE = /[\u0300\u0301\u0303\u0309\u0323]/g
/** a tone mark right after a vowel (the base letters Windows-1258 has: a e i o u y â ê ô ă ơ ư) */
const PAIR = /[aeiouyAEIOUY\u00e2\u00ea\u00f4\u00c2\u00ca\u00d4\u0103\u0102\u01a1\u01a0\u01b0\u01af][\u0300\u0301\u0303\u0309\u0323]/g
/**
 * Whether bytes that are not UTF-8 are Windows-1258 (Vietnamese): read as such, the text has tone marks (combining
 * U+0300 / 0301 / 0303 / 0309 / 0323) after vowels, and no more of them after anything else. Other languages' text
 * read this way has none after vowels: Italian ì / ò come after consonants, Portuguese ã / õ and Icelandic ð / þ
 * are single letters.
 */
export function isWindows1258(b: Uint8Array): boolean {
  // only high bytes matter, and a sample tells: the file is read whole where it is small
  const sample = b.length > 1 << 22 ? b.subarray(0, 1 << 22) : b
  let t: string
  try {
    t = new TextDecoder('windows-1258').decode(sample)
  } catch {
    return false
  }
  const pairs = t.match(PAIR)?.length ?? 0
  if (!pairs) return false
  const marks = t.match(TONE)?.length ?? 0
  // marks after something else than a vowel: not Vietnamese
  if (marks - pairs > pairs) return false
  return true
}

/** the label `TextDecoder` knows it by, or null for a label it does not know */
export function knownEncoding(label: string): string | null {
  try {
    return new TextDecoder(label.trim()).encoding
  } catch {
    return null
  }
}

/** Windows-1258 puts a letter and its tone mark apart (a + U+0301): the text is composed */
export const composes = (encoding: string) => encoding === 'windows-1258'
