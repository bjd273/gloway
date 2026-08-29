import { describe, expect, it } from 'vitest'

import { OffRouteDetector, type OffRouteSample } from './offRoute'

const START = 1_000_000

// A fix that satisfies every gate: well off the line, no confidence left, and
// nowhere near the end of a 5km route. Individual tests spoil one field at a
// time so it is always obvious which gate is under test.
function offRoute(overrides: Partial<OffRouteSample> = {}): OffRouteSample {
  return {
    offRouteMeters: 120,
    snapConfidence: 0,
    rawLng: -97.11,
    rawLat: 32.735,
    metersDriven: 1000,
    routeMeters: 5000,
    gpsSignalLost: false,
    at: START,
    ...overrides,
  }
}

/**
 * Drive off-route for `seconds`, moving `metersPerFix` of ground each fix.
 *
 * Metres are converted to degrees of latitude so the detector's own
 * `metersBetween` measures back what was intended — feeding it degrees directly
 * would let a test "travel" 60 degrees and pass for the wrong reason.
 */
function drive(
  detector: OffRouteDetector,
  {
    from = START,
    seconds,
    metersPerFix = 20,
    sample = {},
  }: { from?: number; seconds: number; metersPerFix?: number; sample?: Partial<OffRouteSample> },
) {
  let last: { lng: number; lat: number } | null = null
  const fixes = Math.round(seconds)
  for (let i = 0; i <= fixes; i += 1) {
    last = detector.update(
      offRoute({ at: from + i * 1000, rawLat: 32.735 + (i * metersPerFix) / 110_540, ...sample }),
    )
    if (last) return { verdict: last, atFix: i }
  }
  return { verdict: null, atFix: fixes }
}

describe('OffRouteDetector', () => {
  it('does not reroute on the first bad fix', () => {
    const detector = new OffRouteDetector(0)
    expect(detector.update(offRoute())).toBeNull()
  })

  it('reroutes once the deviation has held for long enough and covered ground', () => {
    const detector = new OffRouteDetector(0)
    const { verdict, atFix } = drive(detector, { seconds: 12 })
    expect(verdict).not.toBeNull()
    // Six seconds is the floor, and 60m at 20m/fix takes three fixes — so time
    // is the binding constraint here, not distance.
    expect(atFix).toBeGreaterThanOrEqual(6)
  })

  it('does not reroute a stationary car with a drifting fix', () => {
    // Six seconds of "off route" with no ground covered is a parked car beside
    // a road, or a fix wandering in an urban canyon. Rerouting it would send
    // directions from wherever the noise happened to land.
    const detector = new OffRouteDetector(0)
    expect(drive(detector, { seconds: 60, metersPerFix: 0 }).verdict).toBeNull()
  })

  it('stays quiet during the grace window at the start of a drive', () => {
    // The route begins on a road; the car begins in a parking space.
    const detector = new OffRouteDetector(START)
    expect(drive(detector, { seconds: 7 }).verdict).toBeNull()
  })

  it('stays quiet in the last stretch of the route', () => {
    // Pulling into the destination's lot is not a wrong turn, and rerouting
    // there would route the driver back out of it.
    const detector = new OffRouteDetector(0)
    expect(
      drive(detector, { seconds: 30, sample: { metersDriven: 4950, routeMeters: 5000 } }).verdict,
    ).toBeNull()
  })

  it('ignores a deviation while the GPS signal is lost', () => {
    // A frozen puck in a tunnel is not a car that left the route.
    const detector = new OffRouteDetector(0)
    expect(drive(detector, { seconds: 30, sample: { gpsSignalLost: true } }).verdict).toBeNull()
  })

  it('needs both the distance floor and the confidence collapse', () => {
    const detector = new OffRouteDetector(0)
    // Confidence gone but only 20m off — a wide-accuracy fix on a big arterial.
    expect(drive(detector, { seconds: 30, sample: { offRouteMeters: 20 } }).verdict).toBeNull()
    // Far off the line but the app still believes it — a shape point missing
    // from a sweeping curve, say.
    expect(drive(detector, { seconds: 30, sample: { snapConfidence: 0.9 } }).verdict).toBeNull()
  })

  it('forgets a deviation the driver came back from', () => {
    const detector = new OffRouteDetector(0)
    // Five seconds off — one short of confirming.
    drive(detector, { seconds: 5 })
    // Back on the road for one fix.
    detector.update(offRoute({ at: START + 6000, offRouteMeters: 3, snapConfidence: 1 }))
    // Off again: the clock restarts rather than resuming, so a single fix at
    // 7s must not confirm what the earlier five seconds began.
    expect(detector.update(offRoute({ at: START + 7000 }))).toBeNull()
  })

  it('will not reroute again inside the cooldown', () => {
    const detector = new OffRouteDetector(0)
    const first = drive(detector, { seconds: 12 })
    expect(first.verdict).not.toBeNull()
    detector.noteRerouted(START + 12_000)
    expect(drive(detector, { from: START + 13_000, seconds: 20 }).verdict).toBeNull()
    // Past the 25s cooldown it works again.
    expect(drive(detector, { from: START + 40_000, seconds: 12 }).verdict).not.toBeNull()
  })

  it('stands down after too many reroutes in one window, and recovers after it', () => {
    const detector = new OffRouteDetector(0)
    detector.noteRerouted(START)
    detector.noteRerouted(START + 1000)
    expect(detector.exhausted).toBe(false)
    detector.noteRerouted(START + 2000)
    expect(detector.exhausted).toBe(true)
    expect(drive(detector, { from: START + 60_000, seconds: 30 }).verdict).toBeNull()

    // The window is rolling, not a per-drive cap: three wrong turns over forty
    // minutes is a long drive, not a fight with the driver.
    drive(detector, { from: START + 400_000, seconds: 1 })
    expect(detector.exhausted).toBe(false)
  })

  it('counts failures toward standing down too', () => {
    // Repeatedly failing to reroute is as good a reason to stop trying as
    // repeatedly succeeding, and hammering a sick backend helps nobody.
    const detector = new OffRouteDetector(0)
    detector.noteFailed(START)
    detector.noteFailed(START + 1000)
    detector.noteFailed(START + 2000)
    expect(detector.exhausted).toBe(true)
  })

  it('never reroutes when nothing projected', () => {
    const detector = new OffRouteDetector(0)
    expect(drive(detector, { seconds: 30, sample: { offRouteMeters: null } }).verdict).toBeNull()
  })

  it('reroutes from the latest raw fix, not where the deviation began', () => {
    const detector = new OffRouteDetector(0)
    const { verdict } = drive(detector, { seconds: 12, metersPerFix: 30 })
    // The car kept moving while we made up our mind; directions have to start
    // from where it is now.
    expect(verdict!.lat).toBeGreaterThan(32.735)
  })
})
