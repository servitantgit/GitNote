/**
 * The host's fonts (DocViewer's `fonts`): FontFace objects in the page's font set while a viewer declares them,
 * shared by the viewers that declare the same file. The views ask for the ones their text names and wait for them
 * before measuring (DOCX), or measure again once they are there (XLSX).
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { cssUrl, faceDescriptors, faceFamily, familyKey, fontFamilies, fontsFor, type FontSource } from '../../core/fonts'
import { useForceUpdate, useLatest } from './hooks'

/** `timeout`: how long a view waits for a font before it lays the text out without it (a browser's own block period) */
export const FONT_LIMITS = { timeout: 3000 }

type State = 'idle' | 'loading' | 'loaded' | 'error' | 'timeout'

/** one declared font file, shared by every viewer on the page that declares it */
export interface HostFace {
  key: string
  src: FontSource
  users: number
  state: State
  face?: FontFace
  /** what the FontFace was made from: the CSS url() or the bytes (a print frame makes its own) */
  data?: string | BufferSource
  error?: Error
}

const faces = new Map<string, HostFace>()
const listeners = new Set<(f: HostFace, removed: boolean) => void>()
const emit = (f: HostFace, removed = false) => {
  for (const l of [...listeners]) l(f, removed)
}

/** the declaration (`fontKey`) each FontFace made for the host's fonts is for */
const hostFaces = new WeakMap<FontFace, string>()

const fontSet = (): FontFaceSet | undefined => (typeof document !== 'undefined' && typeof FontFace !== 'undefined' ? document.fonts : undefined)

const bytesIds = new WeakMap<object, number>()
let nextBytes = 0

/** what tells two declarations of a face apart: family, descriptors and file (its URL, or the bytes object itself) */
export function fontKey(f: FontSource): string {
  const d = faceDescriptors(f)
  let file: string
  if (typeof f.src === 'string') file = 'u:' + f.src
  else {
    let id = bytesIds.get(f.src)
    if (id === undefined) bytesIds.set(f.src, (id = ++nextBytes))
    file = 'b:' + id
  }
  return [familyKey(f.family), d.weight ?? '', d.style ?? '', d.unicodeRange ?? '', file].join('|')
}

const describe = (f: HostFace) => `"${f.src.family}"${typeof f.src.src === 'string' ? ` (${f.src.src})` : ''}`

function fail(f: HostFace, e: unknown) {
  if (f.state === 'error') return
  f.state = 'error'
  const why = e instanceof Error && e.message ? `: ${e.message}` : ''
  f.error = new Error(`Font ${describe(f)} could not be loaded${why}`)
  console.warn(`[office-engine] ${f.error.message}; text in it is shown in the next font of its list`)
  emit(f)
}

/** the FontFace, in the page's font set: from then on the browser also fetches it itself when text in it is shown */
function attach(f: HostFace, data: string | ArrayBuffer | ArrayBufferView) {
  // (a view over a SharedArrayBuffer is refused by FontFace itself, as a failed font)
  const set = fontSet()
  if (!set) return
  try {
    f.data = typeof data === 'string' ? cssUrl(new URL(data, document.baseURI).href) : (data as BufferSource)
    f.face = new FontFace(faceFamily(f.src.family), f.data, faceDescriptors(f.src))
    hostFaces.set(f.face, f.key)
    set.add(f.face)
  } catch (e) {
    f.face = undefined
    fail(f, e)
  }
}

/** the face of a declaration, held by one more viewer: the first one adds it to the page's font set */
export function acquireFont(src: FontSource): HostFace {
  const key = fontKey(src)
  let f = faces.get(key)
  if (!f) faces.set(key, (f = { key, src, users: 0, state: 'idle' }))
  // a Blob's bytes are read when the font is first needed
  if (f.users++ === 0 && !f.face && !(typeof Blob !== 'undefined' && src.src instanceof Blob)) attach(f, src.src as string | ArrayBuffer | ArrayBufferView)
  emit(f)
  return f
}

/** a viewer lets the face go: it leaves the page's font set when no viewer holds it */
export function releaseFont(f: HostFace) {
  f.users--
  // later: a viewer that declares it again at once (an effect run again) keeps the same face, not a second download
  queueMicrotask(() => {
    if (f.users > 0 || faces.get(f.key) !== f) return
    faces.delete(f.key)
    if (f.face) fontSet()?.delete(f.face)
    emit(f, true)
  })
}

/** starts loading a face once; it settles as loaded, failed, or timed out (and may still arrive later) */
export function loadFont(f: HostFace) {
  if (f.state !== 'idle' || !fontSet()) return
  f.state = 'loading'
  const timer = setTimeout(() => {
    if (f.state !== 'loading') return
    f.state = 'timeout'
    console.warn(`[office-engine] font ${describe(f)} is still loading after ${FONT_LIMITS.timeout / 1000} s: the text is laid out without it, and again once it arrives`)
    emit(f)
  }, FONT_LIMITS.timeout)
  const src = f.src.src
  const made = f.face
    ? Promise.resolve(f.face)
    : src instanceof Blob
      ? src.arrayBuffer().then((bytes) => {
          attach(f, bytes)
          if (!f.face) throw f.error
          return f.face
        })
      : Promise.reject(new Error('not a font file'))
  made
    .then((face) => face.load())
    .then(
      () => {
        clearTimeout(timer)
        f.state = 'loaded'
        emit(f)
      },
      (e) => {
        clearTimeout(timer)
        fail(f, e)
      },
    )
}

