import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { initialsOf, type CommentUser, type DocComment } from '../../core/comments'
import { PEER_COLORS } from '../../collab/protocol'
import { ContextMenu, MOD, type MenuItem } from '../common/ContextMenu'
import { ConfirmDialog } from '../common/Dialog'
import { Icon } from '../edit/Toolbar'
import { useCommentsState, type CommentsCtl, type PlacedThread } from './Comments'
import { useStrings, type Strings } from '../strings'

const ALT = MOD === '⌘' ? '⌥' : 'Alt+'
/** shortcut that starts a comment on the selection */
export const COMMENT_KEYS = `${MOD}${ALT}M`

function colorOf(u: CommentUser): string {
  const key = u.id ?? u.name
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return PEER_COLORS[h % PEER_COLORS.length]
}

function ago(iso: string, now: number, str: Strings): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, (now - t) / 1000)
  if (s < 45) return str.comments.justNow
  if (s < 3600) return str.comments.minutesAgo(Math.round(s / 60))
  if (s < 86400) return str.comments.hoursAgo(Math.round(s / 3600))
  if (s < 7 * 86400) return str.comments.daysAgo(Math.round(s / 86400))
  const d = new Date(t)
  return d.toLocaleDateString(str.locale, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) })
}

/** comment text with its mentions set apart */
function Text({ c }: { c: DocComment }) {
  const names = (c.mentions ?? []).map((m) => '@' + m.name).sort((a, b) => b.length - a.length)
  if (!names.length) return <div className="de-cm-text">{c.text}</div>
  const out: ReactNode[] = []
  let rest = c.text
  for (let k = 0; rest; k++) {
    let at = -1
    let name = ''
    for (const n of names) {
      const i = rest.indexOf(n)
      if (i >= 0 && (at < 0 || i < at)) {
        at = i
        name = n
      }
    }
    if (at < 0) {
      out.push(rest)
      break
    }
    if (at > 0) out.push(rest.slice(0, at))
    out.push(
      <span key={k} className="de-cm-at">
        {name}
      </span>,
    )
    rest = rest.slice(at + name.length)
  }
  return <div className="de-cm-text">{out}</div>
}

function Avatar({ u }: { u: CommentUser }) {
  return (
    <span className="de-cm-ava" style={{ background: colorOf(u) }} aria-hidden>
      {(u.initials || initialsOf(u.name)).slice(0, 2)}
    </span>
  )
}

