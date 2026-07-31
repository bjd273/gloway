// Drives a live position along the selected route and streams it to the
// backend — the ACTIVE_NAVIGATION source feeding /gps-update.
//
// Two position sources share one buffer/batch/stream pipeline:
//
//   'real' — navigator.geolocation.watchPosition. The genuine article: fixes
//            come from the device, deviations are real, and the adherence
//            signal downstream (services/signal_processor.py) finally means
//            something. Requires a secure context (HTTPS or localhost).
//   'sim'  — drives the route's own geometry at a plausible speed. Kept for
//            off-region dev: on a laptop nowhere near the Arlington tiles a
//            real watchPosition would sit off-map forever. Selected with
//            ?sim=1 (or automatically when geolocation is missing).
//
// Everything downstream of the source — buffering, batch flushes to
// /gps-update, the live puck, arrival — is identical in both modes, which is
// exactly what makes sim an honest stand-in during development.
import { streamGpsPoints } from './api'
import { cumulativeMeters } from './routeProgress'

const TICK_MS = 800 // sim: emit a position this often
const FLUSH_MS = 3000 // send buffered points to the backend this often
const MIN_FIX_INTERVAL_MS = 1000 // real: ignore fixes arriving faster than this
const ARRIVE_RADIUS_M = 40 // real: this close to the final coordinate = arrived
const ARRIVE_TAIL_FRACTION = 0.9 // ...but only once we're in the route's last 10%

/** ~30 mph, for a sim whose route reported no usable duration. */
const DEFAULT_SIM_MPS = 13.4

export type DriveMode = 'real' | 'sim'

/**
 * How the simulated drive moves.
 *
 * The sim used to cover the route in a fixed 45 ticks — ~36 seconds for any
 * route, whether it was two miles or twenty. That was fine when the only thing
 * riding on it was a puck sliding along a line, but turn guidance counts down a
 * real distance to a real turn, and at a quarter-mile per tick the countdown
 * went from "1200 feet" to "now" with nothing in between. So the sim moves in
 * metres per second now, and the multiplier is how a demo stays quick.
 */
export interface SimOptions {
  /** Fallback speed for stretches the profile doesn't cover. */
  metersPerSecond?: number
  /**
   * Per-step speeds, each applying up to `endMeters` along the route. Lets the
   * sim crawl through a neighbourhood and open up on an arterial rather than
   * glide at one average that matches neither.
   */
  speedProfile?: { endMeters: number; metersPerSecond: number }[]
  /**
   * Wall-clock speed-up, read fresh every tick so the 1x/4x/8x control takes
   * effect mid-drive without restarting the controller. A closure rather than a
   * store import: this module must stay importable by the store.
   */
  speedMultiplier?: () => number
}

export interface DrivePosition {
  lng: number
  lat: number
}

interface DriveHandlers {
  onPosition: (p: DrivePosition) => void
  /** 0..1 of the route's LENGTH driven so far — not of its coordinate count.
   * Consumers treat it as a distance: the map greys the traveled span with it
   * (`line-progress`), TripSheet multiplies it by total miles to pick the
   * current maneuver, NavVoice speaks the remainder. Index-based progress
   * silently lied to all three on any route with uneven point spacing. */
  onProgress: (fraction: number) => void
  onArrive: () => void
  /** Real mode only: watchPosition failed (permission denied, no signal).
   * The drive cannot continue — callers should stop navigation and say why. */
  onGpsError?: (message: string) => void
}

/** Which drive mode this session should use. Real GPS is the product; sim is
 * an explicit dev opt-in (?sim=1) or the fallback when the API is absent. */
export function resolveDriveMode(): DriveMode {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return 'sim'
  if (new URLSearchParams(window.location.search).get('sim') === '1') return 'sim'
  return 'real'
}

// Minimal slice of the Geolocation API the controller uses — injectable so
// tests can feed synthetic fixes without a browser.
export interface GeolocationLike {
  watchPosition(
    onFix: (pos: { coords: { latitude: number; longitude: number } }) => void,
    onError: (err: { code: number; message: string }) => void,
    options: PositionOptions,
  ): number
  clearWatch(id: number): void
}

