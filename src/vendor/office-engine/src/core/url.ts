/** Link schemes a document may open; any other (javascript:, data:, vbscript:, file:…) is shown as plain text. */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'sms', 'ftp', 'ftps'])

/**
 * A document's link target, or undefined when following it could run code: web, mail, phone and FTP links, and
 * relative or in-document (`#bookmark`) targets are kept. The scheme is read the way a browser reads it.
 */
export function safeHref(href: string | null | undefined): string | undefined {
  if (!href) return undefined
  // A target read from HTML by a reader that knows the XML entities only may still hold others ("javascript&colon;…",
  // "&NewLine;javascript:…"), which whatever reads the link next (a Markdown renderer) turns into their characters.
  const plain = href.replace(/&(colon|newline|tab|#x[0-9a-f]+|#\d+);?/gi, (m, e: string) => {
    const k = e.toLowerCase()
    if (k === 'colon') return ':'
    if (k === 'newline') return '\n'
    if (k === 'tab') return '\t'
    const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
  })
  // browsers drop leading / trailing controls and spaces, and tabs / newlines anywhere: "java\tscript:" is a script link
  const url = plain.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1].toLowerCase()
  return !scheme || SAFE_SCHEMES.has(scheme) ? href : undefined
}