/** text box for comments: Enter posts (Shift+Enter: new line), "@" suggests people */
export function Composer(props: {
  ctl: CommentsCtl
  placeholder: string
  submit: string
  initial?: string
  mentions?: CommentUser[]
  autoFocus?: boolean
  onSubmit: (text: string, mentions: CommentUser[]) => Promise<boolean>
  onCancel?: () => void
}) {
  const { ctl } = props
  const str = useStrings()
  const [text, setText] = useState(props.initial ?? '')
  const [mentions, setMentions] = useState<CommentUser[]>(props.mentions ?? [])
  const [pop, setPop] = useState<{ at: number; end: number; list: CommentUser[]; hi: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const query = useRef(0)
  /** caret to put back once a picked mention is in the text (before anything typed next lands) */
  const caretNext = useRef<number | null>(null)
  const canMention = !!ctl.opts.mentions

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
    if (caretNext.current !== null) {
      el.focus()
      el.setSelectionRange(caretNext.current, caretNext.current)
      caretNext.current = null
    }
  }, [text])
  useEffect(() => {
    if (!props.autoFocus) return
    const el = ref.current
    el?.focus({ preventScroll: true })
    el?.setSelectionRange(el.value.length, el.value.length)
  }, [props.autoFocus])

  const lookup = (value: string, caret: number) => {
    if (!canMention) return
    const m = /(^|[\s(])@([^\s@]{0,30}(?: [^\s@]{0,30})?)$/.exec(value.slice(0, caret))
    if (!m) return setPop(null)
    const at = caret - m[2].length - 1
    const n = ++query.current
    void ctl.people(m[2]).then((list) => {
      if (n !== query.current) return
      if (!list.length && m[2].includes(' ')) return setPop(null)
      setPop({ at, end: caret, list, hi: 0 })
    })
  }
  const pick = (u: CommentUser) => {
    if (!pop) return
    const ins = `@${u.name} `
    const next = text.slice(0, pop.at) + ins + text.slice(pop.end)
    setText(next)
    setMentions((ms) => (ms.some((m) => (m.id ?? m.name) === (u.id ?? u.name)) ? ms : [...ms, u]))
    setPop(null)
    query.current++
    caretNext.current = pop.at + ins.length
  }
  const send = async () => {
    if (busy || !text.trim()) return
    setBusy(true)
    const used = mentions.filter((m) => text.includes('@' + m.name))
    const ok = await props.onSubmit(text, used)
    setBusy(false)
    if (ok) {
      setText('')
      setMentions([])
    }
  }
  return (
    <div className="de-cm-compose" onClick={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        disabled={busy}
        onChange={(e) => {
          setText(e.target.value)
          lookup(e.target.value, e.target.selectionStart)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.nativeEvent.isComposing) return
          if (pop?.list.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              const d = e.key === 'ArrowDown' ? 1 : -1
              setPop({ ...pop, hi: (pop.hi + d + pop.list.length) % pop.list.length })
              return
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              pick(pop.list[pop.hi])
              return
            }
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            if (pop) setPop(null)
            else props.onCancel?.()
            return
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void send()
          }
        }}
        onBlur={() => setTimeout(() => setPop(null), 150)}
      />
      {pop && pop.list.length > 0 && (
        <div className="de-cm-pop" role="listbox">
          {pop.list.map((u, i) => (
            <button
              key={u.id ?? u.name}
              type="button"
              role="option"
              aria-selected={i === pop.hi}
              className={i === pop.hi ? 'on' : undefined}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(u)
              }}
            >
              <Avatar u={u} />
              <span>{u.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="de-cm-actions">
        {canMention && <span className="de-cm-tip">{str.comments.mentionTip}</span>}
        {props.onCancel && (
          <button type="button" className="de-btn" onClick={props.onCancel}>
            {str.common.cancel}
          </button>
        )}
        <button type="button" className="de-btn de-btn-primary" disabled={busy || !text.trim()} onClick={() => void send()}>
          {props.submit}
        </button>
      </div>
    </div>
  )
}

function Item({ ctl, c, root, now, onMenu }: { ctl: CommentsCtl; c: DocComment; root?: boolean; now: number; onMenu: (c: DocComment, el: HTMLElement) => void }) {
  const [editing, setEditing] = useState(false)
  const str = useStrings()
  const mine = ctl.isMine(c)
  const can = ctl.canComment
  return (
    <div className="de-cm-item" data-comment={c.id}>
      <div className="de-cm-head">
        <Avatar u={c.author} />
        <div className="de-cm-who">
          <span className="de-cm-name">{c.author.name}</span>
          <time className="de-cm-time" dateTime={c.time} title={c.time ? new Date(c.time).toLocaleString(str.locale) : undefined}>
            {ago(c.time, now, str)}
          </time>
        </div>
        {root && can && (
          <button
            type="button"
            className="de-tb de-cm-icon"
            title={c.done ? str.comments.reopen : str.comments.resolve}
            aria-label={c.done ? str.comments.reopenThread : str.comments.resolveThread}
            onClick={(e) => {
              e.stopPropagation()
              void ctl.resolve(c.id, !c.done)
            }}
          >
            <Icon name={c.done ? 'rotateCcw' : 'check'} size={16} />
          </button>
        )}
        {can && mine && (
          <button
            type="button"
            className="de-tb de-cm-icon"
            title={str.comments.more}
            aria-label={str.comments.moreActions}
            aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation()
              onMenu(c, e.currentTarget)
            }}
          >
            <Icon name="more" size={16} />
          </button>
        )}
      </div>
      {editing ? (
        <Composer
          ctl={ctl}
          placeholder={str.comments.editPlaceholder}
          submit={str.common.save}
          initial={c.text}
          mentions={c.mentions}
          autoFocus
          onSubmit={async (t, m) => {
            const ok = await ctl.edit(c.id, t, m)
            if (ok) setEditing(false)
            return ok
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <Text c={c} />
      )}
      <EditHook id={c.id} start={() => setEditing(true)} />
    </div>
  )
}

/** lets the "⋯" menu (outside the item) start editing an item */
const editors = new Map<string, () => void>()
function EditHook({ id, start }: { id: string; start: () => void }) {
  useEffect(() => {
    editors.set(id, start)
    return () => {
      if (editors.get(id) === start) editors.delete(id)
    }
  }, [id, start])
  return null
}

function Thread({ ctl, t, active, now, onMenu }: { ctl: CommentsCtl; t: PlacedThread; active: boolean; now: number; onMenu: (c: DocComment, el: HTMLElement) => void }) {
  const { root, replies } = t
  const hidden = replies.length > 2 ? replies.length - 1 : 0
  const str = useStrings()
  return (
    <div
      className={'de-cm-card' + (active ? ' on' : '') + (root.done ? ' done' : '')}
      data-thread={root.id}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={() => ctl.select(root.id)}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          ctl.select(root.id)
        }
      }}
    >
      {t.quote && <div className="de-cm-quote">{t.quote}</div>}
      {root.done && <div className="de-cm-resolved">{str.comments.resolved}</div>}
      <Item ctl={ctl} c={root} root now={now} onMenu={onMenu} />
      {/* a long thread not being read shows its last reply */}
      {!active && hidden > 0 && <div className="de-cm-count">{str.comments.moreReplies(hidden)}</div>}
      {replies.slice(active ? 0 : hidden).map((r) => (
        <Item key={r.id} ctl={ctl} c={r} now={now} onMenu={onMenu} />
      ))}
      {active && ctl.canComment && <Composer ctl={ctl} placeholder={root.done ? str.comments.replyReopen : str.comments.replyPlaceholder} submit={str.comments.reply} onSubmit={(text, m) => ctl.reply(root.id, text, m)} />}
    </div>
  )
}

