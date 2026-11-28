import { Fragment, useEffect, useRef, useState } from 'react'
import type { DocumentClient } from '../../core/worker/client'
import { useStrings, type Strings } from '../strings'

const CORE = ['title', 'subject', 'creator', 'keywords', 'description', 'lastModifiedBy', 'created', 'modified'] as const

/** Core properties (docProps/core.xml) that are set. */
async function coreProps(client: DocumentClient, t: Strings): Promise<[string, string][]> {
  const xml = await (await client.call('part', 'docProps/core.xml')).text()
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const out: [string, string][] = []
  for (const tag of CORE) {
    const v = doc.getElementsByTagNameNS('*', tag)[0]?.textContent?.trim()
    if (!v) continue
    const date = tag === 'created' || tag === 'modified' ? new Date(v) : null
    out.push([t.details.core[tag], date && !isNaN(date.getTime()) ? date.toLocaleString(t.locale) : v])
  }
  return out
}

export function DetailsDialog(props: { client: DocumentClient; file: [string, string][]; stats: [string, string][]; onClose: () => void }) {
  const t = useStrings()
  const [core, setCore] = useState<[string, string][]>([])
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeRef.current?.focus()
    let live = true
    coreProps(props.client, t).then(
      (c) => live && setCore(c),
      () => {},
    )
    return () => {
      live = false
    }
  }, [props.client, t])
  const groups = [props.file, core, props.stats].filter((g) => g.length)
  return (
    <div
      className="de-dialog-back"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          props.onClose()
        }
      }}
    >
      <div className="de-dialog" role="dialog" aria-label={t.details.title}>
        <div className="de-dialog-title">{t.details.title}</div>
        <dl className="de-details">
          {groups.map((g, k) => (
            <Fragment key={k}>
              {k > 0 && <div className="de-details-sep" />}
              {g.map(([label, value]) => (
                <Fragment key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </Fragment>
              ))}
            </Fragment>
          ))}
        </dl>
        <div className="de-dialog-btns">
          <button ref={closeRef} type="button" className="de-btn de-btn-primary" onClick={props.onClose}>
            {t.common.close}
          </button>
        </div>
      </div>
    </div>
  )
}
