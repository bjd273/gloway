// Distance-along-route math, shared by the drive controller and the map.
//
// Three parts of the app ask "how far along is the driver?", and they have to
// answer in the same units or the lit half of the ribbon won't line up with
// the puck sitting on it:
//
//   - DriveController projects each GPS fix onto the nearest route coordinate.
//   - MapLibre's `line-progress` addresses a line by fraction of its LENGTH.
//   - TripSheet / NavVoice multiply the fraction by the route's total miles.
//
// Coordinate index is not a stand-in for any of them. Valhalla packs shape
// points tightly through curves and spreads them far apart on straights, so
// coordinate 50 of 100 is routinely nowhere near the halfway mark — the old
// `index / (n - 1)` progress could claim 50% while sitting a quarter-mile off,
// which showed up as a greyed-out line running ahead of or behind the puck.
// Everything here works in cumulative metres and returns length fractions.

/** Metres per degree of latitude — near enough constant at metro scale. */
const M_PER_DEG_LAT = 110_540
const M_PER_DEG_LNG_EQUATOR = 111_320

/**
 * Equirectangular metres between two `[lng, lat]` points — the same local
 * projection `services/signal_processor.py` uses server-side. Exact enough
 * over a city, and cheap enough to run per fix over a few hundred points.
 */
export function metersBetween(a: [number, number], b: [number, number]): number {
  const kLng = M_PER_DEG_LNG_EQUATOR * Math.cos((a[1] * Math.PI) / 180)
  return Math.hypot((b[0] - a[0]) * kLng, (b[1] - a[1]) * M_PER_DEG_LAT)
}

/**
 * Cumulative length fraction (0..1) at each coordinate of a route.
 *
 * `fractions[i]` is how far along the line coordinate `i` sits — exactly the
 * number `line-progress` expects. The array is always the same length as
 * `coords`, so an index from a nearest-point search indexes straight into it.
 * A degenerate route (under 2 points, or every point identical) comes back all
 * zeros rather than NaN, so callers never have to guard the divide.
 */
export function lengthFractions(coords: [number, number][]): number[] {
  const fractions = cumulativeMeters(coords)
  if (coords.length < 2) return fractions
  const total = fractions[fractions.length - 1]
  if (total === 0) return fractions.fill(0)
  for (let i = 1; i < coords.length; i += 1) fractions[i] /= total
  return fractions
}

/**
 * Cumulative metres travelled at each coordinate — the un-normalised half of
 * `lengthFractions`, which divides this away and throws the scale out.
 *
 * Turn guidance needs the metres themselves. "Turn right in 500 feet" cannot be
 * recovered from two fractions without the route's total length tagging along,
 * and passing that around separately is how the two get out of step.
 *
 * Index-parallel to `coords`, always, so a nearest-point index reads straight
 * in. A degenerate route comes back all zeros rather than NaN.
 */
export function cumulativeMeters(coords: [number, number][]): number[] {
  const meters = new Array<number>(coords.length).fill(0)
  for (let i = 1; i < coords.length; i += 1) {
    meters[i] = meters[i - 1] + metersBetween(coords[i - 1], coords[i])
  }
  return meters
}

/** Index of the last coordinate at or before `fraction`. Binary search: this
 * runs on every fix and every camera update. */
function indexAtFraction(fractions: number[], fraction: number): number {
  let lo = 0
  let hi = fractions.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (fractions[mid] <= fraction) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Compass bearing (degrees, 0 = north, clockwise) of travel at a point along
 * the route — what the camera rotates to and the puck's arrow points at.
 *
 * Read off the route's own geometry looking `lookaheadMeters` ahead, NOT from
 * the delta between consecutive GPS fixes. Two reasons, both about the car
 * being stopped: a fix-delta bearing spins randomly at a standstill, and a map
 * that spins at every red light is unusable. Averaging over ~60m of road also
 * smooths the per-point jitter that would otherwise wobble the camera through
 * every curve.
 *
 * The tradeoff: a driver who leaves the route keeps being shown the route's
 * heading until they rejoin. That's acceptable — the guidance on screen is the
 * route's guidance either way — and it's the same assumption the greyed-out
 * traveled line already makes.
 *
 * Returns null when the route is too short to have a direction at all.
 */
export function bearingAtFraction(
  coords: [number, number][],
  fractions: number[],
  fraction: number,
  lookaheadMeters = 60,
): number | null {
  if (coords.length < 2 || fractions.length !== coords.length) return null
  const start = Math.min(indexAtFraction(fractions, fraction), coords.length - 2)
  let end = start + 1
  let ahead = metersBetween(coords[start], coords[end])
  while (end < coords.length - 1 && ahead < lookaheadMeters) {
    end += 1
    ahead += metersBetween(coords[end - 1], coords[end])
  }
  const a = coords[start]
  const b = coords[end]
  const east = (b[0] - a[0]) * M_PER_DEG_LNG_EQUATOR * Math.cos((a[1] * Math.PI) / 180)
  const north = (b[1] - a[1]) * M_PER_DEG_LAT
  if (east === 0 && north === 0) return null
  // atan2(east, north) — arguments deliberately in that order: it yields a
  // clockwise-from-north compass bearing, which is what MapLibre's `bearing`
  // and a marker's `rotation` both expect.
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360
}
