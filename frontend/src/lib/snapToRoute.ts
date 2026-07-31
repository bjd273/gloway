// Putting the puck on the road it is actually on.
//
// A GPS fix in the outer lane of a six-lane arterial lands 10-15 m off the
// route's centreline, and the puck was drawn at the raw fix — so the driver saw
// themselves beside the road, which reads as "the app thinks I'm going the
// wrong way" at exactly the moment they need to trust it.
//
// Two things are separated here, and the separation is the whole design:
//
//   - Where the driver is TOLD they are: the perpendicular foot on the route,
//     blended toward the raw fix by a confidence weight.
//   - Where the app RECORDS them: always the raw fix. `DriveController` keeps
//     pushing untouched coordinates to /gps-update, because
//     services/signal_processor.py scores route adherence off that trace.
//     Posting snapped points would make adherence_rate 1.0 by construction and
//     quietly poison the learning signal — the app would be grading itself on
//     its own assumption.
//
// The confidence weight is what keeps this honest on screen too. Snapping
// unconditionally would mean a genuine wrong turn still draws the puck on the
// route until re-routing notices, which is a nav app telling a confident lie.
// Instead confidence collapses as the fix moves away from the line or starts
// pointing somewhere else, and the puck slides back to the truth.
import { metersBetween } from './routeProgress'
import { clamp, shortestAngleDelta, smoothstep } from './smoothing'

const M_PER_DEG_LAT = 110_540
const M_PER_DEG_LNG_EQUATOR = 111_320

/** How far back the windowed search looks — covers a stopped car and GPS noise. */
const DEFAULT_BACK_METERS = 60
/** Forward window floor; the caller widens it with speed (three seconds of road). */
const DEFAULT_FORWARD_METERS = 150
/** Past this the window has clearly lost the driver; fall back to a full scan. */
const RESCUE_METERS = 150
/** A full-scan rescue may not drag progress backwards further than this. */
const MAX_BACKWARD_RESCUE_METERS = 30

/** Assumed horizontal accuracy when the device doesn't report one. */
const ASSUMED_ACCURACY_M = 20
/** Corridor half-width bounds. A lane is ~3.5 m, so two lanes out is ~7 m. */
const MIN_GATE_M = 12
const MAX_GATE_M = 40

/** Heading disagreement that starts, and completes, the refusal to snap. */
const HEADING_OK_DEG = 35
const HEADING_BAD_DEG = 75

export interface RouteProjection {
  /** The perpendicular foot on the polyline, [lng, lat]. */
  lng: number
  lat: number
  /** Fix to foot, metres. */
  distanceMeters: number
  /** Cumulative metres along the route at the foot. */
  meters: number
  /** `meters` normalised by route length. */
  fraction: number
  /** Index of the segment's first coordinate — seeds the next search. */
  index: number
  /** Compass bearing of that segment. */
  segmentBearing: number
}

function localMeters(
  origin: [number, number],
  point: [number, number],
): [number, number] {
  const kLng = M_PER_DEG_LNG_EQUATOR * Math.cos((origin[1] * Math.PI) / 180)
  return [(point[0] - origin[0]) * kLng, (point[1] - origin[1]) * M_PER_DEG_LAT]
}

function bearingBetween(a: [number, number], b: [number, number]): number {
  const [east, north] = localMeters(a, b)
  if (east === 0 && north === 0) return 0
  // atan2(east, north) — that argument order yields a clockwise-from-north
  // compass bearing, which is what MapLibre's `bearing` and a marker's
  // `rotation` both expect. Same convention as routeProgress.bearingAtFraction.
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360
}

/** Where a point falls on one segment, as a 0..1 position and a distance. */
function projectOntoSegment(
  a: [number, number],
  b: [number, number],
  p: [number, number],
): { t: number; distanceMeters: number } {
  const [abx, aby] = localMeters(a, b)
  const [apx, apy] = localMeters(a, p)
  const lenSq = abx * abx + aby * aby
  // A zero-length segment (duplicate shape points do occur) projects to its
  // start rather than dividing by zero.
  const t = lenSq === 0 ? 0 : clamp((apx * abx + apy * aby) / lenSq, 0, 1)
  const dx = apx - abx * t
  const dy = apy - aby * t
  return { t, distanceMeters: Math.hypot(dx, dy) }
}

function projectionAt(
  coords: [number, number][],
  cumulative: number[],
  i: number,
  t: number,
  distanceMeters: number,
): RouteProjection {
  const [aLng, aLat] = coords[i]
  const [bLng, bLat] = coords[i + 1]
  const total = cumulative[cumulative.length - 1] || 0
  const meters = cumulative[i] + (cumulative[i + 1] - cumulative[i]) * t
  return {
    lng: aLng + (bLng - aLng) * t,
    lat: aLat + (bLat - aLat) * t,
    distanceMeters,
    meters,
    fraction: total > 0 ? meters / total : 0,
    index: i,
    segmentBearing: bearingBetween(coords[i], coords[i + 1]),
  }
}

function scan(
  coords: [number, number][],
  cumulative: number[],
  fix: [number, number],
  from: number,
  to: number,
): RouteProjection | null {
  let best: RouteProjection | null = null
  for (let i = from; i < to; i += 1) {
    const { t, distanceMeters } = projectOntoSegment(coords[i], coords[i + 1], fix)
    if (!best || distanceMeters < best.distanceMeters) {
      best = projectionAt(coords, cumulative, i, t, distanceMeters)
    }
  }
  return best
}