/** Squared local-meters distance between two [lng, lat] points. The same
 * equirectangular idea signal_processor.py uses server-side — accurate at
 * metro scale, and monotonic, so it's fine for nearest-point comparisons. */
function distSqMeters(a: [number, number], b: [number, number]): number {
  const kLng = 111_320 * Math.cos((a[1] * Math.PI) / 180)
  const dx = (a[0] - b[0]) * kLng
  const dy = (a[1] - b[1]) * 110_540
  return dx * dx + dy * dy
}

export class DriveController {
  private readonly tripId: string
  private readonly coords: [number, number][] // [lng, lat] along the route
  /** Cumulative metres at each coordinate, and the same thing normalised to
   * 0..1. Both derived from one pass, so they cannot disagree. */
  private readonly cumulative: number[]
  private readonly fractions: number[]
  private readonly totalMeters: number
  private readonly handlers: DriveHandlers
  private readonly mode: DriveMode
  private readonly geo: GeolocationLike | null
  private readonly sim: SimOptions
  private tickTimer?: ReturnType<typeof setInterval>
  private flushTimer?: ReturnType<typeof setInterval>
  private watchId: number | null = null
  private buffer: { lat: number; lon: number; timestamp: string }[] = []
  private idx = 0 // sim: segment cursor; real: nearest route index so far
  private simMeters = 0 // sim: distance driven along the route
  private lastFixAt = 0
  private done = false

  constructor(
    tripId: string,
    coords: [number, number][],
    handlers: DriveHandlers,
    mode: DriveMode = resolveDriveMode(),
    geo: GeolocationLike | null = typeof navigator !== 'undefined'
      ? (navigator.geolocation as GeolocationLike | null)
      : null,
    sim: SimOptions = {},
  ) {
    this.tripId = tripId
    this.coords = coords
    this.cumulative = cumulativeMeters(coords)
    this.totalMeters = this.cumulative[this.cumulative.length - 1] ?? 0
    this.fractions = this.cumulative.map((m) => (this.totalMeters > 0 ? m / this.totalMeters : 0))
    this.handlers = handlers
    this.mode = mode
    this.geo = geo
    this.sim = sim
  }

  start(): void {
    if (this.coords.length < 2) {
      this.handlers.onArrive()
      return
    }
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_MS)
    if (this.mode === 'real' && this.geo) {
      this.watchId = this.geo.watchPosition(
        (pos) => this.onFix(pos.coords.latitude, pos.coords.longitude),
        (err) => {
          // Without fixes the drive can't proceed — surface it, don't limp.
          this.stop()
          this.handlers.onGpsError?.(
            err.code === 1
              ? 'Location permission denied — enable it to record your drive.'
              : 'No GPS signal — the drive cannot be recorded.',
          )
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
      )
    } else {
      this.tickTimer = setInterval(() => this.tick(), TICK_MS)
    }
  }

  // --- real mode ---------------------------------------------------------

  private onFix(lat: number, lng: number): void {
    if (this.done) return
    const now = Date.now()
    if (now - this.lastFixAt < MIN_FIX_INTERVAL_MS) return // throttle bursts
    this.lastFixAt = now

    this.handlers.onPosition({ lng, lat })
    this.buffer.push({ lat, lon: lng, timestamp: new Date().toISOString() })

    // Progress = nearest route coordinate to the fix. A deviation parks the
    // nearest point where the driver left the route, which is the honest
    // reading. Full scan is fine: a few hundred coords at ~1 fix/second.
    let nearest = 0
    let nearestD = Infinity
    for (let i = 0; i < this.coords.length; i++) {
      const d = distSqMeters([lng, lat], this.coords[i])
      if (d < nearestD) {
        nearestD = d
        nearest = i
      }
    }
    this.idx = nearest
    const progress = this.fractions[nearest]
    this.handlers.onProgress(progress)

    // Arrived: near the final coordinate AND genuinely in the route's tail —
    // the tail check stops a loop-shaped route (destination near origin) from
    // "arriving" the moment the drive starts.
    const dEnd = distSqMeters([lng, lat], this.coords[this.coords.length - 1])
    if (progress >= ARRIVE_TAIL_FRACTION && dEnd <= ARRIVE_RADIUS_M * ARRIVE_RADIUS_M) {
      this.arrive()
    }
  }

