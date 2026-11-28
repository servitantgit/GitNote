import { decodeXml } from './xml'
import { notOffice, PASSWORD_MESSAGE } from './filetype'
import type { ByteSource } from './source'
import { crc32 } from './zipwrite'

export interface ZipEntry {
  name: string
  method: number
  flags: number
  crc: number
  time: number
  date: number
  compSize: number
  size: number
  localOffset: number
  dataOffset?: number
}

const SIG_EOCD = 0x06054b50
const SIG_Z64_LOC = 0x07064b50
const SIG_Z64_EOCD = 0x06064b50
const SIG_CEN = 0x02014b50
const SIG_LOC = 0x04034b50

const u64 = (dv: DataView, o: number) => Number(dv.getBigUint64(o, true))

/**
 * What a package may ask of the reader. The sizes in a ZIP are whatever its author wrote: a file of a few kilobytes
 * can announce (or unpack to) gigabytes, and name the same part twice. Past these limits the file is refused with
 * an error instead of the memory being asked for. They are far above what documents hold (an object, so that the
 * tests can lower them).
 */
export const ZIP_LIMITS = {
  /** entries of the central directory */
  entries: 200_000,
  /** bytes of the central directory */
  directory: 256 * 1024 * 1024,
  /** bytes of a part read whole into memory (`bytes`, `text`): XML parsed as one text, pictures */
  whole: 1024 * 1024 * 1024,
  /** bytes of a part read as a stream (`stream`): sheet data, a document's body */
  stream: 16 * 1024 * 1024 * 1024,
}

/** deflate can't pack more than about 1032 to 1: a part announced larger than that for its packed size is not believed */
const MAX_RATIO = 1032

class LimitError extends Error {}

const tooLarge = (name: string, limit: number) => new LimitError(`${name} is too large to open (over ${Math.round(limit / (1024 * 1024))} MB unpacked)`)

/** `stream`, failing once more than `limit` bytes came through */
function capped(stream: ReadableStream<Uint8Array>, limit: number, name: string): ReadableStream<Uint8Array> {
  let total = 0
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        total += chunk.length
        if (total > limit) ctrl.error(tooLarge(name, limit))
        else ctrl.enqueue(chunk)
      },
    }),
  )
}

/** a part is checked against its checksum while it is read, when it is no larger than this (the check costs time) */
const CRC_MAX = 64 * 1024 * 1024

/**
 * `inflated` (the unpacked bytes of an entry) with a failure told in words a user can read: zlib's own errors
 * ("inflate failed", "unexpected end of file", "Trailing junk…") say nothing, and a part that does not match its
 * checksum is damaged. A failure of the byte source itself (`raw`) is passed on as it is.
 */
function guarded(inflated: ReadableStream<Uint8Array>, e: ZipEntry, source: { err?: unknown }): ReadableStream<Uint8Array> {
  const reader = inflated.getReader()
  // (a writer that leaves the checksum 0 gives nothing to check against)
  const check = e.size <= CRC_MAX && e.crc !== 0
  let crc = 0
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          if (check && crc !== e.crc) throw new Error('crc')
          ctrl.close()
          return
        }
        if (check) crc = crc32(value, crc)
        ctrl.enqueue(value)
      } catch (err) {
        ctrl.error(source.err ?? (err instanceof LimitError ? err : new Error(`The file is damaged: the part “${e.name}” does not unpack correctly (an incomplete download or copy?)`)))
      }
    },
    cancel: (reason) => reader.cancel(reason),
  })
}

/** `raw`, remembering how it failed */
function tracked(raw: ReadableStream<Uint8Array>, source: { err?: unknown }): ReadableStream<Uint8Array> {
  const reader = raw.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const { done, value } = await reader.read()
        if (done) ctrl.close()
        else ctrl.enqueue(value)
      } catch (err) {
        source.err = err
        ctrl.error(err)
      }
    },
    cancel: (reason) => reader.cancel(reason),
  })
}

/**
 * Lazy ZIP reader: parses only the central directory, then inflates single
 * entries on demand straight from the byte source (native DecompressionStream).
 */
