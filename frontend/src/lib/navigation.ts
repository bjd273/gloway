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
import { cumulativeMeters, metersBetween } from './routeProgress'
import { pointAtMeters, projectToRoute, snapConfidence } from './snapToRoute'
import { clamp, lerp, smoothFactor } from './smoothing'

const TICK_MS = 800 // sim: emit a position this often
const FLUSH_MS = 3000 // send buffered points to the backend this often
const ARRIVE_RADIUS_M = 40 // real: this close to the final coordinate = arrived
const ARRIVE_TAIL_FRACTION = 0.9 // ...but only once we're in the route's last 10%

/** How often a fix is added to the backend batch. The adherence signal gains
 * nothing above 1Hz, and this is what keeps /gps-update volume sane. */
const MIN_BUFFER_INTERVAL_MS = 1000
/** How often a fix reaches the screen. This used to be the same 1000ms gate,
 * which DROPPED faster fixes outright — so a device capable of better than 1Hz
 * had the extra fixes thrown away and the camera had less to work with. Only
 * duplicate-timestamp bursts are worth rejecting now. */
const MIN_DISPLAY_INTERVAL_MS = 100

/** Beyond this a fix is a cell-tower or wifi guess, not GPS. Using one teleports
 * the puck a block, which is indistinguishable from a bug. */
const MAX_USABLE_ACCURACY_M = 100
/** Below this the fix is taken at face value; between here and the max it is
 * damped toward the previous position rather than trusted outright. */
const TRUSTED_ACCURACY_M = 20
/** ~134 mph implied between two fixes: a teleport, not a car. */
const MAX_PLAUSIBLE_MPS = 60

/** Speed to latch "moving" on and off. The ~1 m/s dead band is what stops the
 * heading arrow flapping in stop-and-go traffic. */
const MOVING_ENTER_MPS = 2.2
const MOVING_EXIT_MPS = 1.2
/** A course derived from a 60m fix is noise wearing a number's clothes. */
const COURSE_MAX_ACCURACY_M = 30

/** Seconds for the snap weight to follow its target. Symmetric: a genuine wrong
 * turn diverges at roughly the car's speed, so this releases the puck within
 * about two seconds, well before it could read as "it thinks I'm still on route". */
const SNAP_TAU_S = 0.7

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
  /**
   * Dev only (?sim=1&jitter=8): scatter the emitted fix by this many metres and
   * report it as the accuracy, while the true position still goes to the
   * backend. Without it the sim rides the centreline exactly, so it cannot
   * reproduce the thing it most needs to — a puck sitting a lane off the road —
   * and the snap constants would have to be tuned in a moving car.
   */
  jitterMeters?: number
}

/**
 * One position update, as everything downstream needs to see it.
 *
 * `lng`/`lat` are the DISPLAY position: the perpendicular foot on the route,
 * blended toward the raw fix by `snapConfidence`. `rawLng`/`rawLat` are what
 * the device actually said. Both travel together deliberately — the display
 * position is the honest thing to draw, and the raw position is the honest
 * thing to record, and keeping them in one object is what stops a later change
 * from quietly posting snapped coordinates to /gps-update.
 */
export interface DrivePosition {
  lng: number
  lat: number
  rawLng: number
  rawLat: number
  /** Course over ground in degrees, or null when stopped / unavailable. */
  courseDeg: number | null
  speedMps: number
  accuracyM: number | null
  /** 0..1 — how much of the display position came from the route. */
  snapConfidence: number
  /** 0..1 along the route, from the projection. */
  fraction: number
  /** Date.now() when this update was produced. */
  at: number
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
  /** Real mode only: watchPosition failed FATALLY — permission denied. The
   * drive cannot continue; callers should stop navigation and say why. */
  onGpsError?: (message: string) => void
  /**
   * Real mode only: fixes stopped arriving, or started arriving unusable.
   * `true` on entering the outage, `false` once a good fix lands.
   *
   * Split from onGpsError because it used to be the same thing: ANY
   * watchPosition error stopped the controller and ended navigation. With a
   * 20-second timeout that means a 20-second tunnel killed a live drive. The
   * watch keeps retrying on its own, so the right response is to say the signal
   * is lost, freeze the puck, and wait.
   */
  onGpsSignal?: (lost: boolean) => void
}

/** Which drive mode this session should use. Real GPS is the product; sim is
 * an explicit dev opt-in (?sim=1) or the fallback when the API is absent. */
export function resolveDriveMode(): DriveMode {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return 'sim'
  if (new URLSearchParams(window.location.search).get('sim') === '1') return 'sim'
  return 'real'
}

