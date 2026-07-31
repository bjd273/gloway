// DriveController tests — the repo's first frontend tests, established here
// because real GPS is the linchpin of the learning loop: every fix must reach
// /gps-update or a real drive produces no trace to learn from.
//
// The geolocation source is injected (GeolocationLike) so tests feed
// synthetic watchPosition-shaped fixes; streamGpsPoints is mocked so we can
// assert on exactly what would hit the backend.
//
// Fixes here move at plausible car speeds. That is a requirement now, not a
// nicety: the controller rejects a fix implying more than ~134 mph as a
// teleport, so a fixture that jumped 190m between fixes a second apart (425
// mph) would be silently discarded — which is exactly what it should do.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DriveController, type GeolocationLike } from './navigation'

const flushed = vi.hoisted(() => ({
  batches: [] as { lat: number; lon: number; timestamp: string }[][],
}))

vi.mock('./api', () => ({
  streamGpsPoints: vi.fn(async (_tripId: string, pts: never[]) => {
    flushed.batches.push(pts)
  }),
}))

/** A straight ~1.1km west→east route near the Arlington extract: 11 points,
 * ~94m apart (0.001° lng at this latitude). */
const ROUTE: [number, number][] = Array.from({ length: 11 }, (_, i) => [
  -97.13 + i * 0.001,
  32.72,
])

/** Longitude delta for a given eastward distance at the fixture's latitude. */
const lngFor = (meters: number) => meters / (111_320 * Math.cos((32.72 * Math.PI) / 180))
/** Latitude delta for a northward distance. */
const latFor = (meters: number) => meters / 110_540

interface FixOptions {
  accuracy?: number
  heading?: number | null
  speed?: number | null
}

/** Fake watchPosition: captures the callbacks, exposes emit()/fail(). */
class FakeGeo implements GeolocationLike {
  onFix:
    | ((pos: {
        coords: {
          latitude: number
          longitude: number
          accuracy?: number
          heading?: number | null
          speed?: number | null
        }
        timestamp?: number
      }) => void)
    | null = null
  onError: ((err: { code: number; message: string }) => void) | null = null
  cleared: number[] = []

  watchPosition(
    onFix: NonNullable<FakeGeo['onFix']>,
    onError: (err: { code: number; message: string }) => void,
  ): number {
    this.onFix = onFix
    this.onError = onError
    return 42
  }

  clearWatch(id: number): void {
    this.cleared.push(id)
  }

  emit(lat: number, lng: number, opts: FixOptions = {}): void {
    this.onFix?.({
      coords: { latitude: lat, longitude: lng, ...opts },
      timestamp: Date.now(),
    })
  }

  fail(code: number): void {
    this.onError?.({ code, message: 'fake' })
  }
}

function makeHandlers() {
  return {
    onPosition: vi.fn(),
    onProgress: vi.fn(),
    onArrive: vi.fn(),
    onGpsError: vi.fn(),
    onGpsSignal: vi.fn(),
  }
}

/** Last DrivePosition handed to onPosition. */
function lastPosition(handlers: ReturnType<typeof makeHandlers>) {
  return handlers.onPosition.mock.lastCall![0]
}

