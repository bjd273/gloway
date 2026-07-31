// The driving camera: one continuous animation loop instead of a nudge per fix.
//
// What this replaces, and why. The camera used to fire a single
// `easeTo({duration: 650})` per position update, and updates arrive about once
// a second. So the camera moved for 650ms and then sat perfectly still for
// ~350ms, over and over — rotate, stop, rotate, stop. A driver described the
// anticipatory rotation into a turn as good but "not smooth", and that dead
// gap is what they were seeing. The 650ms was itself chosen to be shorter than
// the fix interval, because overlapping eases "read as the camera drifting
// rather than tracking" — that observation was right, and it is precisely why
// the answer is not a longer ease but a loop that never stops.
//
// The loop holds a TARGET (updated whenever a fix lands) and a CURRENT state,
// and every frame moves current toward target by an exponential approach (see
// smoothing.ts). Motion is therefore continuous and independent of when fixes
// happen to arrive.
//
// ONE OWNERSHIP RULE, and it is not stylistic:
//
//   While this loop is running, nothing else may call easeTo / flyTo /
//   fitBounds / jumpTo on the map.
//
// MapLibre's `jumpTo` begins with `this.stop()` (maplibre-gl 5, Camera.jumpTo),
// which cancels any animation in flight. A per-frame jumpTo therefore kills a
// concurrent easeTo on its next frame — the drive-end fitBounds would freeze
// mid-flight. Everything else expresses itself as a change to this loop's
// target, or waits until the loop is paused.
//
// The same call also fires movestart/move/moveend every time, plus
// zoom*/rotate*/pitch* whenever those change — sixty times a second here. Any
// map event handler that does real work must be guarded while navigating; see
// the moveend guard in MapView.
import type maplibregl from 'maplibre-gl'

import { approach, approachAngle, wrap360 } from './smoothing'

/** Seconds to close 63% of the gap. ~3x that for 95%, so position settles in
 * about a second — one fix interval, deliberately. */
const TAU_POSITION_S = 0.35
/** Rotation is a touch slower than position: a camera that snaps to every
 * heading wobble is busier to read than one that leans into the turn. */
const TAU_BEARING_S = 0.45
/** Zoom, pitch and padding are framing, not tracking. Slow enough that a
 * padding change from a sheet drag reads as the frame opening up. */
const TAU_FRAMING_S = 0.8

/** A backgrounded tab resumes with dt measured in seconds. Unclamped, the
 * smoother becomes a jump — exactly the lurch this loop exists to remove. */
const MAX_FRAME_DT_S = 0.1

/** Below these deltas the camera has arrived and the loop can sleep. A phone
 * in a hot windscreen mount for 25 minutes is a real constraint, and a car
 * stopped at a light needs no frames at all. */
const SETTLED_DEGREES = 1e-7 // ~1cm
const SETTLED_BEARING = 0.05
const SETTLED_ZOOM = 0.001
const SETTLED_PITCH = 0.05
const SETTLED_PADDING = 0.5

/** How far ahead dead reckoning will extrapolate. When fixes stop — a tunnel,
 * an urban canyon — the puck FREEZES rather than confidently driving down a
 * road the car may already have left. Inventing motion during an outage is how
 * a nav app tells a confident lie. */
const MAX_DEAD_RECKON_S = 1.5

/** All four sides, always. MapLibre's own PaddingOptions makes each side
 * optional, which every consumer here would then have to defend against —
 * and a half-specified padding is not a thing this camera ever produces. */
export interface Padding {
  top: number
  bottom: number
  left: number
  right: number
}

export interface CameraTarget {
  /** Display position — already snapped/blended by DriveController. */
  lng: number
  lat: number
  /** Where the camera should face. */
  bearing: number
  /** Where the puck's arrow should point, which is not the same question. */
  puckBearing: number | null
  zoom: number
  pitch: number
  padding: Padding
  /** Metres along the route at this target, for dead reckoning. */
  routeMeters: number
  speedMps: number
  /** Whether extrapolating along the route is currently trustworthy. */
  deadReckon: boolean
}

interface CameraState {
  lng: number
  lat: number
  bearing: number
  zoom: number
  pitch: number
  padding: Padding
}

export interface DriveCameraDeps {
  map: maplibregl.Map
  /** The live-position marker. Owned by the loop so the puck and the camera
   * can never disagree by a frame. */
  puck: maplibregl.Marker
  /** Position at a distance along the route — snapToRoute.pointAtMeters bound
   * to the active geometry. Omitted disables dead reckoning. */
  pointAtMeters?: (meters: number) => [number, number]
  now?: () => number
  requestFrame?: (cb: () => void) => number
  cancelFrame?: (handle: number) => void
  prefersReducedMotion?: () => boolean
}