/**
 * Metres of synthetic GPS scatter for the sim, from `?jitter=`. 0 = off.
 *
 * A dev affordance with a specific job: the reported bug is a puck drawn a lane
 * off the road, and a sim riding the centreline exactly can never show it. With
 * `?sim=1&jitter=8` the snapping, the confidence gate and the release all run
 * on a laptop, which is the only way to tune them without a car.
 */
export function resolveSimJitter(): number {
  if (typeof window === 'undefined') return 0
  const raw = Number(new URLSearchParams(window.location.search).get('jitter'))
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 50) : 0
}

// The slice of the Geolocation API the controller uses — injectable so tests
// can feed synthetic fixes without a browser.
//
// Every field beyond latitude/longitude is optional, for two reasons: a fake in
// a test should not have to supply them, and browsers genuinely omit them
// (heading is null or NaN at a standstill, and iOS only reports it while
// moving). Reading them at all is new — accuracy, speed and heading were being
// thrown away at the callback, which is why the puck could not tell a precise
// fix from a cell-tower guess and the heading arrow could not tell where the
// car was actually pointing.
export interface GeolocationLike {
  watchPosition(
    onFix: (pos: {
      coords: {
        latitude: number
        longitude: number
        accuracy?: number
        /** Course over ground, degrees clockwise from north. */
        heading?: number | null
        /** Metres per second. */
        speed?: number | null
      }
      timestamp?: number
    }) => void,
    onError: (err: { code: number; message: string }) => void,
    options: PositionOptions,
  ): number
  clearWatch(id: number): void
}

/** What onFix works with once the browser's shape is normalised away. */
interface RawFix {
  lng: number
  lat: number
  accuracyM: number | null
  courseDeg: number | null
  speedMps: number | null
  at: number
}

