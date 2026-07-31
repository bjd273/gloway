// Which turn is next, and how far away it is.
//
// Before this, no part of the app knew what step the driver was on. TripSheet
// and NavVoice each re-derived it from cumulative miles, in duplicated loops,
// and disagreed at leg boundaries. Worse, nothing anywhere tracked a step
// *transition* — so nothing could fire when one happened, which is exactly what
// a turn banner and a spoken announcement both need.
//
// Everything here is arithmetic over numbers: no React, no store, no browser.
import type { RouteStep } from './api'

export interface ManeuverProgress {
  /**
   * The maneuver being driven TOWARD — the turn about to happen, not the one
   * already made. `steps[stepIndex]` is what the banner shows and the
   * announcer speaks.
   */
  stepIndex: number
  /** Metres from here to that maneuver. */
  metersToManeuver: number
  /** The step after it, for the "then ..." cue. Null on the final step. */
  nextStepIndex: number | null
}

/**
 * Distance along the route at which each maneuver is PERFORMED.
 *
 * Built from `beginShapeIndex`, and the distinction is the whole ballgame.
 * Valhalla gives each maneuver a span: `begin_shape_index` is where its
 * instruction is carried out, `end_shape_index` is where that span hands over
 * to the next maneuver — so `end[N] === begin[N+1]`.
 *
 *   0: "Drive north on South Pecan Street."   begin=0  end=12
 *   1: "Turn left onto West Mitchell Street." begin=12 end=34
 *
 * Building boundaries from `end` puts the countdown on the right POINT (shape
 * index 12 really is where the left turn happens) but pairs it with the wrong
 * INSTRUCTION — maneuver 0, the road being driven, rather than maneuver 1, the
 * turn being approached. Since the two lists differ by exactly one position,
 * every instruction displays and is spoken one turn late: you hear "turn left
 * onto West Mitchell" just after completing that turn. Use `begin`.
 *
 * Two sources, in order of trust, and never mixed — they disagree by a few
 * metres per step, and a list that switched sources partway would step
 * backwards at the seam, which reads to the tracker as the driver reversing:
 *
 *  1. `beginShapeIndex` into `cumulative`. Exact: the engine's own answer.
 *  2. Exclusive prefix sums of `step.miles` (the distance before this step
 *     begins), rescaled to the route's true length.
 */
export function stepBoundaries(steps: RouteStep[], cumulative: number[]): number[] {
  const total = cumulative.length ? cumulative[cumulative.length - 1] : 0
  const haveIndices =
    steps.length > 0 &&
    steps.every((s) => s.beginShapeIndex !== undefined && s.beginShapeIndex < cumulative.length)
  if (haveIndices) return steps.map((s) => cumulative[s.beginShapeIndex!])

  const totalMiles = steps.reduce((sum, s) => sum + s.miles, 0)
  const scale = totalMiles > 0 ? total / totalMiles : 0
  // Exclusive: boundary N is where step N STARTS, so the first is always 0.
  let running = 0
  return steps.map((s) => {
    const start = running
    running += s.miles
    return start * scale
  })
}

export class ManeuverTracker {
  private stepIndex = 0
  private readonly boundaries: number[]

  constructor(boundaries: number[]) {
    this.boundaries = boundaries
  }

  /**
   * Advance to `metersDriven` along the route and report the maneuver ahead.
   *
   * Settles on the first maneuver whose performance point is still in front of
   * the driver. Boundary 0 is the departure at distance 0, so the very first
   * update walks straight past it onto the first real turn — which is what a
   * driver wants to see the moment they pull away.
   *
   * The step index only ever moves FORWARD. It has to: DriveController projects
   * each GPS fix onto the nearest route coordinate by scanning the whole line,
   * so on a loop-shaped route — or either side of a U-turn, where two opposite
   * stretches of road sit metres apart — one noisy fix can land on a coordinate
   * the driver passed ten minutes ago. Allowing that to rewind the step would
   * re-announce a turn already taken and flip the banner back to an instruction
   * the driver has finished obeying, which are the two worst things a turn
   * banner can do.
   *
   * The distance readout is only floored at the previous maneuver, not held at
   * a high-water mark: within a step the honest projection wins, so drifting or
   * backing up still reads truthfully. A genuine reroute doesn't rewind this
   * object either — the store throws it away and builds a new one.
   */
  update(metersDriven: number): ManeuverProgress {
    const last = this.boundaries.length - 1
    if (last < 0) return { stepIndex: 0, metersToManeuver: 0, nextStepIndex: null }

    const floor = this.stepIndex === 0 ? 0 : this.boundaries[this.stepIndex - 1]
    const driven = Math.max(metersDriven, floor)

    while (this.stepIndex < last && this.boundaries[this.stepIndex] <= driven) {
      this.stepIndex += 1
    }
    return {
      stepIndex: this.stepIndex,
      metersToManeuver: Math.max(0, this.boundaries[this.stepIndex] - driven),
      nextStepIndex: this.stepIndex < last ? this.stepIndex + 1 : null,
    }
  }
}
