import { describe, expect, it } from 'vitest'

import { cumulativeMeters, lengthFractions } from './routeProgress'
import { pointAtMeters, projectToRoute, snapConfidence } from './snapToRoute'

// A straight run east along one latitude. At 32.7N a degree of longitude is
// ~93.7 km, so 0.001 deg is ~93.7 m per segment.
const EAST: [number, number][] = [
  [-97.13, 32.73],
  [-97.129, 32.73],
  [-97.128, 32.73],
  [-97.127, 32.73],
  [-97.126, 32.73],
]
const EAST_CUM = cumulativeMeters(EAST)

/** Degrees of latitude for a given northward offset in metres. */
const latOffset = (meters: number) => meters / 110_540

describe('projectToRoute', () => {
  it('finds the perpendicular foot beside a segment', () => {
    const midLng = (EAST[1][0] + EAST[2][0]) / 2
    const p = projectToRoute(EAST, EAST_CUM, [midLng, 32.73 + latOffset(10)])!
    expect(p.distanceMeters).toBeCloseTo(10, 1)
    expect(p.lng).toBeCloseTo(midLng, 9)
    expect(p.lat).toBeCloseTo(32.73, 9) // the foot is ON the line, not beside it
    expect(p.index).toBe(1)
  })

  it('reports a continuous distance along the line, not a shape point', () => {
    // The defect this replaced: progress quantised to Valhalla's point spacing,
    // which is 100m+ on a straight, so the turn countdown ticked in 100m steps.
    const quarter = EAST_CUM[1] + (EAST_CUM[2] - EAST_CUM[1]) * 0.25
    const at = pointAtMeters(EAST, EAST_CUM, quarter)
    const p = projectToRoute(EAST, EAST_CUM, at)!
    expect(p.meters).toBeCloseTo(quarter, 3)
    expect(p.meters).not.toBeCloseTo(EAST_CUM[1], 0)
  })

  it('clamps to the segment end rather than running off it', () => {
    // A point well past the last coordinate must land ON the route's end.
    const p = projectToRoute(EAST, EAST_CUM, [-97.1, 32.73])!
    expect(p.lng).toBeCloseTo(EAST[EAST.length - 1][0], 9)
    expect(p.fraction).toBeCloseTo(1, 6)
  })

  it('agrees with lengthFractions at a shape point', () => {
    // If these two ever disagree the greyed-out traveled line and the puck part
    // company on screen, which is the bug routeProgress.ts exists to prevent.
    const fractions = lengthFractions(EAST)
    const p = projectToRoute(EAST, EAST_CUM, EAST[3])!
    expect(p.fraction).toBeCloseTo(fractions[3], 9)
  })

  it('survives duplicate shape points without dividing by zero', () => {
    const dupes: [number, number][] = [
      [-97.13, 32.73],
      [-97.13, 32.73],
      [-97.129, 32.73],
    ]
    const p = projectToRoute(dupes, cumulativeMeters(dupes), [-97.1295, 32.73])!
    expect(Number.isFinite(p.distanceMeters)).toBe(true)
    expect(Number.isFinite(p.fraction)).toBe(true)
  })

  it('returns null for a degenerate route', () => {
    expect(projectToRoute([], [], [-97.13, 32.73])).toBeNull()
    expect(projectToRoute([[-97.13, 32.73]], [0], [-97.13, 32.73])).toBeNull()
  })

  describe('windowed search', () => {
    // Out and back along the same road: the return leg sits 20m north of the
    // outbound one. A full scan from a position on the return leg can match the
    // outbound leg driven minutes ago and throw progress backwards.
    const OUT_AND_BACK: [number, number][] = [
      [-97.13, 32.73],
      [-97.128, 32.73],
      [-97.126, 32.73],
      [-97.126, 32.73 + latOffset(20)],
      [-97.128, 32.73 + latOffset(20)],
      [-97.13, 32.73 + latOffset(20)],
    ]
    const CUM = cumulativeMeters(OUT_AND_BACK)

    it('prefers the leg the driver is actually on', () => {
      const onReturnLeg: [number, number] = [-97.127, 32.73 + latOffset(18)]
      const anchor = 4 // last known: on the return leg
      const windowed = projectToRoute(OUT_AND_BACK, CUM, onReturnLeg, { fromIndex: anchor })!
      expect(windowed.index).toBeGreaterThanOrEqual(3)
      expect(windowed.meters).toBeGreaterThan(CUM[3])
    })

    it('scans the whole line when there is no prior position', () => {
      // Reroute resume: the first fix after a restart can be anywhere along the
      // new route, and a window seeded at zero would never find it.
      const p = projectToRoute(EAST, EAST_CUM, pointAtMeters(EAST, EAST_CUM, EAST_CUM[4] * 0.7))!
      expect(p.fraction).toBeCloseTo(0.7, 2)
    })

    it('rescues with a full scan when the window has lost the driver', () => {
      // Far off the window but right on a later part of the route.
      const p = projectToRoute(EAST, EAST_CUM, EAST[4], { fromIndex: 0, forwardMeters: 1 })!
      expect(p.fraction).toBeCloseTo(1, 3)
    })

    it('refuses a rescue that would drag progress backwards', () => {
      const nearStart: [number, number] = [-97.1299, 32.73 + latOffset(5)]
      const p = projectToRoute(OUT_AND_BACK, CUM, nearStart, {
        fromIndex: 4,
        backMeters: 1,
        forwardMeters: 1,
      })!
      expect(p.meters).toBeGreaterThan(CUM[3])
    })
  })
})

