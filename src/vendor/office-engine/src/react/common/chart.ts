import { PictureTooLarge } from '../../core/diagram/svg'
import type { ChartModel } from '../../core/xlsx/chart'
import { MAX_CHART_SVG, renderChart } from '../../core/xlsx/chart-svg'

/**
 * The most characters the chart pictures of a page hold together. Charts are drawn in a view's render and laid out by
 * the browser on the main thread, one of `MAX_CHART_SVG` for about two seconds: a sheet of crafted charts, each as large
 * as it may be, would hold the page for as many times that. A chart that finds no room left is not drawn (its
 * placeholder shows) until charts drawn before it are let go.
 */
export const MAX_CHART_PICTURES = 2 * MAX_CHART_SVG

/** the room every chart has whatever the others hold: an ordinary chart (a few kilobytes) is always drawn */
export const MIN_CHART_SVG = 256 * 1024

/** a chart's picture, drawn for the size it was last shown at ('' when it could not be drawn at that size) */
interface Drawn {
  at: string
  url: string
  /** what it holds of `MAX_CHART_PICTURES`: its picture's size, or the room it was given up for */
  size: number
  /** the models it is the picture of: one, or the copies of a chart that has a key */
  models: number
  key?: string
}

const drawn = new WeakMap<ChartModel, Drawn>()
/** the pictures of charts that have a key (`ChartModel.key`): a copy read later is shown by the picture there is */
const keyed = new Map<string, Drawn>()
let held = 0

function letGo(d: Drawn) {
  if (d.url) URL.revokeObjectURL(d.url)
  held -= d.size
  d.url = ''
  d.size = 0
  d.at = ''
}

/** one model less shows the picture: the last one takes it along */
function leave(d: Drawn) {
  if (--d.models > 0) return
  letGo(d)
  if (d.key !== undefined && keyed.get(d.key) === d) keyed.delete(d.key)
}

// a model no longer held (a slide or a page read again, a document closed) leaves its picture: a view that reads its
// charts again and again (a slide after every edit) would else leave a picture behind each time
const collected = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry<Drawn>(leave) : undefined

function pictureOf(m: ChartModel): Drawn {
  let d = drawn.get(m)
  if (d) return d
  d = (m.key !== undefined ? keyed.get(m.key) : undefined) ?? { at: '', url: '', size: 0, models: 0, key: m.key }
  if (m.key !== undefined) keyed.set(m.key, d)
  d.models++
  drawn.set(m, d)
  collected?.register(m, d, m)
  return d
}

/**
 * The chart drawn at `w` × `h` px as an SVG picture's object URL (in an img: nothing in it runs), or '' when it could not
 * be drawn: charts are drawn in a view's render, so one a crafted file breaks, or makes too large, shows its placeholder
 * box, not a blank view.
 */
export function chartUrl(m: ChartModel, w: number, h: number): string {
  const at = `${Math.round(w)}x${Math.round(h)}`
  const d = pictureOf(m)
  if (d.at === at) return d.url
  letGo(d)
  d.at = at
  const room = Math.max(MIN_CHART_SVG, Math.min(MAX_CHART_SVG, MAX_CHART_PICTURES - held))
  try {
    const svg = renderChart(m, Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), room)
    d.url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    d.size = svg.length
  } catch (e) {
    console.warn('[office-engine] chart not drawn:', (e as Error).message)
    // given up for its size, it took its room's worth of drawing: it holds that room until it is let go, so a page of
    // such charts is not drawn one after another
    if (e instanceof PictureTooLarge) d.size = room
  }
  held += d.size
  return d.url
}

/** a chart no longer shown leaves its picture */
export function releaseChart(m: ChartModel | undefined) {
  const d = m && drawn.get(m)
  if (!d) return
  drawn.delete(m)
  collected?.unregister(m)
  leave(d)
}

/** what the chart pictures drawn hold together, for tests */
export const chartPicturesHeld = () => held