export class ZipArchive {
  private entries = new Map<string, ZipEntry>()

  private constructor(readonly src: ByteSource) {}

  static async open(src: ByteSource): Promise<ZipArchive> {
    const zip = new ZipArchive(src)
    await zip.readDirectory()
    return zip
  }

  private async readDirectory() {
    const { src } = this
    if (src.size < 22) throw new Error(notOffice(await src.read(0, src.size), src.size))
    const tailLen = Math.min(src.size, 22 + 0xffff + 20)
    const tailStart = src.size - tailLen
    const tail = await src.read(tailStart, tailLen)
    const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === SIG_EOCD) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new Error(notOffice(await src.read(0, 4096), src.size))
    let count = dv.getUint16(eocd + 10, true)
    let cdSize = dv.getUint32(eocd + 12, true)
    let cdOffset = dv.getUint32(eocd + 16, true)

    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20
      if (loc >= 0 && dv.getUint32(loc, true) === SIG_Z64_LOC) {
        const z64Off = u64(dv, loc + 8)
        if (z64Off + 56 > src.size) throw new Error('The file is damaged: its ZIP64 record is outside the file')
        const rec = await src.read(z64Off, 56)
        const rdv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength)
        if (rdv.getUint32(0, true) === SIG_Z64_EOCD) {
          count = u64(rdv, 32)
          cdSize = u64(rdv, 40)
          cdOffset = u64(rdv, 48)
        }
      }
    }

    // the directory is read whole: it lies inside the file, and is not larger than a directory gets
    if (cdOffset + cdSize > src.size) throw new Error('The file is damaged: its list of parts is outside the file (an incomplete download or copy?)')
    if (cdSize > ZIP_LIMITS.directory || count > ZIP_LIMITS.entries) throw new Error(`Too many files in the package (over ${ZIP_LIMITS.entries})`)
    const cd = await src.read(cdOffset, cdSize)
    const cdv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength)
    const utf8 = new TextDecoder()
    let p = 0
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cdv.getUint32(p, true) !== SIG_CEN) break
      const flags = cdv.getUint16(p + 8, true)
      const method = cdv.getUint16(p + 10, true)
      const time = cdv.getUint16(p + 12, true)
      const date = cdv.getUint16(p + 14, true)
      const crc = cdv.getUint32(p + 16, true)
      let compSize = cdv.getUint32(p + 20, true)
      let size = cdv.getUint32(p + 24, true)
      const nameLen = cdv.getUint16(p + 28, true)
      const extraLen = cdv.getUint16(p + 30, true)
      const commentLen = cdv.getUint16(p + 32, true)
      let localOffset = cdv.getUint32(p + 42, true)
      const name = utf8.decode(cd.subarray(p + 46, p + 46 + nameLen))
      if (size === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
        let e = p + 46 + nameLen
        const eEnd = e + extraLen
        while (e + 4 <= eEnd) {
          const id = cdv.getUint16(e, true)
          const len = cdv.getUint16(e + 2, true)
          if (id === 0x0001) {
            let q = e + 4
            if (size === 0xffffffff) (size = u64(cdv, q)), (q += 8)
            if (compSize === 0xffffffff) (compSize = u64(cdv, q)), (q += 8)
            if (localOffset === 0xffffffff) localOffset = u64(cdv, q)
            break
          }
          e += 4 + len
        }
      }
      if (!name.endsWith('/')) {
        const key = normalize(name)
        // one part per name (names differing by case are the same part): with two, which one is shown and which one
        // another reader (a scanner, Office) sees would differ
        if (this.entries.has(key)) throw new Error(`The file is damaged: it holds two files named ${name}`)
        if (this.entries.size >= ZIP_LIMITS.entries) throw new Error(`Too many files in the package (over ${ZIP_LIMITS.entries})`)
        this.entries.set(key, { name, method, flags, crc, time, date, compSize, size, localOffset })
      }
      p += 46 + nameLen + extraLen + commentLen
    }
  }

  list(): ZipEntry[] {
    return [...this.entries.values()]
  }

  get(path: string): ZipEntry | undefined {
    return this.entries.get(normalize(path))
  }

  has(path: string): boolean {
    return this.entries.has(normalize(path))
  }

  private async dataOffset(e: ZipEntry): Promise<number> {
    if (e.dataOffset !== undefined) return e.dataOffset
    if (e.localOffset + 30 > this.src.size) throw new Error(`The file is damaged: the part “${e.name}” cannot be found where the file says it is`)
    const h = await this.src.read(e.localOffset, 30)
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength)
    if (h.length < 30 || dv.getUint32(0, true) !== SIG_LOC) throw new Error(`The file is damaged: the part “${e.name}” cannot be found where the file says it is`)
    const off = e.localOffset + 30 + dv.getUint16(26, true) + dv.getUint16(28, true)
    if (off + e.compSize > this.src.size) throw new Error(`The file is damaged: the part “${e.name}” runs past the end of the file (an incomplete download or copy?)`)
    e.dataOffset = off
    return off
  }

  /** Compressed bytes of an entry, as stored (zero-copy Blob slice when the source allows). */
  async rawData(e: ZipEntry): Promise<Blob | Uint8Array> {
    const off = await this.dataOffset(e)
    return this.src.slice ? this.src.slice(off, e.compSize) : this.src.read(off, e.compSize)
  }

  /**
   * Decompressed stream of an entry. `onRaw` reports compressed bytes consumed. The stream fails past `limit`
   * unpacked bytes (default `ZIP_LIMITS.stream`), whatever size the entry announces.
   */
  async stream(path: string, onRaw?: (consumed: number, total: number) => void, limit = ZIP_LIMITS.stream): Promise<ReadableStream<Uint8Array>> {
    const e = this.get(path)
    if (!e) throw new Error(`Missing part: ${path}`)
    if (e.flags & 1) throw new Error(PASSWORD_MESSAGE)
    if (e.size > limit) throw tooLarge(e.name, limit)
    const off = await this.dataOffset(e)
    let raw = this.src.stream(off, e.compSize)
    if (onRaw) {
      let consumed = 0
      const total = e.compSize
      raw = raw.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, ctrl) {
            consumed += chunk.length
            onRaw(consumed, total)
            ctrl.enqueue(chunk)
          },
        }),
      )
    }
    // stored: as long as its bytes in the file; deflated: counted as it unpacks
    const source: { err?: unknown } = {}
    if (e.method === 0) {
      const stored = guarded(tracked(raw, source), e, source)
      return e.compSize > limit ? capped(stored, limit, e.name) : stored
    }
    if (e.method === 8) {
      const inflated = tracked(raw, source).pipeThrough(new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>)
      return capped(guarded(inflated, e, source), limit, e.name)
    }
    throw new Error(`Unsupported ZIP compression method ${e.method} for ${e.name}`)
  }

  /** An entry unpacked whole into memory: at most `ZIP_LIMITS.whole` bytes. */
  async bytes(path: string): Promise<Uint8Array> {
    const e = this.get(path)
    if (!e) throw new Error(`Missing part: ${path}`)
    const reader = (await this.stream(path, undefined, ZIP_LIMITS.whole)).getReader()
    // the announced size saves a copy, when it can be true for the packed size; else the bytes are gathered as they come
    const out = new Uint8Array(e.size <= e.compSize * MAX_RATIO + 65536 ? e.size : 0)
    /** bytes read, and how many of them are in `out` (the rest, past the announced size, in `extra`) */
    let pos = 0
    let filled = 0
    const extra: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!extra.length && filled + value.length <= out.length) {
        out.set(value, filled)
        filled += value.length
      } else extra.push(value)
      pos += value.length
    }
    if (!extra.length) return filled === out.length ? out : out.subarray(0, filled)
    // Size in directory was wrong: rebuild.
    const all = new Uint8Array(pos)
    all.set(out.subarray(0, filled))
    let q = filled
    for (const x of extra) all.set(x, q), (q += x.length)
    return all
  }

  async text(path: string): Promise<string> {
    return decodeXml(await this.bytes(path))
  }
}

export function normalize(path: string): string {
  return path.replace(/^\/+/, '').replace(/\\/g, '/').toLowerCase()
}