  // --- sim mode ----------------------------------------------------------

  /** Speed applying at a point along the route, from the per-step profile. */
  private speedAt(meters: number): number {
    const fallback = this.sim.metersPerSecond ?? DEFAULT_SIM_MPS
    const profile = this.sim.speedProfile
    if (!profile?.length) return fallback
    for (const band of profile) {
      if (meters <= band.endMeters) return band.metersPerSecond > 0 ? band.metersPerSecond : fallback
    }
    const last = profile[profile.length - 1]
    return last.metersPerSecond > 0 ? last.metersPerSecond : fallback
  }

  /**
   * Position at a distance along the route, interpolated WITHIN the segment.
   *
   * Snapping to the nearest shape point instead would quantise everything
   * downstream to Valhalla's point spacing — which on a straight is a hundred
   * metres or more, so a countdown to the next turn would tick in 100m steps
   * and a 30 mph drive would look like a series of jumps.
   */
  private interpolate(meters: number): [number, number] {
    const i = this.idx
    if (i >= this.coords.length - 1) return this.coords[this.coords.length - 1]
    const start = this.cumulative[i]
    const span = this.cumulative[i + 1] - start
    const t = span <= 0 ? 0 : (meters - start) / span
    const [aLng, aLat] = this.coords[i]
    const [bLng, bLat] = this.coords[i + 1]
    return [aLng + (bLng - aLng) * t, aLat + (bLat - aLat) * t]
  }

  private tick(): void {
    if (this.done) return
    const multiplier = this.sim.speedMultiplier?.() ?? 1
    const advance = this.speedAt(this.simMeters) * multiplier * (TICK_MS / 1000)
    this.simMeters = Math.min(this.simMeters + advance, this.totalMeters)

    // Forward walk rather than a search: the cursor only moves ahead, and each
    // tick covers a handful of points at most.
    while (
      this.idx < this.coords.length - 1 &&
      this.cumulative[this.idx + 1] <= this.simMeters
    ) {
      this.idx += 1
    }

    const [lng, lat] = this.interpolate(this.simMeters)
    this.handlers.onPosition({ lng, lat })
    // The true driven fraction, not fractions[idx] — the sim knows exactly how
    // far it has gone, so there is no reason to round it to a shape point.
    this.handlers.onProgress(this.totalMeters > 0 ? this.simMeters / this.totalMeters : 0)
    this.buffer.push({ lat, lon: lng, timestamp: new Date().toISOString() })
    if (this.simMeters >= this.totalMeters) this.arrive()
  }

  // --- shared ------------------------------------------------------------

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    const batch = this.buffer
    this.buffer = []
    await streamGpsPoints(this.tripId, batch)
  }

  private arrive(): void {
    if (this.done) return
    this.done = true
    this.clearSources()
    // Flush the tail BEFORE announcing arrival. onArrive() is what triggers
    // POST /complete, and completion scores adherence against whatever has
    // landed server-side — so a fire-and-forget flush here raced the request
    // and the last seconds of the drive (often the whole trace) arrived too
    // late to count. `.finally` so a failed flush still ends the drive.
    void this.flush().finally(() => this.handlers.onArrive())
  }

  /** Stop streaming without firing onArrive (user ended the drive manually).
   * Resolves once the final batch has been sent, so callers can complete the
   * trip knowing the server has the full trace. */
  async stop(): Promise<void> {
    if (this.done) return
    this.done = true
    this.clearSources()
    await this.flush()
  }

  private clearSources(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
    if (this.flushTimer) clearInterval(this.flushTimer)
    if (this.watchId !== null) this.geo?.clearWatch(this.watchId)
    this.watchId = null
  }
}