function samePadding(a: Padding, b: Padding): boolean {
  return (
    Math.abs(a.top - b.top) < SETTLED_PADDING &&
    Math.abs(a.bottom - b.bottom) < SETTLED_PADDING &&
    Math.abs(a.left - b.left) < SETTLED_PADDING &&
    Math.abs(a.right - b.right) < SETTLED_PADDING
  )
}

export class DriveCamera {
  private readonly deps: Required<Omit<DriveCameraDeps, 'pointAtMeters'>> &
    Pick<DriveCameraDeps, 'pointAtMeters'>
  private target: CameraTarget | null = null
  private targetAt = 0
  private current: CameraState | null = null
  private frame: number | null = null
  private lastFrameAt = 0
  private running = false

  constructor(deps: DriveCameraDeps) {
    this.deps = {
      map: deps.map,
      puck: deps.puck,
      pointAtMeters: deps.pointAtMeters,
      now: deps.now ?? (() => performance.now()),
      requestFrame: deps.requestFrame ?? ((cb) => requestAnimationFrame(cb)),
      cancelFrame: deps.cancelFrame ?? ((h) => cancelAnimationFrame(h)),
      prefersReducedMotion:
        deps.prefersReducedMotion ??
        (() =>
          typeof window !== 'undefined' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches),
    }
  }

  /** Begin driving the camera. Seeds from the map's live transform so the first
   * frame continues from wherever the camera already is rather than jumping. */
  start(): void {
    if (this.running) return
    this.running = true
    this.reseedFromMap()
    this.lastFrameAt = this.deps.now()
    // wake() rather than schedule() so the reduced-motion path — which must
    // never schedule a frame at all — is decided in exactly one place.
    if (this.target) this.wake()
    else if (!this.deps.prefersReducedMotion()) this.schedule()
  }

  /** Stop writing to the camera but keep accepting targets, so re-arming later
   * has fresh data. Used when the driver takes the map with a gesture. */
  pause(): void {
    this.running = false
    this.cancel()
  }

  /** End the loop and release the puck. MUST be called BEFORE any easeTo or
   * fitBounds the caller wants to survive — one stray frame after that
   * animation starts would cancel it via jumpTo's internal stop(). */
  stop(): void {
    this.running = false
    this.cancel()
    this.target = null
    this.current = null
    this.deps.puck.remove()
  }

  /** Re-read the map's transform as the loop's current state. Needed after any
   * camera motion the loop did not perform (a recenter ease, a user gesture). */
  reseedFromMap(): void {
    const map = this.deps.map
    const centre = map.getCenter()
    this.current = {
      lng: centre.lng,
      lat: centre.lat,
      bearing: wrap360(map.getBearing()),
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      padding: this.target?.padding ?? { top: 0, bottom: 0, left: 0, right: 0 },
    }
  }

  setTarget(target: CameraTarget): void {
    this.target = target
    this.targetAt = this.deps.now()
    this.wake()
  }

  /** Change only the framing padding — a sheet drag, a banner appearing. */
  setPadding(padding: Padding): void {
    if (!this.target) return
    this.target = { ...this.target, padding }
    this.wake()
  }

  get isRunning(): boolean {
    return this.running
  }

  private cancel(): void {
    if (this.frame !== null) {
      this.deps.cancelFrame(this.frame)
      this.frame = null
    }
  }

  private schedule(): void {
    if (!this.running || this.frame !== null) return
    this.frame = this.deps.requestFrame(() => {
      this.frame = null
      this.tick()
    })
  }

  /**
   * A target arrived while the loop was asleep, or reduced motion is on.
   *
   * Under reduced motion there is no loop at all: continuous camera motion IS
   * the animation, so smoothing it is not an accessibility improvement over not
   * animating it. MapLibre's own easeTo already collapses to a jump for these
   * users, so one write per target preserves exactly the behaviour they had.
   */
  private wake(): void {
    if (!this.running || !this.target) return
    if (this.deps.prefersReducedMotion()) {
      this.current = {
        lng: this.target.lng,
        lat: this.target.lat,
        bearing: this.target.bearing,
        zoom: this.target.zoom,
        pitch: this.target.pitch,
        padding: this.target.padding,
      }
      this.write()
      return
    }
    this.lastFrameAt = this.deps.now()
    this.schedule()
  }

