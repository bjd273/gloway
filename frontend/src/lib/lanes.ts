// Turn-lane guidance: which lane to be in for the maneuver coming up.
//
// The data arrives already grafted onto each maneuver by the backend (see
// backend/routing/lane_guidance.py — Valhalla only emits lanes in its OSRM
// dialect). Each entry is one painted lane, in road order left to right, with
// the arrows on it and whether it keeps you on the route.
import type { LaneInfo } from './api'

/** The arrows a lane can be painted with. */
export type LaneArrow =
  | 'uturn'
  | 'sharp-left'
  | 'left'
  | 'slight-left'
  | 'through'
  | 'slight-right'
  | 'right'
  | 'sharp-right'
  | 'merge-left'
  | 'merge-right'
  | 'none'

/**
 * OSRM's indication strings, in the order the arrows appear ON THE ROAD:
 * leftmost turn first, straight in the middle, rightmost turn last.
 *
 * The order is the data, not presentation. A lane painted "left + through"
 * must render as an arrow bending left beside one going straight, in that
 * order — sorting these any other way (alphabetically, or by however the
 * response happened to list them) would draw a lane that doesn't match the
 * tarmac the driver is looking at.
 */
const ARROW_ORDER: { indication: string; arrow: LaneArrow }[] = [
  { indication: 'uturn', arrow: 'uturn' },
  { indication: 'sharp left', arrow: 'sharp-left' },
  { indication: 'left', arrow: 'left' },
  { indication: 'slight left', arrow: 'slight-left' },
  { indication: 'merge to left', arrow: 'merge-left' },
  { indication: 'straight', arrow: 'through' },
  { indication: 'none', arrow: 'none' },
  { indication: 'merge to right', arrow: 'merge-right' },
  { indication: 'slight right', arrow: 'slight-right' },
  { indication: 'right', arrow: 'right' },
  { indication: 'sharp right', arrow: 'sharp-right' },
]

export interface DecodedLane {
  /** Arrows painted in this lane, left to right. */
  arrows: LaneArrow[]
  /** Whether staying in this lane keeps you on the route. */
  valid: boolean
  /**
   * The one arrow to follow from this lane. Null unless Valhalla singled a
   * lane out, which it only does on the approach itself — so most of the time
   * every lane is just valid or not.
   */
  active: LaneArrow | null
}

function arrowsFrom(indications: string[] | undefined): LaneArrow[] {
  if (!indications?.length) return []
  const wanted = new Set(indications.map((i) => i.toLowerCase()))
  return ARROW_ORDER.filter((entry) => wanted.has(entry.indication)).map((e) => e.arrow)
}

/** Turn the raw lane array into something renderable. Empty for a maneuver
 * with no lane data, which is most of them outside major junctions. */
export function decodeLanes(lanes?: LaneInfo[]): DecodedLane[] {
  if (!lanes?.length) return []
  return lanes.map((lane) => {
    const arrows = arrowsFrom(lane.indications)
    const valid = Boolean(lane.valid)
    // `valid_indication` names the arrow to follow; fall back to the lane's
    // only arrow when it's unambiguous anyway.
    const activeArrow = lane.valid_indication
      ? (arrowsFrom([lane.valid_indication])[0] ?? null)
      : arrows.length === 1
        ? arrows[0]
        : null
    return { arrows, valid, active: lane.active && valid ? activeArrow : null }
  })
}

/**
 * "Use the 2 left lanes" — the strip's accessible label, and readable enough
 * to speak. Null when no lane serves the turn, which is the same condition
 * that hides the strip entirely.
 *
 * Only contiguous runs get named. Valid lanes split by an invalid one ("either
 * of the outside lanes") have no short phrase that isn't misleading, so those
 * fall back to a plain count.
 */
export function laneHint(lanes: DecodedLane[]): string | null {
  const validIndexes = lanes.map((l, i) => (l.valid ? i : -1)).filter((i) => i >= 0)
  if (validIndexes.length === 0) return null

  const contiguous = validIndexes.every(
    (index, i) => i === 0 || index === validIndexes[i - 1] + 1,
  )
  const count = validIndexes.length
  const plural = count === 1 ? 'lane' : `${count} lanes`

  if (!contiguous) return `Use any of ${count} marked lanes`
  if (validIndexes[0] === 0 && count < lanes.length) return `Use the left ${plural}`
  if (validIndexes[count - 1] === lanes.length - 1 && count < lanes.length) {
    return `Use the right ${plural}`
  }
  if (count === lanes.length) return 'Any lane'
  return `Use the middle ${plural}`
}