describe('pointAtMeters', () => {
  it('interpolates within a segment', () => {
    const half = EAST_CUM[4] / 2
    const [lng, lat] = pointAtMeters(EAST, EAST_CUM, half)
    expect(lng).toBeCloseTo(-97.128, 6)
    expect(lat).toBeCloseTo(32.73, 9)
  })

  it('clamps at both ends', () => {
    expect(pointAtMeters(EAST, EAST_CUM, -50)).toEqual(EAST[0])
    expect(pointAtMeters(EAST, EAST_CUM, 1e6)).toEqual(EAST[EAST.length - 1])
  })

  it('round-trips against projectToRoute', () => {
    for (const target of [10, 120, 250, 370]) {
      const p = projectToRoute(EAST, EAST_CUM, pointAtMeters(EAST, EAST_CUM, target))!
      expect(p.meters).toBeCloseTo(target, 3)
    }
  })
})

describe('snapConfidence', () => {
  const base = { accuracyMeters: 10, courseDeg: 90, segmentBearing: 90 }

  it('is full confidence right on the line, heading agreeing', () => {
    expect(snapConfidence({ ...base, distanceMeters: 2 })).toBeCloseTo(1, 6)
  })

  it('is zero far off the line', () => {
    expect(snapConfidence({ ...base, distanceMeters: 200 })).toBe(0)
  })

  it('falls off smoothly rather than switching', () => {
    // A hard threshold makes the puck pop between snapped and raw as the fix
    // wanders across it, which is worse than either behaviour alone.
    const samples = [5, 10, 15, 20, 25, 30, 40].map((d) =>
      snapConfidence({ ...base, distanceMeters: d }),
    )
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]).toBeLessThanOrEqual(samples[i - 1])
    }
    expect(samples.some((v) => v > 0.05 && v < 0.95)).toBe(true)
  })

  it('widens the corridor for a less accurate fix', () => {
    const d = 22
    const precise = snapConfidence({ ...base, accuracyMeters: 5, distanceMeters: d })
    const vague = snapConfidence({ ...base, accuracyMeters: 60, distanceMeters: d })
    expect(vague).toBeGreaterThan(precise)
  })

  it('refuses to snap to a road pointing the other way', () => {
    // The opposite carriageway of a divided road, or a frontage road running
    // alongside. Folding the heading error to +/-90 would call this a perfect
    // match and stick the puck on the wrong roadway.
    expect(snapConfidence({ ...base, distanceMeters: 5, courseDeg: 270 })).toBe(0)
  })

  it('tolerates a small heading disagreement', () => {
    expect(snapConfidence({ ...base, distanceMeters: 5, courseDeg: 110 })).toBeGreaterThan(0.5)
  })

  it('does not punish a missing course', () => {
    // Stopped at a light is exactly where snapping helps most and risks least.
    expect(snapConfidence({ ...base, distanceMeters: 5, courseDeg: null })).toBeCloseTo(1, 6)
  })

  it('assumes a default accuracy when the device reports none', () => {
    const v = snapConfidence({ ...base, accuracyMeters: null, distanceMeters: 8 })
    expect(v).toBeGreaterThan(0)
    expect(v).toBeLessThanOrEqual(1)
  })
})
