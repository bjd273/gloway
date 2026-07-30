// The point of these tests is the gap between "which coordinate" and "how far
// along", which is what the live-navigation styling gets wrong the moment
// anyone conflates the two.
import { describe, expect, it } from 'vitest'

import { bearingAtFraction, lengthFractions, metersBetween } from './routeProgress'

/** Evenly spaced west→east, 11 points ~94m apart — the easy case where index
 * and distance happen to agree. */
const EVEN: [number, number][] = Array.from({ length: 11 }, (_, i) => [-97.13 + i * 0.001, 32.72])

/** What Valhalla actually emits: three points bunched at a junction, then one
 * long straight. By coordinate index the third point is 67% of the way along;
 * by distance it is 2%. */
const UNEVEN: [number, number][] = [
  [-97.13, 32.72],
  [-97.1299, 32.72],
  [-97.1298, 32.72],
  [-97.12, 32.72],
]

describe('lengthFractions', () => {
  it('is index-proportional only when the points happen to be evenly spaced', () => {
    const fractions = lengthFractions(EVEN)
    expect(fractions[0]).toBe(0)
    expect(fractions[5]).toBeCloseTo(0.5, 6)
    expect(fractions[10]).toBe(1)
  })

  it('measures distance, not coordinates — the whole reason this exists', () => {
    const fractions = lengthFractions(UNEVEN)
    // Index-based progress would call this 2/3 of the way and grey out
    // two-thirds of a route the driver has barely started.
    expect(fractions[2]).toBeCloseTo(0.02, 2)
    expect(fractions[2]).toBeLessThan(0.05)
    expect(fractions[3]).toBe(1)
  })

  it('rises monotonically and ends at exactly 1', () => {
    const fractions = lengthFractions(UNEVEN)
    for (let i = 1; i < fractions.length; i += 1) {
      expect(fractions[i]).toBeGreaterThan(fractions[i - 1])
    }
    expect(fractions.at(-1)).toBe(1)
  })

  it('returns zeros rather than NaN for routes with no length', () => {
    // A zero-length route divides by zero if you are not careful, and a NaN
    // reaching `line-progress` blanks the whole route line silently.
    expect(lengthFractions([])).toEqual([])
    expect(lengthFractions([[-97.13, 32.72]])).toEqual([0])
    const stationary: [number, number][] = [
      [-97.13, 32.72],
      [-97.13, 32.72],
    ]
    expect(lengthFractions(stationary)).toEqual([0, 0])
  })
})

describe('metersBetween', () => {
  it('accounts for longitude shrinking with latitude', () => {
    // 0.01° of longitude at 32.72°N is ~936m, not the ~1113m a flat
    // degrees × 111_320 would claim. Getting this wrong is the exact bug the
    // server-side signal processor had.
    const east = metersBetween([-97.13, 32.72], [-97.12, 32.72])
    const north = metersBetween([-97.13, 32.72], [-97.13, 32.73])
    expect(east).toBeCloseTo(936.6, 0)
    expect(north).toBeCloseTo(1105.4, 0)
    expect(east).toBeLessThan(north) // same 0.01°, shorter on the ground
  })
})

describe('bearingAtFraction', () => {
  const evenFractions = lengthFractions(EVEN)

  it('reads compass degrees clockwise from north', () => {
    expect(bearingAtFraction(EVEN, evenFractions, 0)).toBeCloseTo(90, 1) // due east
    const north: [number, number][] = [
      [-97.13, 32.72],
      [-97.13, 32.73],
    ]
    expect(bearingAtFraction(north, lengthFractions(north), 0)).toBeCloseTo(0, 1)
  })

  it('holds its heading all the way along a straight route', () => {
    for (const f of [0, 0.25, 0.5, 0.9, 1]) {
      expect(bearingAtFraction(EVEN, evenFractions, f)).toBeCloseTo(90, 1)
    }
  })

  it('looks past short segments so the camera does not snap at every shape point', () => {
    // An 11m jog north followed by a 94m run east. Steering by the very next
    // shape point would swing the map to due north for one fix and back.
    const jog: [number, number][] = [
      [-97.13, 32.72],
      [-97.13, 32.7201],
      [-97.129, 32.7201],
    ]
    const fractions = lengthFractions(jog)
    expect(bearingAtFraction(jog, fractions, 0)).toBeGreaterThan(70) // mostly east

    // ...and the lookahead is the knob that decides: shrink it below the jog
    // and you get the jog's own heading back.
    expect(bearingAtFraction(jog, fractions, 0, 5)).toBeCloseTo(0, 1)
  })

  it('has no answer for a route with no direction', () => {
    expect(bearingAtFraction([], [], 0)).toBeNull()
    expect(bearingAtFraction([[-97.13, 32.72]], [0], 0)).toBeNull()
    const stationary: [number, number][] = [
      [-97.13, 32.72],
      [-97.13, 32.72],
    ]
    expect(bearingAtFraction(stationary, lengthFractions(stationary), 0)).toBeNull()
  })
})
