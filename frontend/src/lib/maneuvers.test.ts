import { describe, expect, it } from 'vitest'

import type { RouteStep } from './api'
import { ManeuverTracker, stepBoundaries } from './maneuvers'

const step = (miles: number, beginShapeIndex?: number): RouteStep => ({
  text: 'Turn left',
  miles,
  seconds: miles * 60,
  beginShapeIndex,
})

// 0, 100, 200, ... 1000 metres.
const cumulative = Array.from({ length: 11 }, (_, i) => i * 100)

describe('stepBoundaries', () => {
  it('locates each maneuver where it is performed, from begin_shape_index', () => {
    // Valhalla spans a maneuver from begin to end, and performs its
    // instruction at BEGIN. Using end instead lands on the right point but
    // pairs it with the previous maneuver's words — the "one turn behind" bug.
    const boundaries = stepBoundaries([step(0.1, 0), step(0.4, 3), step(0.2, 7)], cumulative)
    expect(boundaries).toEqual([0, 300, 700])
  })

  it('falls back to distance, exclusively prefixed so the first is zero', () => {
    // No shape indices: 1 + 3 mile steps over a 1000m route start at 0 and 250.
    expect(stepBoundaries([step(1), step(3)], cumulative)).toEqual([0, 250])
  })

  it('does not mix sources when only some steps carry an index', () => {
    // The two disagree by metres per step, and a list that switched partway
    // could step backwards at the seam — which reads as the driver reversing.
    expect(stepBoundaries([step(1, 0), step(3)], cumulative)).toEqual([0, 250])
  })

  it('ignores an out-of-range index rather than reading undefined', () => {
    const boundaries = stepBoundaries([step(1, 0), step(3, 99)], cumulative)
    expect(boundaries).toEqual([0, 250])
    expect(boundaries.every((b) => Number.isFinite(b))).toBe(true)
  })

  it('survives a route with no steps or no length', () => {
    expect(stepBoundaries([], cumulative)).toEqual([])
    expect(stepBoundaries([step(0), step(0)], [0, 0])).toEqual([0, 0])
    expect(stepBoundaries([step(1)], [])).toEqual([0])
  })
})

describe('ManeuverTracker', () => {
  // Departure at 0, then turns at 300m and 700m, arrival at 1000m.
  const boundaries = () => new ManeuverTracker([0, 300, 700, 1000])

  it('points at the first real turn the moment the drive starts', () => {
    // Not the departure maneuver sitting at distance 0 — a driver pulling away
    // wants the turn they are heading for, not a description of the road they
    // are already on.
    expect(boundaries().update(0)).toEqual({
      stepIndex: 1,
      metersToManeuver: 300,
      nextStepIndex: 2,
    })
  })

  it('counts down to the maneuver ahead, not the one just made', () => {
    const tracker = boundaries()
    tracker.update(0)
    expect(tracker.update(250)).toEqual({
      stepIndex: 1,
      metersToManeuver: 50,
      nextStepIndex: 2,
    })
  })

  it('moves on to the next turn the moment one is reached', () => {
    // The regression that made every instruction arrive a turn late: at 300m
    // the driver is AT the first turn, so the banner must already be showing
    // the second one rather than narrating the turn being completed.
    const tracker = boundaries()
    const atTurn = tracker.update(300)
    expect(atTurn.stepIndex).toBe(2)
    expect(atTurn.metersToManeuver).toBe(400)
  })

  it('never rewinds when a fix projects onto road already driven', () => {
    // A loop route (or either side of a U-turn) puts two stretches metres
    // apart, and DriveController's full-line nearest-point scan can pick the
    // earlier one from a noisy fix.
    const tracker = boundaries()
    expect(tracker.update(800).stepIndex).toBe(3)

    const back = tracker.update(200)
    expect(back.stepIndex).toBe(3) // held, not rewound
    // ...and the distance floors at the previous maneuver rather than going
    // negative or claiming the driver is somewhere they are not.
    expect(back.metersToManeuver).toBe(300)
  })

  it('still reads honestly when the driver drifts back within one step', () => {
    const tracker = boundaries()
    tracker.update(500)
    expect(tracker.update(400)).toEqual({
      stepIndex: 2,
      metersToManeuver: 300,
      nextStepIndex: 3,
    })
  })

  it('skips whole steps when one update jumps past several boundaries', () => {
    // An 8x simulation tick, or a GPS gap through a tunnel.
    expect(boundaries().update(950).stepIndex).toBe(3)
  })

  it('has no next step on the final one, and stays put past the end', () => {
    const tracker = boundaries()
    expect(tracker.update(1000).nextStepIndex).toBeNull()
    expect(tracker.update(5000)).toEqual({
      stepIndex: 3,
      metersToManeuver: 0,
      nextStepIndex: null,
    })
  })

  it('does not throw on a route with no maneuvers', () => {
    expect(new ManeuverTracker([]).update(100)).toEqual({
      stepIndex: 0,
      metersToManeuver: 0,
      nextStepIndex: null,
    })
  })

  it('handles a single-maneuver route', () => {
    const tracker = new ManeuverTracker([0])
    expect(tracker.update(0)).toEqual({
      stepIndex: 0,
      metersToManeuver: 0,
      nextStepIndex: null,
    })
  })

  it('tracks a real Valhalla shape-index sequence end to end', () => {
    // The exact opening of a probed Arlington route: drive north on South
    // Pecan (begin 0), turn left onto West Mitchell (begin 12), turn right
    // onto South Cooper (begin 34). Ten metres per shape point.
    const meters = Array.from({ length: 40 }, (_, i) => i * 10)
    const steps = [step(0.14, 0), step(0.31, 12), step(0.81, 34)]
    const tracker = new ManeuverTracker(stepBoundaries(steps, meters))

    // Pulling away: heading for the West Mitchell left, 120m off.
    expect(tracker.update(0)).toMatchObject({ stepIndex: 1, metersToManeuver: 120 })
    // Rolling up to it.
    expect(tracker.update(115)).toMatchObject({ stepIndex: 1, metersToManeuver: 5 })
    // Through it: now heading for the Cooper right, not still announcing the left.
    expect(tracker.update(130)).toMatchObject({ stepIndex: 2, metersToManeuver: 210 })
  })
})
