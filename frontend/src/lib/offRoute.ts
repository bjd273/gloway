// Deciding that the driver has genuinely left the route.
//
// The hard part is not noticing a deviation — `projectToRoute` reports the
// distance from the line on every fix. The hard part is not crying wolf. A
// reroute mid-drive replaces the geometry, resets the turn countdown and speaks
// over whatever was being said, so a false positive is expensive in a way a
// missed one is not: a driver who is actually off-route will still be off-route
// six seconds later.
//
// So this deliberately reuses `snapConfidence` rather than inventing a second
// threshold. That number already folds together the three things that decide
// whether a fix is on the road — how far off it is, whether the fix is precise
// enough for that distance to mean anything, and whether the car is pointing
// the way the road goes (directed, so the opposite carriageway of a divided
// highway scores as off-route rather than on it). It is also exactly what
// decides whether the puck is drawn on the line. Keying the reroute off the same
// number means the app never reroutes while still drawing you on the road, and
// never leaves you drawn off the road without doing anything about it. Those two
// disagreeing is what a driver reads as a bug.
//
// Everything else here exists to require *persistence*: time, ground covered,
// and a quiet period after each reroute.
import { metersBetween } from './routeProgress'

/** Below this the fix is plausibly still on the road however far off it looks —
 * a wide-accuracy fix on a six-lane arterial gets there honestly. */
const MIN_OFF_ROUTE_METERS = 40
/** The point at which the display has already given up on the route. */
const MAX_SNAP_CONFIDENCE = 0.15

/** The deviation must hold for this long... */
const CONFIRM_MS = 6_000
/** ...and cover this much ground while it does.
 *
 * Ground distance between raw fixes, NOT progress along the route: progress
 * stops advancing the moment you leave the line, so an along-route test can
 * never be satisfied by the very situation it is meant to detect. This is also
 * what stops a parked car with a drifting fix from rerouting itself. */
const CONFIRM_METERS = 60

/** Quiet window at the start of a drive. The route begins at a point on a road;
 * the car begins in a parking space or a driveway, which is not on it. */
const GRACE_MS = 8_000
/** No reroute this close to the end. Pulling into the destination's lot is not
 * a wrong turn, and rerouting there would route you back out of it. */
const TAIL_METERS = 120

/** After a reroute, leave the new route alone for this long. */
const COOLDOWN_MS = 25_000
/** Longer after a failure — the backend or the network is the problem, and
 * retrying at the cooldown interval just adds load to something already sick. */
const FAILURE_COOLDOWN_MS = 30_000

/** More than this many reroutes inside the window and we stop trying on our own.
 *
 * A rolling window rather than a per-drive cap: three reroutes in two minutes
 * means we are fighting the driver (or the destination is unreachable), and the
 * right response is to hand them a button. Three reroutes across a forty-minute
 * drive is just a long drive with some wrong turns, and shutting off there
 * would be worse than the bug being fixed. */
const MAX_REROUTES_PER_WINDOW = 3
const REROUTE_WINDOW_MS = 300_000

/** One position update, as the detector needs to see it. */
export interface OffRouteSample {
  /** Perpendicular distance from the route, or null when nothing projected. */
  offRouteMeters: number | null
  /** 0..1, from snapConfidence — see the module comment. */
  snapConfidence: number
  /** The RAW fix. A reroute has to start where the car is, not where we were
   * drawing it, and the whole premise here is that those have diverged. */
  rawLng: number
  rawLat: number
  /** Metres along the route at the projection, and the route's total length. */
  metersDriven: number
  routeMeters: number
  /** Real mode: fixes have stopped arriving. A frozen puck is not a deviation. */
  gpsSignalLost: boolean
  at: number
}

/** Where to reroute from, once the detector is convinced. */
export interface OffRouteVerdict {
  lng: number
  lat: number
}

export class OffRouteDetector {
  /** No reroute before this instant — grace at the start, cooldown after one. */
  private quietUntil: number
  /** Timestamps of recent reroutes/failures, pruned to the rolling window. */
  private recent: number[] = []
  /** The deviation currently being corroborated, if any. */
  private pending: { since: number; lng: number; lat: number; ground: number } | null = null

  constructor(startedAt: number) {
    this.quietUntil = startedAt + GRACE_MS
  }

  /** True while we have stopped rerouting on our own. Reflects the window as of
   * the last `update`/`note*` call, which is when it was last pruned. */
  get exhausted(): boolean {
    return this.recent.length >= MAX_REROUTES_PER_WINDOW
  }

  /**
   * Feed one position update.
   *
   * Returns the point to reroute from once every gate has held for long enough,
   * and null every other time — including, importantly, on the fix that first
   * looks bad. Anything that fails a gate clears the pending window outright,
   * which is how "came back to the route" is handled without a second code path.
   */
  update(s: OffRouteSample): OffRouteVerdict | null {
    this.prune(s.at)

    if (
      s.gpsSignalLost ||
      s.at < this.quietUntil ||
      this.exhausted ||
      !this.deviating(s)
    ) {
      this.pending = null
      return null
    }

    if (!this.pending) {
      this.pending = { since: s.at, lng: s.rawLng, lat: s.rawLat, ground: 0 }
      return null
    }

    this.pending.ground += metersBetween(
      [this.pending.lng, this.pending.lat],
      [s.rawLng, s.rawLat],
    )
    this.pending.lng = s.rawLng
    this.pending.lat = s.rawLat

    if (s.at - this.pending.since < CONFIRM_MS) return null
    if (this.pending.ground < CONFIRM_METERS) return null

    this.pending = null
    return { lng: s.rawLng, lat: s.rawLat }
  }

  /** A reroute landed. Quiet down and count it toward the window. */
  noteRerouted(at: number): void {
    this.record(at, COOLDOWN_MS)
  }

  /** A reroute request failed. Counted the same way — repeatedly failing is as
   * good a reason to stop trying as repeatedly succeeding. */
  noteFailed(at: number): void {
    this.record(at, FAILURE_COOLDOWN_MS)
  }

  private record(at: number, quietMs: number): void {
    this.recent.push(at)
    this.prune(at)
    this.quietUntil = Math.max(this.quietUntil, at + quietMs)
    this.pending = null
  }

  private prune(now: number): void {
    this.recent = this.recent.filter((t) => now - t < REROUTE_WINDOW_MS)
  }

  private deviating(s: OffRouteSample): boolean {
    if (s.offRouteMeters === null) return false
    if (s.offRouteMeters <= MIN_OFF_ROUTE_METERS) return false
    if (s.snapConfidence >= MAX_SNAP_CONFIDENCE) return false
    return s.routeMeters - s.metersDriven > TAIL_METERS
  }
}