/**
 * Perpendicular projection of a fix onto the route.
 *
 * Deliberately not "nearest shape point", which is what this replaced: that
 * quantises to Valhalla's point spacing — over a hundred metres on a straight —
 * so the turn countdown ticked in 100 m steps and the greyed-out traveled line
 * lagged the puck. A foot on the segment is continuous.
 *
 * Pass `fromIndex` to search a window around the last known position instead of
 * the whole line. That is not just a speed-up: a full scan on a route that
 * doubles back (a loop, a U-turn, an out-and-back) can match the leg driven ten
 * minutes ago and throw progress backwards. Omitting `fromIndex` deliberately
 * does scan everything — the first fix of a drive, and the first fix after a
 * reroute, have no prior position to search around.
 */
export function projectToRoute(
  coords: [number, number][],
  cumulative: number[],
  fix: [number, number],
  opts: { fromIndex?: number; backMeters?: number; forwardMeters?: number } = {},
): RouteProjection | null {
  if (coords.length < 2 || cumulative.length !== coords.length) return null
  const lastSegment = coords.length - 1

  if (opts.fromIndex === undefined) return scan(coords, cumulative, fix, 0, lastSegment)

  const anchor = clamp(opts.fromIndex, 0, lastSegment - 1)
  const back = opts.backMeters ?? DEFAULT_BACK_METERS
  const forward = opts.forwardMeters ?? DEFAULT_FORWARD_METERS
  let from = anchor
  while (from > 0 && cumulative[anchor] - cumulative[from] < back) from -= 1
  let to = anchor + 1
  while (to < lastSegment && cumulative[to] - cumulative[anchor] < forward) to += 1

  const windowed = scan(coords, cumulative, fix, from, to)
  if (windowed && windowed.distanceMeters <= RESCUE_METERS) return windowed

  // The window lost the driver. Look everywhere — but refuse an answer that
  // drags progress backwards, which is how a loop-shaped route would otherwise
  // "rejoin" at a point already driven. If the full scan is no better, keep the
  // windowed answer and let confidence fall to zero: the puck goes to the raw
  // fix, which is the honest picture of someone off-route.
  const full = scan(coords, cumulative, fix, 0, lastSegment)
  if (!full) return windowed
  if (windowed && full.meters < windowed.meters - MAX_BACKWARD_RESCUE_METERS) return windowed
  return full
}

/**
 * Position at a distance along the route.
 *
 * Was `DriveController.interpolate`, private and sim-only; dead reckoning needs
 * the same thing, so it moved here rather than being written twice. Interpolates
 * WITHIN the segment for the reason that docstring gave: landing on shape points
 * would quantise a smooth drive into a series of jumps.
 */
export function pointAtMeters(
  coords: [number, number][],
  cumulative: number[],
  meters: number,
): [number, number] {
  if (coords.length === 0) return [0, 0]
  if (coords.length === 1) return coords[0]
  const total = cumulative[cumulative.length - 1]
  if (meters <= 0) return coords[0]
  if (meters >= total) return coords[coords.length - 1]

  let lo = 0
  let hi = coords.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (cumulative[mid] <= meters) lo = mid
    else hi = mid
  }
  const span = cumulative[lo + 1] - cumulative[lo]
  const t = span <= 0 ? 0 : (meters - cumulative[lo]) / span
  const [aLng, aLat] = coords[lo]
  const [bLng, bLat] = coords[lo + 1]
  return [aLng + (bLng - aLng) * t, aLat + (bLat - aLat) * t]
}

/**
 * How much to believe that the driver is on the route here, 0..1.
 *
 * Two factors, multiplied, both smoothstepped so nothing switches on a hard
 * threshold:
 *
 *   distance — against a corridor that widens with the fix's own reported
 *     accuracy. A 5 m fix 20 m off the line is somewhere else; a 40 m fix 20 m
 *     off the line is probably on it.
 *   heading — the fix's course against the road's direction. This is DIRECTED,
 *     not folded to +/-90: the opposite carriageway of a divided highway, or a
 *     frontage road running alongside, scores ~180 and correctly refuses to
 *     snap. Folding would treat them as a perfect match and stick the puck on
 *     the wrong roadway, which is worse than not snapping at all.
 *
 * A missing course is not penalised. It means the car is stopped or the device
 * didn't supply one, and a car sitting at a stop bar is exactly where snapping
 * is most useful and least risky.
 */
export function snapConfidence(input: {
  distanceMeters: number
  accuracyMeters: number | null
  courseDeg: number | null
  segmentBearing: number
}): number {
  const accuracy = input.accuracyMeters ?? ASSUMED_ACCURACY_M
  const gate = clamp(0.5 * accuracy + 6, MIN_GATE_M, MAX_GATE_M)
  const byDistance = 1 - smoothstep(gate, gate * 2, input.distanceMeters)
  if (input.courseDeg === null) return byDistance
  const error = Math.abs(shortestAngleDelta(input.courseDeg, input.segmentBearing))
  return byDistance * (1 - smoothstep(HEADING_OK_DEG, HEADING_BAD_DEG, error))
}

/** Straight-line metres between two [lng, lat] points. Re-exported so callers
 * doing snap maths don't have to import from two modules. */
export { metersBetween }