beforeEach(() => {
  vi.useFakeTimers()
  flushed.batches = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DriveController real mode', () => {
  it('streams watchPosition fixes to the backend through the batch pipeline', async () => {
    const geo = new FakeGeo()
    const handlers = makeHandlers()
    const controller = new DriveController('trip-1', ROUTE, handlers, 'real', geo)
    controller.start()

    // Three fixes a second apart, ~28m of travel each (~63 mph).
    geo.emit(32.72, -97.13)
    vi.advanceTimersByTime(1100)
    geo.emit(32.72, -97.13 + lngFor(28))
    vi.advanceTimersByTime(1100)
    geo.emit(32.72 + latFor(5), -97.13 + lngFor(56)) // slightly off the line

    expect(handlers.onPosition).toHaveBeenCalledTimes(3)

    // The 3s flush timer sends everything buffered so far in one batch.
    await vi.advanceTimersByTimeAsync(3000)
    expect(flushed.batches).toHaveLength(1)
    expect(flushed.batches[0]).toHaveLength(3)
    expect(flushed.batches[0][0]).toMatchObject({ lat: 32.72, lon: -97.13 })
    expect(flushed.batches[0][0].timestamp).toBeTruthy()

    void controller.stop()
  })

  // Progress is a fraction of route LENGTH, summed segment by segment, so it
  // lands a few ulps off the round number this evenly-spaced fixture implies.
  // closeTo, not exact equality: the sum is the honest measure and chasing
  // exactness here would only mean rounding the value `line-progress` consumes.
  it('derives progress from the perpendicular projection, not elapsed time', () => {
    const geo = new FakeGeo()
    const handlers = makeHandlers()
    new DriveController('trip-2', ROUTE, handlers, 'real', geo).start()

    // A fix right at the route's midpoint => progress 0.5, immediately.
    geo.emit(32.72, -97.125)
    expect(handlers.onProgress).toHaveBeenLastCalledWith(expect.closeTo(0.5, 6))

    // A later fix that has NOT advanced (driver deviated sideways) parks
    // progress at the projection rather than inventing motion.
    vi.advanceTimersByTime(20_000) // 390m sideways at a believable speed
    geo.emit(32.72 + latFor(390), -97.125)
    expect(handlers.onProgress).toHaveBeenLastCalledWith(expect.closeTo(0.5, 6))
  })

  it('reports progress between shape points, not rounded to one', () => {
    // The defect this replaced: nearest-SHAPE-POINT progress quantised to
    // Valhalla's spacing — 94m in this fixture, 100m+ on a real straight — so
    // the turn countdown ticked in 100m steps rather than counting down.
    const geo = new FakeGeo()
    const handlers = makeHandlers()
    new DriveController('trip-2b', ROUTE, handlers, 'real', geo).start()

    geo.emit(32.72, -97.13 + lngFor(47)) // exactly half a segment along
    const fraction = handlers.onProgress.mock.lastCall![0]
    expect(fraction).toBeGreaterThan(0.04)
    expect(fraction).toBeLessThan(0.06)
  })

  it('resumes mid-route after a reroute restart (fix lands at the right progress)', () => {
    // Simulates the reroute case: a NEW controller (fresh route) starting
    // while the driver is already 70% along — the first fix must project to
    // ~0.7, not restart the drive at 0. This is why the first fix of a drive
    // scans the whole line instead of a window around index 0.
    const geo = new FakeGeo()
    const handlers = makeHandlers()
    new DriveController('trip-3', ROUTE, handlers, 'real', geo).start()

    geo.emit(32.72, -97.123) // at coords[7] of 0..10
    expect(handlers.onProgress).toHaveBeenLastCalledWith(expect.closeTo(0.7, 6))
    expect(handlers.onArrive).not.toHaveBeenCalled()
  })

  it('arrives only near the final coordinate, and not before the tail flush', async () => {
    const geo = new FakeGeo()
    const handlers = makeHandlers()
    new DriveController('trip-4', ROUTE, handlers, 'real', geo).start()

    geo.emit(32.72, -97.1215) // ~85% along — inside tail but ~140m from the end
    expect(handlers.onArrive).not.toHaveBeenCalled()

    vi.advanceTimersByTime(5000) // 140m at ~28m/s
    geo.emit(32.72, -97.12) // exactly the final coordinate
    expect(geo.cleared).toContain(42) // watch released immediately

    // Ordering is load-bearing, not incidental: onArrive triggers POST
    // /complete, which scores route adherence against whatever GPS has reached
    // the server. Announcing arrival before the tail flush landed is what left
    // `implicit` null on every trip in the database — the trip was completed
    // and scored while its last points were still in flight.
    expect(handlers.onArrive).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(0)
    expect(flushed.batches.flat().length).toBeGreaterThan(0)
    expect(handlers.onArrive).toHaveBeenCalledTimes(1)
  })

  it('stop() resolves only after the final batch is sent', async () => {
    const geo = new FakeGeo()
    const handlers = makeHandlers()
    const controller = new DriveController('trip-8', ROUTE, handlers, 'real', geo)
    controller.start()

    geo.emit(32.72, -97.13)
    vi.advanceTimersByTime(1100)
    geo.emit(32.72, -97.13 + lngFor(28))

    // Nothing has been flushed yet — the 3s timer hasn't fired.
    expect(flushed.batches).toHaveLength(0)

    // Awaiting stop() is what lets TripPanel complete the trip knowing the
    // server has the whole trace ("Done driving?" used to skip this entirely).
    await controller.stop()
    expect(flushed.batches.flat()).toHaveLength(2)
  })

  it('throttles the backend batch to ~1Hz while still animating every fix', async () => {
    // These used to be one gate, and it dropped the extra fixes outright: a
    // device capable of better than 1Hz had them thrown away and the camera had
    // less to work with. Now the batch rate is capped and the screen is not.
    const geo = new FakeGeo()
    const handlers = makeHandlers()
    const controller = new DriveController('trip-5', ROUTE, handlers, 'real', geo)
    controller.start()

    geo.emit(32.72, -97.13)
    vi.advanceTimersByTime(200)
    geo.emit(32.72, -97.13 + lngFor(6))
    vi.advanceTimersByTime(200)
    geo.emit(32.72, -97.13 + lngFor(12))

    expect(handlers.onPosition).toHaveBeenCalledTimes(3)
    await controller.stop()
    expect(flushed.batches.flat()).toHaveLength(1) // only the first crossed 1Hz
  })

  it('ignores a burst of fixes at the same instant', () => {
    const geo = new FakeGeo()
    const handlers = makeHandlers()
    new DriveController('trip-5b', ROUTE, handlers, 'real', geo).start()

    geo.emit(32.72, -97.13)
    geo.emit(32.72, -97.1299)
    geo.emit(32.72, -97.1298)
    expect(handlers.onPosition).toHaveBeenCalledTimes(1)
  })

  it('surfaces permission denial through onGpsError and stops', () => {
    const geo = new FakeGeo()
    const handlers = makeHandlers()
    new DriveController('trip-6', ROUTE, handlers, 'real', geo).start()

    geo.fail(1) // PERMISSION_DENIED
    expect(handlers.onGpsError).toHaveBeenCalledWith(expect.stringContaining('permission'))
    expect(handlers.onArrive).not.toHaveBeenCalled()
    expect(geo.cleared).toContain(42)
  })

  describe('transient GPS loss', () => {
    it('does not end the drive on a timeout', () => {
      // With timeout: 20_000 this used to kill a live drive after twenty
      // seconds in a tunnel. watchPosition keeps retrying on its own, so the
      // right response is to say the signal is lost and wait.
      const geo = new FakeGeo()
      const handlers = makeHandlers()
      new DriveController('trip-7', ROUTE, handlers, 'real', geo).start()

      geo.emit(32.72, -97.13)
      geo.fail(3) // TIMEOUT

      expect(handlers.onGpsError).not.toHaveBeenCalled()
      expect(handlers.onGpsSignal).toHaveBeenCalledWith(true)
      expect(geo.cleared).not.toContain(42) // watch still live
    })

    it('recovers on the next good fix', () => {
      const geo = new FakeGeo()
      const handlers = makeHandlers()
      new DriveController('trip-7b', ROUTE, handlers, 'real', geo).start()

      geo.emit(32.72, -97.13)
      geo.fail(2) // POSITION_UNAVAILABLE
      vi.advanceTimersByTime(1100)
      geo.emit(32.72, -97.13 + lngFor(28))

      expect(handlers.onGpsSignal).toHaveBeenLastCalledWith(false)
    })

    it('reports the outage once, not on every failed attempt', () => {
      const geo = new FakeGeo()
      const handlers = makeHandlers()
      new DriveController('trip-7c', ROUTE, handlers, 'real', geo).start()

      geo.fail(3)
      geo.fail(3)
      geo.fail(3)
      expect(handlers.onGpsSignal).toHaveBeenCalledTimes(1)
    })
  })

  describe('fix quality', () => {
    it('drops a cell-tower-grade fix rather than teleporting the puck', () => {
      const geo = new FakeGeo()
      const handlers = makeHandlers()
      new DriveController('trip-9', ROUTE, handlers, 'real', geo).start()

      geo.emit(32.72, -97.13, { accuracy: 5 })
      vi.advanceTimersByTime(1100)
      geo.emit(32.72, -97.126, { accuracy: 400 })

      expect(handlers.onPosition).toHaveBeenCalledTimes(1)
    })

    it('drops a fix implying an impossible speed', () => {
      const geo = new FakeGeo()
      const handlers = makeHandlers()
      new DriveController('trip-10', ROUTE, handlers, 'real', geo).start()

      geo.emit(32.72, -97.13, { accuracy: 5 })
      vi.advanceTimersByTime(1100)
      geo.emit(32.72, -97.12, { accuracy: 5 }) // ~940m in 1.1s

      expect(handlers.onPosition).toHaveBeenCalledTimes(1)
    })

    it('damps a middling-accuracy fix instead of trusting or dropping it', () => {
      const geo = new FakeGeo()
      const handlers = makeHandlers()
      new DriveController('trip-11', ROUTE, handlers, 'real', geo).start()

      geo.emit(32.72, -97.13, { accuracy: 5 })
      vi.advanceTimersByTime(1100)
      const target = -97.13 + lngFor(28)
      geo.emit(32.72, target, { accuracy: 70 })

      const { rawLng } = lastPosition(handlers)
      expect(rawLng).toBeGreaterThan(-97.13)
      expect(rawLng).toBeLessThan(target) // pulled part of the way, not all
    })
  })

  describe('snapping', () => {
    it('draws the puck on the road but records the raw fix', () => {
      // The reported bug: an outer-lane fix put the puck beside the road, which
      // reads as "the app thinks I'm going the wrong way". The invariant that
      // makes fixing it safe is that /gps-update still gets the truth —
      // signal_processor.py scores adherence off that trace, and posting
      // snapped points would make adherence 1.0 by construction.
      const geo = new FakeGeo()
      const handlers = makeHandlers()
      new DriveController('trip-12', ROUTE, handlers, 'real', geo).start()

      // Two lanes off the centreline, heading along the road.
      geo.emit(32.72 + latFor(9), -97.126, { accuracy: 6, heading: 90, speed: 20 })

      const p = lastPosition(handlers)
      expect(p.rawLat).toBeCloseTo(32.72 + latFor(9), 9)
      expect(p.snapConfidence).toBeGreaterThan(0)
      expect(Math.abs(p.lat - 32.72)).toBeLessThan(Math.abs(p.rawLat - 32.72))
    })

    it('releases the puck when the driver genuinely leaves the route', () => {
      const geo = new FakeGeo()
      const handlers = makeHandlers()
      new DriveController('trip-13', ROUTE, handlers, 'real', geo).start()

      // Establish a confident on-route position first.
      geo.emit(32.72, -97.126, { accuracy: 5, heading: 90, speed: 20 })
      // Then drive away from the route for several seconds.
      for (let i = 1; i <= 6; i += 1) {
        vi.advanceTimersByTime(1100)
        geo.emit(32.72 + latFor(i * 22), -97.126, { accuracy: 5, heading: 0, speed: 20 })
      }

      const p = lastPosition(handlers)
      expect(p.snapConfidence).toBeLessThan(0.05)
      expect(p.lat).toBeCloseTo(p.rawLat, 6) // drawn where the car actually is
    })

    it('refuses to snap to a road pointing the opposite way', () => {
      const geo = new FakeGeo()
      const handlers = makeHandlers()
      new DriveController('trip-14', ROUTE, handlers, 'real', geo).start()

      // On the line, but travelling west down an eastbound route: the divided-
      // highway case, where snapping would put the puck on the wrong carriageway.
      geo.emit(32.72 + latFor(8), -97.126, { accuracy: 5, heading: 270, speed: 20 })
      expect(lastPosition(handlers).snapConfidence).toBe(0)
    })
  })

  describe('heading', () => {
    it('uses course over ground once the car is moving', () => {
      const geo = new FakeGeo()
      const handlers = makeHandlers()
      new DriveController('trip-15', ROUTE, handlers, 'real', geo).start()

      geo.emit(32.72, -97.126, { accuracy: 5, heading: 87, speed: 18 })
      expect(lastPosition(handlers).courseDeg).toBe(87)
    })

    it('reports no course below the moving threshold', () => {
      const geo = new FakeGeo()
      const handlers = makeHandlers()
      new DriveController('trip-16', ROUTE, handlers, 'real', geo).start()

      geo.emit(32.72, -97.126, { accuracy: 5, heading: 87, speed: 0.4 })
      expect(lastPosition(handlers).courseDeg).toBeNull()
    })

    it('holds the last course while stopped rather than spinning the arrow', () => {
      const geo = new FakeGeo()
      const handlers = makeHandlers()
      new DriveController('trip-17', ROUTE, handlers, 'real', geo).start()

      geo.emit(32.72, -97.126, { accuracy: 5, heading: 87, speed: 18 })
      vi.advanceTimersByTime(1100)
      geo.emit(32.72, -97.126, { accuracy: 5, heading: 315, speed: 0 }) // at a light
      expect(lastPosition(handlers).courseDeg).toBe(87)
    })

    it('does not flap across the moving threshold', () => {
      // The ~1 m/s dead band: creeping in traffic must not toggle the arrow on
      // and off with every fix.
      const geo = new FakeGeo()
      const handlers = makeHandlers()
      new DriveController('trip-18', ROUTE, handlers, 'real', geo).start()

      geo.emit(32.72, -97.126, { accuracy: 5, heading: 90, speed: 3 }) // moving
      vi.advanceTimersByTime(1100)
      geo.emit(32.72, -97.1259, { accuracy: 5, heading: 92, speed: 1.6 }) // in the band
      expect(lastPosition(handlers).courseDeg).toBe(92) // still trusted
    })

    it('ignores a course from a fix too vague to have one', () => {
      const geo = new FakeGeo()
      const handlers = makeHandlers()
      new DriveController('trip-19', ROUTE, handlers, 'real', geo).start()

      geo.emit(32.72, -97.126, { accuracy: 80, heading: 87, speed: 18 })
      expect(lastPosition(handlers).courseDeg).toBeNull()
    })
  })
})