  /**
   * Where the target has got to since the fix that produced it.
   *
   * Extrapolates ALONG THE ROUTE, not along the heading vector: a heading
   * vector flings the puck into the shrubbery on every bend, which would trade
   * the jerky-camera problem for a worse version of the off-road-puck problem.
   * Capped, and only while the snap is trustworthy — an off-route driver gets no
   * route-flavoured extrapolation at all.
   */
  private deadReckoned(now: number): { lng: number; lat: number } {
    const target = this.target!
    const advance = this.deps.pointAtMeters
    if (!advance || !target.deadReckon || target.speedMps <= 0) {
      return { lng: target.lng, lat: target.lat }
    }
    const elapsed = Math.min((now - this.targetAt) / 1000, MAX_DEAD_RECKON_S)
    if (elapsed <= 0) return { lng: target.lng, lat: target.lat }
    const [lng, lat] = advance(target.routeMeters + target.speedMps * elapsed)
    return { lng, lat }
  }

  private settled(goal: { lng: number; lat: number }): boolean {
    const c = this.current!
    const t = this.target!
    return (
      Math.abs(goal.lng - c.lng) < SETTLED_DEGREES &&
      Math.abs(goal.lat - c.lat) < SETTLED_DEGREES &&
      Math.abs(((t.bearing - c.bearing + 540) % 360) - 180) < SETTLED_BEARING &&
      Math.abs(t.zoom - c.zoom) < SETTLED_ZOOM &&
      Math.abs(t.pitch - c.pitch) < SETTLED_PITCH &&
      samePadding(t.padding, c.padding)
    )
  }

  private tick(): void {
    if (!this.running || !this.target || !this.current) return
    const now = this.deps.now()
    const dt = Math.min((now - this.lastFrameAt) / 1000, MAX_FRAME_DT_S)
    this.lastFrameAt = now

    const target = this.target
    const current = this.current
    const goal = this.deadReckoned(now)

    // Longitude is interpolated linearly in degrees, with no antimeridian
    // handling: MAP_MAX_BOUNDS locks this app to one metro area. Anywhere that
    // could cross 180 would need the shortest-arc treatment bearings get.
    current.lng = approach(current.lng, goal.lng, dt, TAU_POSITION_S)
    current.lat = approach(current.lat, goal.lat, dt, TAU_POSITION_S)
    current.bearing = approachAngle(current.bearing, target.bearing, dt, TAU_BEARING_S)
    current.zoom = approach(current.zoom, target.zoom, dt, TAU_FRAMING_S)
    current.pitch = approach(current.pitch, target.pitch, dt, TAU_FRAMING_S)
    current.padding = {
      top: approach(current.padding.top, target.padding.top, dt, TAU_FRAMING_S),
      bottom: approach(current.padding.bottom, target.padding.bottom, dt, TAU_FRAMING_S),
      left: approach(current.padding.left, target.padding.left, dt, TAU_FRAMING_S),
      right: approach(current.padding.right, target.padding.right, dt, TAU_FRAMING_S),
    }

    // Sleep once there is nothing left to move toward AND nothing is
    // extrapolating. Woken by the next setTarget/setPadding.
    //
    // The last frame lands exactly on the target rather than within the settle
    // epsilon of it: an exponential approach never truly arrives, so sleeping
    // on "close enough" would leave a permanent sub-pixel offset that the next
    // wake would inherit. Snapping here costs nothing — the remaining gap is by
    // definition under a centimetre and a twentieth of a degree.
    const done = !target.deadReckon && this.settled(goal)
    if (done) {
      current.lng = goal.lng
      current.lat = goal.lat
      current.bearing = wrap360(target.bearing)
      current.zoom = target.zoom
      current.pitch = target.pitch
      current.padding = { ...target.padding }
    }

    this.write()
    if (done) return
    this.schedule()
  }

  private write(): void {
    const { map, puck } = this.deps
    const c = this.current!
    const t = this.target!
    // Puck first: jumpTo's 'move' event is what repositions markers, so setting
    // the marker after it would leave the puck one frame behind the map.
    puck.setLngLat([c.lng, c.lat])
    puck.getElement().classList.toggle('gw-puck-heading', t.puckBearing !== null)
    puck.setRotation(t.puckBearing ?? 0)
    // One combined write. setCenter/setBearing are each a jumpTo of their own,
    // so calling them separately would triple the event burst.
    map.jumpTo({
      center: [c.lng, c.lat],
      bearing: c.bearing,
      zoom: c.zoom,
      pitch: c.pitch,
      padding: c.padding,
    })
  }
}
