// DriveController tests — the repo's first frontend tests, established here
// because real GPS is the linchpin of the learning loop: every fix must reach
// /gps-update or a real drive produces no trace to learn from.
//
// The geolocation source is injected (GeolocationLike) so tests feed
// synthetic watchPosition-shaped fixes; streamGpsPoints is mocked so we can
// assert on exactly what would hit the backend.
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
 * ~110m apart (0.001° lng at this latitude ≈ 94m — close enough). */
const ROUTE: [number, number][] = Array.from({ length: 11 }, (_, i) => [
  -97.13 + i * 0.001,
  32.72,
])

/** Fake watchPosition: captures the callbacks, exposes emit()/fail(). */
class FakeGeo implements GeolocationLike {
  onFix: ((pos: { coords: { latitude: number; longitude: number } }) => void) | null = null
  onError: ((err: { code: number; message: string }) => void) | null = null
  cleared: number[] = []

  watchPosition(
    onFix: (pos: { coords: { latitude: number; longitude: number } }) => void,
    onError: (err: { code: number; message: string }) => void,
  ): number {
    this.onFix = onFix
    this.onError = onError
    return 42
  }

  clearWatch(id: number): void {
    this.cleared.push(id)
  }

  emit(lat: number, lng: number): void {
    this.onFix?.({ coords: { latitude: lat, longitude: lng } })
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
  }
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

    // Three fixes a second apart (the throttle floor).
    geo.emit(32.72, -97.13)
    vi.advanceTimersByTime(1100)
    geo.emit(32.72, -97.128)
    vi.advanceTimersByTime(1100)
    geo.emit(32.7205, -97.126) // slightly off the line — still a valid fix

    expect(handlers.onPosition).toHaveBeenCalledTimes(3)

    // The 3s flush timer sends everything buffered so far in one batch.
    await vi.advanceTimersByTimeAsync(3000)
    expect(flushed.batches).toHaveLength(1)
    expect(flushed.batches[0]).toHaveLength(3)
    expect(flushed.batches[0][0]).toMatchObject({ lat: 32.72, lon: -97.13 })
    expect(flushed.batches[0][0].timestamp).toBeTruthy()

    controller.stop()
  })

  // Progress is a fraction of route LENGTH, summed segment by segment, so it
  // lands a few ulps off the round number this evenly-spaced fixture implies
  // (0.49999999999928946 for the midpoint). closeTo, not exact equality: the
  // sum is the honest measure and chasing exactness here would only mean
  // rounding the value the map's `line-progress` consumes.
  it('derives progress from nearest-point projection, not elapsed time', () => {
    const geo = new FakeGeo()
    const handlers = makeHandlers()
    new DriveController('trip-2', ROUTE, handlers, 'real', geo).start()

    // A fix right at the route's midpoint => progress 0.5, immediately.
    geo.emit(32.72, -97.125)
    expect(handlers.onProgress).toHaveBeenLastCalledWith(expect.closeTo(0.5, 6))

    // A later fix that has NOT advanced (driver deviated sideways) parks
    // progress at the nearest on-route point rather than inventing motion.
    vi.advanceTimersByTime(1100)
    geo.emit(32.7235, -97.125) // ~390m north of the same midpoint
    expect(handlers.onProgress).toHaveBeenLastCalledWith(expect.closeTo(0.5, 6))
  })

  it('resumes mid-route after a reroute restart (fix lands at the right progress)', () => {
    // Simulates the reroute case: a NEW controller (fresh route) starting
    // while the driver is already 70% along — the first fix must project to
    // ~0.7, not restart the drive at 0.
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

    geo.emit(32.72, -97.1215) // ~85% along — inside tail but ~50m+ from the end
    expect(handlers.onArrive).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1100)
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
    geo.emit(32.72, -97.128)

    // Nothing has been flushed yet — the 3s timer hasn't fired.
    expect(flushed.batches).toHaveLength(0)

    // Awaiting stop() is what lets TripPanel complete the trip knowing the
    // server has the whole trace ("Done driving?" used to skip this entirely).
    await controller.stop()
    expect(flushed.batches.flat()).toHaveLength(2)
  })

  it('throttles fix bursts to one per second', () => {
    const geo = new FakeGeo()
    const handlers = makeHandlers()
    new DriveController('trip-5', ROUTE, handlers, 'real', geo).start()

    geo.emit(32.72, -97.13)
    geo.emit(32.72, -97.1299) // 10ms later in fake time — dropped
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
})

describe('DriveController sim mode', () => {
  it('still walks the route on a timer and flushes batches (dev fallback)', async () => {
    const handlers = makeHandlers()
    const controller = new DriveController('trip-7', ROUTE, handlers, 'sim', null)
    controller.start()

    await vi.advanceTimersByTimeAsync(3200) // 4 ticks @800ms + one 3s flush
    expect(handlers.onPosition).toHaveBeenCalled()
    expect(flushed.batches.length).toBeGreaterThan(0)

    await vi.advanceTimersByTimeAsync(10_000) // sim finishes any route fast
    expect(handlers.onArrive).toHaveBeenCalledTimes(1)
    controller.stop()
  })
})