export function CommentsPanel({ ctl }: { ctl: CommentsCtl }) {
  const st = useCommentsState(ctl)
  const str = useStrings()
  const [menu, setMenu] = useState<{ c: DocComment; x: number; y: number } | null>(null)
  const [confirm, setConfirm] = useState<DocComment | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  const all = ctl.threads()
  const shown = st.showResolved ? all : all.filter((t) => !t.root.done)
  const open = all.filter((t) => !t.root.done).length
  const resolved = all.length - open
  // the current thread's card comes into view (a click in the document picks it)
  useEffect(() => {
    if (!st.active) return
    listRef.current?.querySelector(`[data-thread="${CSS.escape(st.active)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [st.active])
  const onMenu = (c: DocComment, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    setMenu({ c, x: r.left, y: r.bottom + 4 })
  }
  const menuItems = (c: DocComment): MenuItem[] => [
    { label: str.common.edit, icon: 'edit', run: () => editors.get(c.id)?.() },
    { label: c.parent ? str.common.delete : str.comments.deleteThread, icon: 'trash', run: () => setConfirm(c) },
  ]
  return (
    <aside className="de-cm-panel" aria-label={str.comments.panel} onKeyDown={(e) => e.key === 'Escape' && st.draft && ctl.cancelDraft()}>
      <div className="de-cm-bar">
        <span className="de-cm-title">
          {str.comments.panel}
          {open > 0 && <span className="de-cm-badge">{open}</span>}
        </span>
        {resolved > 0 && (
          <button type="button" className={'de-btn de-cm-filter' + (st.showResolved ? ' on' : '')} aria-pressed={st.showResolved} onClick={() => ctl.setShowResolved(!st.showResolved)}>
            {st.showResolved ? str.comments.hideResolved : str.comments.showResolved(resolved)}
          </button>
        )}
        <button type="button" className="de-tb" title={str.comments.close} aria-label={str.comments.close} onClick={() => ctl.toggle(false)}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="de-cm-list" ref={listRef}>
        {ctl.canComment && !st.draft && (
          <button type="button" className="de-cm-new" onClick={() => ctl.start()} title={str.comments.newTitle(COMMENT_KEYS)}>
            <Icon name="commentAdd" size={16} />
            {str.comments.new}
            <span className="de-cm-keys">{COMMENT_KEYS}</span>
          </button>
        )}
        {st.notice && (
          <div className="de-cm-notice" role="status">
            <span>{st.notice}</span>
            <button type="button" className="de-tb" aria-label={str.comments.dismiss} onClick={() => ctl.dismiss()}>
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        {st.draft && (
          <div className="de-cm-card on de-cm-draft">
            {st.draft.quote && <div className="de-cm-quote">{st.draft.quote}</div>}
            <div className="de-cm-head">
              <Avatar u={ctl.me} />
              <div className="de-cm-who">
                <span className="de-cm-name">{ctl.me.name}</span>
              </div>
            </div>
            <Composer ctl={ctl} placeholder={str.comments.newPlaceholder} submit={str.comments.post} autoFocus onSubmit={(t, m) => ctl.post(t, m)} onCancel={() => ctl.cancelDraft()} />
          </div>
        )}
        {shown.map((t) => (
          <Thread key={t.root.id} ctl={ctl} t={t} active={st.active === t.root.id} now={now} onMenu={onMenu} />
        ))}
        {!shown.length && !st.draft && (
          <div className="de-cm-empty">
            {all.length ? str.comments.allResolved : ctl.canComment ? str.comments.noneYet(ctl.host?.hint() ?? '') : str.comments.none}
          </div>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.c)} onClose={() => setMenu(null)} />}
      {confirm && (
        <ConfirmDialog
          title={confirm.parent ? str.comments.deleteCommentTitle : str.comments.deleteThreadTitle}
          message={confirm.parent ? str.comments.deleteCommentText : str.comments.deleteThreadText}
          ok={str.common.delete}
          onOk={() => void ctl.remove(confirm.id)}
          onClose={() => setConfirm(null)}
        />
      )}
    </aside>
  )
}