describe('DriveController sim mode', () => {
  it('fills the same fields a real fix does', () => {
    // Sim is only an honest stand-in if everything downstream sees the same
    // shape — otherwise ?sim=1 exercises a different code path than a drive.
    const handlers = makeHandlers()
    const controller = new DriveController('trip-20', ROUTE, handlers, 'sim', null, {
      metersPerSecond: 20,
    })
    controller.start()
    vi.advanceTimersByTime(800)

    const p = lastPosition(handlers)
    expect(p.speedMps).toBeGreaterThan(0)
    expect(p.courseDeg).toBeCloseTo(90, 0) // the fixture runs due east
    expect(p.snapConfidence).toBe(1)
    expect(p.rawLng).toBeCloseTo(p.lng, 9) // no jitter: raw and display agree
    void controller.stop()
  })

  it('scatters the display position under ?jitter= but records the truth', () => {
    // What makes the off-road-puck bug reproducible at a desk. The noise must
    // never reach the backend, or it would corrupt the adherence signal with
    // error the simulated car never had.
    const handlers = makeHandlers()
    const controller = new DriveController('trip-21', ROUTE, handlers, 'sim', null, {
      metersPerSecond: 20,
      jitterMeters: 12,
    })
    controller.start()
    vi.advanceTimersByTime(800)

    const p = lastPosition(handlers)
    expect(p.rawLat).toBeCloseTo(32.72, 9) // the true position, on the line
    expect(p.accuracyM).toBe(12)
    void controller.stop()
  })
})