const NONE: readonly FontSource[] = []

/** the fonts the host declared, for the views inside a viewer */
export const FontsContext = createContext<readonly FontSource[]>(NONE)

/**
 * The host's fonts while the viewer is shown: in the page's font set (nothing is fetched until text needs one),
 * released when no viewer declares them any more. A font that cannot be loaded is reported to `onError`.
 */
export function useHostFonts(fonts: readonly FontSource[] | undefined, onError?: (error: Error) => void): readonly FontSource[] {
  const given = fonts ?? NONE
  const valid = given.filter((f) => !!f && typeof f.family === 'string' && !!f.family.trim() && (typeof f.src === 'string' || (typeof f.src === 'object' && f.src !== null)))
  // the same fonts in a new array (a host's inline list) are not another declaration
  const key = valid.map(fontKey).join('\n')
  const list = useMemo(() => {
    if (valid.length < given.length) console.warn('[office-engine] a font without a family name or a src is ignored')
    return valid.length ? valid : NONE
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, valid.length < given.length])
  const errorTo = useLatest(onError)
  useEffect(() => {
    if (!list.length) return
    const held = new Set(list.map(acquireFont))
    const told = new Set<HostFace>()
    const tell = (f: HostFace) => {
      if (f.state !== 'error' || !held.has(f) || told.has(f)) return
      told.add(f)
      errorTo.current?.(f.error!)
    }
    held.forEach(tell)
    const off = onFonts(tell)
    return () => {
      off()
      held.forEach(releaseFont)
    }
  }, [list, errorTo])
  return list
}

/** called when a face is held, settles or is let go */
export function onFonts(fn: (f: HostFace, removed: boolean) => void) {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

export interface DocFonts {
  /**
   * Whether text in these CSS font stacks can be measured: the host's fonts they name have loaded, failed or timed
   * out. Starts loading the ones that have not; the view renders again when they settle.
   */
  ready(stacks: Iterable<string>): boolean
  /**
   * Grows when a font arrives that text measured before was laid out without: one that timed out, one the page
   * loads through CSS, a host font taken away. What was measured is measured again.
   */
  gen: number
}

/** the fonts of one view's document: what it waits for, and when it measures again */
export function useDocFonts(): DocFonts {
  const declared = useContext(FontsContext)
  const [, rerender] = useForceUpdate()
  const [gen, setGen] = useState(0)
  /**
   * `watch`: the families its text is set in; `late`: faces it declared and measured text without; `seen`: faces it
   * did not declare (the page's own @font-face, another viewer's) that arrived; `mine`: what it declared
   */
  const ref = useRef<{ watch: Set<string>; late: WeakSet<FontFace>; seen: WeakSet<FontFace>; mine: Set<string> } | null>(null)
  const st = (ref.current ??= { watch: new Set(), late: new WeakSet(), seen: new WeakSet(), mine: new Set() })
  st.mine = useMemo(() => new Set(declared.map(fontKey)), [declared])
  useEffect(() => {
    const set = fontSet()
    const { watch, late, seen } = st
    const again = () => setGen((g) => g + 1)
    // the browser loaded a font this view did not ask for that text here is set in (the browser fetches such a font
    // when text first needs it): that text was laid out while it was missing
    const done = (e: Event) => {
      let hit = false
      for (const face of (e as FontFaceSetLoadEvent).fontfaces ?? []) {
        const key = hostFaces.get(face)
        if ((key && st.mine.has(key)) || seen.has(face) || !watch.has(familyKey(face.family))) continue
        seen.add(face)
        hit = true
      }
      if (hit) again()
    }
    set?.addEventListener('loadingdone', done)
    const off = onFonts((f, removed) => {
      // a host font that arrived after text was measured without it, or one taken away from text laid out with it
      if (f.face && !removed && f.state === 'loaded' && late.has(f.face)) {
        late.delete(f.face)
        again()
      } else if (removed && f.state === 'loaded' && watch.has(familyKey(f.src.family))) again()
      else rerender()
    })
    return () => {
      set?.removeEventListener('loadingdone', done)
      off()
    }
  }, [st, rerender])
  return {
    gen,
    ready(stacks) {
      const list = [...stacks]
      for (const s of list) for (const fam of fontFamilies(s)) st.watch.add(fam)
      if (!declared.length || !fontSet()) return true
      let ok = true
      for (const d of fontsFor(declared, list)) {
        const f = faces.get(fontKey(d))
        // declared a moment ago: the viewer holds it after this render, and that renders again
        if (!f) {
          ok = false
          continue
        }
        loadFont(f)
        if (f.state === 'idle' || f.state === 'loading') ok = false
        // what is measured now is measured without it: when it arrives, it is measured again
        else if (f.state === 'timeout' && f.face) st.late.add(f.face)
      }
      return ok
    },
  }
}

/**
 * The host's fonts the page has loaded, in another document too (the print frame): its text breaks as the page's
 * does. They start loading; the document's `fonts.ready` tells when they are there.
 */
export function copyFonts(doc: Document) {
  const W = doc.defaultView as (Window & typeof globalThis) | null
  if (!W?.FontFace || !doc.fonts) return
  for (const f of faces.values()) {
    if (f.state !== 'loaded' || f.data === undefined) continue
    try {
      const face = new W.FontFace(faceFamily(f.src.family), f.data, faceDescriptors(f.src))
      doc.fonts.add(face)
      face.load().catch(() => {})
    } catch {
      // as on the page: the text is shown in the next font of its list
    }
  }
}