/** PositionError.code 1. The only one worth ending a drive over. */
const PERMISSION_DENIED = 1

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
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
  private idx = 0 // sim: segment cursor; real: last projected segment index
  private simMeters = 0 // sim: distance driven along the route
  private lastDisplayAt = 0
  private lastBufferAt = 0
  private done = false

  // --- real-mode fix state ---
  /** Previous accepted fix, for the teleport check and the accuracy damping. */
  private lastFix: RawFix | null = null
  /** Latched by hysteresis — see MOVING_ENTER_MPS. */
  private moving = false
  /** Last course we were willing to believe. Held while stopped so the arrow
   * freezes pointing the way the car last went, rather than swinging to the
   * route's bearing or spinning. */
  private lastGoodCourse: number | null = null
  /** Temporally smoothed snap weight, 0..1. */
  private snapWeight = 0
  private signalLost = false

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
        (pos) =>
          this.onFix({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracyM: finiteOrNull(pos.coords.accuracy),
            courseDeg: finiteOrNull(pos.coords.heading),
            speedMps: finiteOrNull(pos.coords.speed),
            at: pos.timestamp ?? Date.now(),
          }),
        (err) => {
          // Only a permission denial is fatal. A timeout or POSITION_UNAVAILABLE
          // is a tunnel, a parking garage, an urban canyon — and watchPosition
          // keeps retrying by itself, so ending the drive throws away a trip
          // that was about to recover. With timeout: 20_000 that used to mean a
          // twenty-second tunnel killed the drive.
          if (err.code === PERMISSION_DENIED) {
            void this.stop()
            this.handlers.onGpsError?.(
              'Location permission denied — enable it to record your drive.',
            )
            return
          }
          this.setSignalLost(true)
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
      )
    } else {
      this.tickTimer = setInterval(() => this.tick(), TICK_MS)
    }
  }

  // --- real mode ---------------------------------------------------------

  private setSignalLost(lost: boolean): void {
    if (this.signalLost === lost) return
    this.signalLost = lost
    this.handlers.onGpsSignal?.(lost)
  }

  /**
   * Is this fix usable, and how much should we trust it?
   *
   * Returns null to drop the fix entirely, otherwise a 0..1 trust weight used
   * to damp the position update. Deliberately not a Kalman filter: the route
   * projection already supplies the strong motion prior a Kalman would have to
   * estimate, and a second filter fighting the projection is how you get a puck
   * that lags through every curve.
   */
  private trustOf(fix: RawFix): number | null {
    const accuracy = fix.accuracyM
    if (accuracy !== null && accuracy > MAX_USABLE_ACCURACY_M) return null

    const previous = this.lastFix
    if (previous) {
      const seconds = (fix.at - previous.at) / 1000
      if (seconds > 0) {
        const moved = metersBetween([previous.lng, previous.lat], [fix.lng, fix.lat])
        if (moved / seconds > MAX_PLAUSIBLE_MPS) return null
      }
    }
    if (accuracy === null || accuracy <= TRUSTED_ACCURACY_M) return 1
    return clamp(
      1 - (accuracy - TRUSTED_ACCURACY_M) / (MAX_USABLE_ACCURACY_M - TRUSTED_ACCURACY_M),
      0.15,
      1,
    )
  }

  /** Speed for this fix — the device's if it gave one, otherwise derived. */
  private speedOf(fix: RawFix): number {
    if (fix.speedMps !== null && fix.speedMps >= 0) return fix.speedMps
    const previous = this.lastFix
    if (!previous) return 0
    const seconds = (fix.at - previous.at) / 1000
    if (seconds <= 0) return 0
    return metersBetween([previous.lng, previous.lat], [fix.lng, fix.lat]) / seconds
  }

  /**
   * Course over ground, or null when we shouldn't claim to know it.
   *
   * Gated on a latched "moving" flag rather than a bare speed threshold so it
   * cannot flap in stop-and-go traffic, and on accuracy because a course
   * derived from a 60m fix is meaningless. Once known, the last good course is
   * held through a stop: an arrow that swings while the car is stationary is
   * its own kind of wrong.
   */
  private courseOf(fix: RawFix, speed: number): number | null {
    if (this.moving) {
      if (speed < MOVING_EXIT_MPS) this.moving = false
    } else if (speed >= MOVING_ENTER_MPS) {
      this.moving = true
    }
    const usable =
      this.moving &&
      fix.courseDeg !== null &&
      (fix.accuracyM ?? COURSE_MAX_ACCURACY_M) <= COURSE_MAX_ACCURACY_M
    if (usable) this.lastGoodCourse = fix.courseDeg
    return this.lastGoodCourse
  }

  private onFix(fix: RawFix): void {
    if (this.done) return
    const now = Date.now()
    if (now - this.lastDisplayAt < MIN_DISPLAY_INTERVAL_MS) return
    const trust = this.trustOf(fix)
    if (trust === null) return
    this.lastDisplayAt = now
    this.setSignalLost(false)

    // A fix we only half-believe pulls the position part of the way rather than
    // being taken at face value or thrown away.
    const previous = this.lastFix
    const rawLng = previous ? lerp(previous.lng, fix.lng, trust) : fix.lng
    const rawLat = previous ? lerp(previous.lat, fix.lat, trust) : fix.lat
    const dtSeconds = previous ? Math.max((fix.at - previous.at) / 1000, 0) : 0
    this.lastFix = { ...fix, lng: rawLng, lat: rawLat }

    const speed = this.speedOf(fix)
    const course = this.courseOf(fix, speed)

    // RAW coordinates, always. services/signal_processor.py scores route
    // adherence off this trace; posting the snapped position instead would make
    // adherence_rate 1.0 by construction and quietly poison the reward signal.
    // Only the display position below is allowed to be snapped.
    if (now - this.lastBufferAt >= MIN_BUFFER_INTERVAL_MS) {
      this.lastBufferAt = now
      this.buffer.push({ lat: rawLat, lon: rawLng, timestamp: new Date().toISOString() })
    }

    // Windowed projection around the last known segment. `this.idx` starts at 0
    // and is only meaningful once a fix has landed, so the first fix of a drive
    // (and the first after a reroute restart) does a full scan.
    const projection = projectToRoute(this.coords, this.cumulative, [rawLng, rawLat], {
      fromIndex: previous ? this.idx : undefined,
      forwardMeters: Math.max(150, speed * 3),
    })

    let lng = rawLng
    let lat = rawLat
    let progress = this.fractions[this.idx] ?? 0
    if (projection) {
      this.idx = projection.index
      progress = projection.fraction
      const target = snapConfidence({
        distanceMeters: projection.distanceMeters,
        accuracyMeters: fix.accuracyM,
        courseDeg: course,
        segmentBearing: projection.segmentBearing,
      })
      // Smoothed over time, not applied raw, so the puck slides between the road
      // and the true position instead of popping between them. The first fix has
      // no elapsed time to smooth over and adopts the target outright — easing
      // up from zero would start every drive with the puck off the road for a
      // couple of seconds, which is the exact thing being fixed.
      this.snapWeight = previous
        ? this.snapWeight + (target - this.snapWeight) * smoothFactor(dtSeconds, SNAP_TAU_S)
        : target
      lng = lerp(rawLng, projection.lng, this.snapWeight)
      lat = lerp(rawLat, projection.lat, this.snapWeight)
    }

    this.handlers.onPosition({
      lng,
      lat,
      rawLng,
      rawLat,
      courseDeg: course,
      speedMps: speed,
      accuracyM: fix.accuracyM,
      snapConfidence: projection ? this.snapWeight : 0,
      fraction: progress,
      at: now,
    })
    this.handlers.onProgress(progress)

    // Arrived: near the final coordinate AND genuinely in the route's tail —
    // the tail check stops a loop-shaped route (destination near origin) from
    // "arriving" the moment the drive starts. Measured on the raw position: the
    // question is where the car is, not where we're drawing it.
    const end = this.coords[this.coords.length - 1]
    if (
      progress >= ARRIVE_TAIL_FRACTION &&
      metersBetween([rawLng, rawLat], end) <= ARRIVE_RADIUS_M
    ) {
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

  /** Bearing of the route where the sim currently is — the sim's stand-in for
   * course over ground, and as honest as a real one since a simulated car is
   * by definition driving down the line. */
  private simCourse(): number | null {
    const i = Math.min(this.idx, this.coords.length - 2)
    if (i < 0) return null
    const [aLng, aLat] = this.coords[i]
    const [bLng, bLat] = this.coords[i + 1]
    const kLng = 111_320 * Math.cos((aLat * Math.PI) / 180)
    const east = (bLng - aLng) * kLng
    const north = (bLat - aLat) * 110_540
    if (east === 0 && north === 0) return null
    return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360
  }

  /**
   * Scatter a position by `jitterMeters`, dev-flag only.
   *
   * Box-Muller rather than a uniform offset because GPS error is Gaussian-ish,
   * and the confidence gate is tuned against a distribution with a tail — a
   * uniform box would never produce the occasional far outlier that the gate
   * exists to reject.
   */
  private jitter(lng: number, lat: number, meters: number): [number, number] {
    const r = Math.sqrt(-2 * Math.log(1 - Math.random())) * meters
    const theta = 2 * Math.PI * Math.random()
    const kLng = 111_320 * Math.cos((lat * Math.PI) / 180)
    return [lng + (r * Math.cos(theta)) / kLng, lat + (r * Math.sin(theta)) / 110_540]
  }

  private tick(): void {
    if (this.done) return
    const multiplier = this.sim.speedMultiplier?.() ?? 1
    const speed = this.speedAt(this.simMeters)
    const advance = speed * multiplier * (TICK_MS / 1000)
    this.simMeters = Math.min(this.simMeters + advance, this.totalMeters)

    // Forward walk rather than a search: the cursor only moves ahead, and each
    // tick covers a handful of points at most.
    while (
      this.idx < this.coords.length - 1 &&
      this.cumulative[this.idx + 1] <= this.simMeters
    ) {
      this.idx += 1
    }

    const [trueLng, trueLat] = pointAtMeters(this.coords, this.cumulative, this.simMeters)
    // The true driven fraction, not fractions[idx] — the sim knows exactly how
    // far it has gone, so there is no reason to round it to a shape point.
    const progress = this.totalMeters > 0 ? this.simMeters / this.totalMeters : 0
    const course = this.simCourse()

    const jitterMeters = this.sim.jitterMeters ?? 0
    let lng = trueLng
    let lat = trueLat
    let confidence = 1
    if (jitterMeters > 0) {
      // Run the scattered position through the same projection and gate the
      // real path uses, so ?jitter= exercises the snapping rather than
      // bypassing it. This is what makes the off-road-puck bug reproducible at
      // a desk instead of only in a moving car.
      const [jLng, jLat] = this.jitter(trueLng, trueLat, jitterMeters)
      const projection = projectToRoute(this.coords, this.cumulative, [jLng, jLat], {
        fromIndex: this.idx,
        forwardMeters: Math.max(150, speed * 3),
      })
      confidence = projection
        ? snapConfidence({
            distanceMeters: projection.distanceMeters,
            accuracyMeters: jitterMeters,
            courseDeg: course,
            segmentBearing: projection.segmentBearing,
          })
        : 0
      this.snapWeight += (confidence - this.snapWeight) * smoothFactor(TICK_MS / 1000, SNAP_TAU_S)
      lng = projection ? lerp(jLng, projection.lng, this.snapWeight) : jLng
      lat = projection ? lerp(jLat, projection.lat, this.snapWeight) : jLat
      confidence = this.snapWeight
    }

    this.handlers.onPosition({
      lng,
      lat,
      // The sim buffers its TRUE position even under jitter: the noise exists to
      // test the display path, and feeding it to the backend would corrupt the
      // adherence signal with error the car never had.
      rawLng: trueLng,
      rawLat: trueLat,
      courseDeg: course,
      speedMps: speed,
      accuracyM: jitterMeters > 0 ? jitterMeters : 0,
      snapConfidence: confidence,
      fraction: progress,
      at: Date.now(),
    })
    this.handlers.onProgress(progress)
    this.buffer.push({ lat: trueLat, lon: trueLng, timestamp: new Date().toISOString() })
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
