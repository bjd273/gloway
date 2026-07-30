// Drives a live position along the selected route and streams it to the
// backend — the ACTIVE_NAVIGATION source feeding /gps-update.
//
// Two position sources share one buffer/batch/stream pipeline:
//
//   'real' — navigator.geolocation.watchPosition. The genuine article: fixes
//            come from the device, deviations are real, and the adherence
//            signal downstream (services/signal_processor.py) finally means
//            something. Requires a secure context (HTTPS or localhost).
//   'sim'  — walks the route's own coordinates on a timer (~36s per route).
//            Kept for off-region dev: on a laptop nowhere near the Arlington
//            tiles a real watchPosition would sit off-map forever. Selected
//            with ?sim=1 (or automatically when geolocation is missing).
//
// Everything downstream of the source — buffering, batch flushes to
// /gps-update, the live puck, arrival — is identical in both modes, which is
// exactly what makes sim an honest stand-in during development.
import { streamGpsPoints } from './api'
import { lengthFractions } from './routeProgress'

const TICK_MS = 800 // sim: emit a position this often
const FLUSH_MS = 3000 // send buffered points to the backend this often
const TARGET_TICKS = 45 // sim: ~36s to "drive" any route, regardless of length
const MIN_FIX_INTERVAL_MS = 1000 // real: ignore fixes arriving faster than this
const ARRIVE_RADIUS_M = 40 // real: this close to the final coordinate = arrived
const ARRIVE_TAIL_FRACTION = 0.9 // ...but only once we're in the route's last 10%

export type DriveMode = 'real' | 'sim'

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
  /** Cumulative length fraction at each coordinate — index-parallel to
   * `coords`, so a nearest-point index converts to distance progress in O(1). */
  private readonly fractions: number[]
  private readonly handlers: DriveHandlers
  private readonly mode: DriveMode
  private readonly geo: GeolocationLike | null
  private tickTimer?: ReturnType<typeof setInterval>
  private flushTimer?: ReturnType<typeof setInterval>
  private watchId: number | null = null
  private buffer: { lat: number; lon: number; timestamp: string }[] = []
  private idx = 0 // sim: index walked; real: nearest route index so far
  private stride: number
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
  ) {
    this.tripId = tripId
    this.coords = coords
    this.fractions = lengthFractions(coords)
    this.handlers = handlers
    this.mode = mode
    this.geo = geo
    this.stride = Math.max(1, Math.round(coords.length / TARGET_TICKS))
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

  private tick(): void {
    if (this.done) return
    this.idx = Math.min(this.idx + this.stride, this.coords.length - 1)
    const [lng, lat] = this.coords[this.idx]
    this.handlers.onPosition({ lng, lat })
    this.handlers.onProgress(this.fractions[this.idx])
    this.buffer.push({ lat, lon: lng, timestamp: new Date().toISOString() })
    if (this.idx >= this.coords.length - 1) this.arrive()
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
