/**
 * Wire protocol between collaboration clients and a hub (sequencer).
 *
 * The hub is format-agnostic: it assigns a global sequence number to every
 * batch of operations, stores the log and relays presence. All transformation
 * and conflict handling happens in the clients, deterministically, so every
 * client that applies the log ends up with the same document.
 */

export interface UserInfo {
  /** stable user id (optional, for the host app) */
  id?: string
  name: string
  /** CSS color; the hub assigns one when missing */
  color?: string
}

export interface PeerInfo extends UserInfo {
  /** per-room connection id, assigned by the hub */
  site: number
  color: string
  presence?: unknown
}

/** A batch of operations as stored in the hub log. */
export interface Batch<Op = unknown> {
  seq: number
  site: number
  /** last seq the author had applied when creating the batch */
  base: number
  /** client generated id (dedupes resends after reconnects) */
  id: string
  ops: Op[]
  /** when the hub sequenced it (ms since epoch) */
  time?: number
  /** author: user id, else name */
  user?: string
}

/** A batch the way every client applies it: its ops transformed against the concurrent batches sequenced before it. */
export interface Entry<Op = unknown> {
  seq: number
  site: number
  ops: Op[]
}

/**
 * The document materialized at `seq` (see `compact`): a file containing every batch up to `seq`,
 * plus the canonical batches right before it (`ctx`) that clients joining from that file need to
 * merge batches still based on older states.
 */
export interface Snapshot<Op = unknown> {
  seq: number
  ctx: Entry<Op>[]
}

export type ClientMsg =
  /**
   * join a room; `have`/`site` on reconnect. `base`: on the first join, the snapshot the client
   * opened (default 0, the original upload)
   */
  | { t: 'hello'; room: string; user: UserInfo; have?: number; site?: number; base?: number }
  | { t: 'ops'; id: string; base: number; ops: unknown[] }
  | { t: 'presence'; data: unknown }

const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const optCount = (v: unknown): v is number | undefined => v === undefined || count(v)

/**
 * A message as a client may send it, or null: what arrives on a connection is whatever its sender wrote. A hub reads
 * every message through this, so that one that is not of the protocol neither throws in the server nor reaches a room
 * (a batch whose `ops` is not a list would stop every client of the room that applies it).
 */
export function checkClientMsg(raw: unknown): ClientMsg | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (m.t === 'hello') {
    const u = m.user as Record<string, unknown> | null | undefined
    if (typeof m.room !== 'string' || !m.room || m.room.length > 1024 || !u || typeof u !== 'object') return null
    if (!optCount(m.have) || !optCount(m.site) || !optCount(m.base)) return null
    const user: UserInfo = { name: typeof u.name === 'string' ? u.name.slice(0, 200) : '' }
    if (typeof u.id === 'string') user.id = u.id.slice(0, 200)
    if (typeof u.color === 'string') user.color = u.color.slice(0, 64)
    return { t: 'hello', room: m.room, user, ...(m.have !== undefined ? { have: m.have } : {}), ...(m.site !== undefined ? { site: m.site } : {}), ...(m.base !== undefined ? { base: m.base } : {}) }
  }
  if (m.t === 'ops') return typeof m.id === 'string' && m.id && m.id.length <= 200 && count(m.base) && Array.isArray(m.ops) ? { t: 'ops', id: m.id, base: m.base, ops: m.ops } : null
  if (m.t === 'presence') return { t: 'presence', data: m.data }
  return null
}

export type HubMsg =
  /**
   * `log` holds every batch with seq > `from`; `ctx` the joined snapshot's context (first join from a
   * snapshot); `reset` when the hub can't continue from the client's state (history lost or dropped)
   */
  | { t: 'welcome'; site: number; seq: number; from: number; log: Batch[]; peers: PeerInfo[]; reset?: boolean; ctx?: Entry[] }
  | { t: 'batch'; b: Batch }
  | { t: 'presence'; site: number; data: unknown }
  | { t: 'join'; peer: PeerInfo }
  | { t: 'leave'; site: number }
  | { t: 'error'; message: string }

export const PEER_COLORS = ['#1a73e8', '#e8710a', '#188038', '#d93025', '#9334e6', '#c5221f', '#007b83', '#b06000', '#3f51b5', '#e52592']
