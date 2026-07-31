// DriveCamera against a fake map and a hand-cranked frame clock.
//
// The properties worth pinning are the ones that are invisible from the call
// site and expensive to rediscover: that the loop stops writing when told (a
// running loop's jumpTo cancels any easeTo, so the drive-end fitBounds depends
// on this), that bearings take the short way, and that reduced motion is one
// write per target rather than an animation.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { type CameraTarget, DriveCamera, type Padding } from './driveCamera'

const PADDING: Padding = { top: 100, bottom: 40, left: 24, right: 24 }

interface Jump {
  center: [number, number]
  bearing: number
  zoom: number
  pitch: number
  padding: Padding
}

/** Records jumpTo calls and answers the getters start()/reseedFromMap() use. */
class FakeMap {
  jumps: Jump[] = []
  private centre = { lng: -97.13, lat: 32.72 }
  private bearing = 0
  private zoom = 14
  private pitch = 0

  jumpTo(options: Jump): void {
    this.jumps.push({ ...options, padding: { ...options.padding } })
    this.centre = { lng: options.center[0], lat: options.center[1] }
    this.bearing = options.bearing
    this.zoom = options.zoom
    this.pitch = options.pitch
  }

  getCenter() {
    return this.centre
  }
  getBearing() {
    return this.bearing
  }
  getZoom() {
    return this.zoom
  }
  getPitch() {
    return this.pitch
  }

  get last(): Jump | undefined {
    return this.jumps[this.jumps.length - 1]
  }
}

class FakeMarker {
  lngLat: [number, number] = [0, 0]
  rotation = 0
  removed = false
  private readonly el = { classList: { toggle: vi.fn() } }

  setLngLat(v: [number, number]) {
    this.lngLat = v
    return this
  }
  setRotation(v: number) {
    this.rotation = v
    return this
  }
  getElement() {
    return this.el as unknown as HTMLElement
  }
  remove() {
    this.removed = true
    return this
  }
}

/** Hand-cranked rAF: frames only advance when the test says so. */
class FrameClock {
  time = 0
  private queue = new Map<number, () => void>()
  private next = 1

  request = (cb: () => void): number => {
    const handle = this.next++
    this.queue.set(handle, cb)
    return handle
  }
  cancel = (handle: number): void => {
    this.queue.delete(handle)
  }
  now = (): number => this.time

  /** Advance one frame at 60fps and run whatever was scheduled. */
  step(ms = 16.7): void {
    this.time += ms
    const pending = [...this.queue.values()]
    this.queue.clear()
    for (const cb of pending) cb()
  }

  run(frames: number, ms = 16.7): void {
    for (let i = 0; i < frames; i += 1) this.step(ms)
  }

  get pending(): number {
    return this.queue.size
  }
}

function target(overrides: Partial<CameraTarget> = {}): CameraTarget {
  return {
    lng: -97.12,
    lat: 32.72,
    bearing: 90,
    puckBearing: 90,
    zoom: 16.8,
    pitch: 55,
    padding: PADDING,
    routeMeters: 0,
    speedMps: 0,
    deadReckon: false,
    ...overrides,
  }
}

let map: FakeMap
let puck: FakeMarker
let clock: FrameClock

function makeCamera(extra: Partial<ConstructorParameters<typeof DriveCamera>[0]> = {}) {
  return new DriveCamera({
    map: map as never,
    puck: puck as never,
    now: clock.now,
    requestFrame: clock.request,
    cancelFrame: clock.cancel,
    prefersReducedMotion: () => false,
    ...extra,
  })
}

beforeEach(() => {
  map = new FakeMap()
  puck = new FakeMarker()
  clock = new FrameClock()
})

