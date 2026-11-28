import { Icon } from '../edit/Toolbar'
import { formatNumber, useStrings } from '../strings'

export type Zoom = number | 'fit'

const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

/** the zoom step after `effective` in direction `dir`, or undefined at the end of the range */
export function stepZoom(effective: number, dir: 1 | -1): number | undefined {
  return dir > 0 ? STEPS.find((s) => s > effective + 0.001) : [...STEPS].reverse().find((s) => s < effective - 0.001)
}

export function ZoomControl({ zoom, effective, onChange }: { zoom: Zoom; effective: number; onChange: (z: Zoom) => void }) {
  const step = (dir: 1 | -1) => {
    const next = stepZoom(effective, dir)
    if (next) onChange(next)
  }
  const t = useStrings()
  return (
    <div className="de-zoom" role="group" aria-label={t.zoom.group}>
      <button type="button" aria-label={t.zoom.out} onClick={() => step(-1)}>
        <Icon name="zoomOut" size={16} />
      </button>
      <span title={zoom === 'fit' ? t.zoom.fitTitle : t.zoom.toFit} onClick={() => onChange(zoom === 'fit' ? 1 : 'fit')}>
        {zoom === 'fit' ? t.zoom.fit : formatNumber(t, effective, { style: 'percent' })}
      </span>
      <button type="button" aria-label={t.zoom.in} onClick={() => step(1)}>
        <Icon name="zoomIn" size={16} />
      </button>
    </div>
  )
}