describe('DriveCamera', () => {
  it('writes nothing before it is started', () => {
    const camera = makeCamera()
    camera.setTarget(target())
    clock.run(10)
    expect(map.jumps).toHaveLength(0)
  })

  it('moves toward the target over successive frames', () => {
    const camera = makeCamera()
    camera.start()
    camera.setTarget(target())
    clock.run(5)

    expect(map.jumps.length).toBeGreaterThan(3)
    const [first, second] = map.jumps
    // Each frame is a step toward the target, not a jump onto it — the whole
    // point of the loop over a per-fix easeTo.
    expect(first.center[0]).toBeGreaterThan(-97.13)
    expect(first.center[0]).toBeLessThan(-97.12)
    expect(second.center[0]).toBeGreaterThan(first.center[0])
  })

  it('converges on the target and then sleeps', () => {
    const camera = makeCamera()
    camera.start()
    camera.setTarget(target())
    clock.run(400)

    const last = map.last!
    expect(last.center[0]).toBeCloseTo(-97.12, 6)
    expect(last.bearing).toBeCloseTo(90, 2)
    expect(last.zoom).toBeCloseTo(16.8, 3)
    // Settle-and-sleep: a stationary car in a hot windscreen mount should not
    // be paying for 60 frames a second.
    expect(clock.pending).toBe(0)
  })

  it('wakes again when a new target arrives', () => {
    const camera = makeCamera()
    camera.start()
    camera.setTarget(target())
    clock.run(400)
    const settled = map.jumps.length

    camera.setTarget(target({ lng: -97.11 }))
    clock.run(10)
    expect(map.jumps.length).toBeGreaterThan(settled)
  })

  it('takes the short way round north', () => {
    const camera = makeCamera()
    map.jumpTo({ center: [-97.13, 32.72], bearing: 350, zoom: 16.8, pitch: 55, padding: PADDING })
    camera.start()
    camera.setTarget(target({ bearing: 10, lng: -97.13 }))
    clock.run(20)

    // Every intermediate bearing is on the short arc (350->360/0->10), never
    // swinging down through 180.
    for (const jump of map.jumps.slice(1)) {
      expect(jump.bearing > 340 || jump.bearing < 20).toBe(true)
    }
  })

  it('stops writing after stop(), so a following fitBounds survives', () => {
    // jumpTo calls stop() internally, so one stray frame would cancel the
    // drive-end unwind and freeze the camera on a rooftop.
    const camera = makeCamera()
    camera.start()
    camera.setTarget(target())
    clock.run(3)
    const before = map.jumps.length

    camera.stop()
    clock.run(10)
    expect(map.jumps).toHaveLength(before)
    expect(clock.pending).toBe(0)
    expect(puck.removed).toBe(true)
  })

  it('stops writing after pause() but keeps its target', () => {
    const camera = makeCamera()
    camera.start()
    camera.setTarget(target())
    clock.run(3)
    const before = map.jumps.length

    camera.pause()
    camera.setTarget(target({ lng: -97.10 }))
    clock.run(10)
    expect(map.jumps).toHaveLength(before)
    expect(puck.removed).toBe(false)

    // ...and picks up again on start(), from wherever the map now is.
    camera.start()
    clock.run(5)
    expect(map.jumps.length).toBeGreaterThan(before)
  })

  it('clamps a huge frame gap so a backgrounded tab does not jump', () => {
    const camera = makeCamera()
    camera.start()
    camera.setTarget(target())
    clock.step(5000) // tab was in the background for five seconds

    // With dt clamped to 0.1s the first frame back covers ~25% of the gap, not
    // all of it.
    const moved = (map.last!.center[0] - -97.13) / (-97.12 - -97.13)
    expect(moved).toBeGreaterThan(0)
    expect(moved).toBeLessThan(0.5)
  })

  it('keeps the puck and the camera on the same frame', () => {
    const camera = makeCamera()
    camera.start()
    camera.setTarget(target())
    clock.run(5)
    expect(puck.lngLat[0]).toBeCloseTo(map.last!.center[0], 9)
    expect(puck.lngLat[1]).toBeCloseTo(map.last!.center[1], 9)
  })

  it('rotates the puck to its own bearing, not the camera bearing', () => {
    // The two answer different questions: the camera faces where the road goes,
    // the arrow shows where the car points.
    const camera = makeCamera()
    camera.start()
    camera.setTarget(target({ bearing: 90, puckBearing: 45 }))
    clock.run(3)
    expect(puck.rotation).toBe(45)
  })

  describe('dead reckoning', () => {
    it('advances the target along the route between fixes', () => {
      const advance = vi.fn((meters: number): [number, number] => [-97.13 + meters / 100000, 32.72])
      const camera = makeCamera({ pointAtMeters: advance })
      camera.start()
      camera.setTarget(target({ routeMeters: 100, speedMps: 20, deadReckon: true }))
      clock.run(30)

      expect(advance).toHaveBeenCalled()
      expect(Math.max(...advance.mock.calls.map((c) => c[0]))).toBeGreaterThan(100)
    })

    it('freezes rather than extrapolating forever when fixes stop', () => {
      // A tunnel. Inventing motion during an outage is how a nav app tells a
      // confident lie about where you are.
      const advance = vi.fn((meters: number): [number, number] => [-97.13 + meters / 100000, 32.72])
      const camera = makeCamera({ pointAtMeters: advance })
      camera.start()
      camera.setTarget(target({ routeMeters: 100, speedMps: 20, deadReckon: true }))
      clock.run(600) // ten seconds of no new fixes

      const furthest = Math.max(...advance.mock.calls.map((c) => c[0]))
      expect(furthest).toBeLessThanOrEqual(100 + 20 * 1.5 + 0.001)
    })

    it('does not extrapolate when the snap is not trusted', () => {
      const advance = vi.fn((): [number, number] => [-97.13, 32.72])
      const camera = makeCamera({ pointAtMeters: advance })
      camera.start()
      camera.setTarget(target({ routeMeters: 100, speedMps: 20, deadReckon: false }))
      clock.run(20)
      expect(advance).not.toHaveBeenCalled()
    })
  })

  describe('prefers-reduced-motion', () => {
    it('writes once per target and schedules no frames', () => {
      // MapLibre's easeTo already collapses to a jump for these users, so this
      // preserves exactly the behaviour they had. Smoothing continuous motion
      // is not an accessibility improvement over not animating it.
      const camera = makeCamera({ prefersReducedMotion: () => true })
      camera.start()
      camera.setTarget(target())

      expect(map.jumps).toHaveLength(1)
      expect(map.last!.center).toEqual([-97.12, 32.72])
      expect(map.last!.bearing).toBe(90)
      expect(clock.pending).toBe(0)

      camera.setTarget(target({ lng: -97.11 }))
      expect(map.jumps).toHaveLength(2)
      expect(clock.pending).toBe(0)
    })
  })

  describe('padding', () => {
    it('glides toward a new padding rather than snapping', () => {
      const camera = makeCamera()
      camera.start()
      camera.setTarget(target())
      clock.run(400)

      camera.setPadding({ ...PADDING, bottom: 400 })
      clock.run(2)
      const bottom = map.last!.padding.bottom
      expect(bottom).toBeGreaterThan(40)
      expect(bottom).toBeLessThan(400)
    })

    it('ignores a padding change before any target exists', () => {
      const camera = makeCamera()
      camera.start()
      camera.setPadding({ ...PADDING, bottom: 400 })
      clock.run(5)
      expect(map.jumps).toHaveLength(0)
    })
  })
})
