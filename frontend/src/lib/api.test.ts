// Covers the parsing helpers that turn a raw Valhalla trip into something the
// route cards can name. The HTTP functions around them are exercised through
// the app; what's worth pinning here is the geometry-free judgement calls.
import { describe, expect, it } from 'vitest'
import polyline from '@mapbox/polyline'

import { dominantStreet, parseTrip } from './api'

const leg = (name: string | undefined, length: number) => ({
  instruction: 'go',
  time: 60,
  length,
  street_names: name ? [name] : undefined,
})

describe('dominantStreet', () => {
  it('picks the road with the most distance, not the most maneuvers', () => {
    // Four fiddly turns through a neighbourhood, then one long run down a
    // highway. A driver looking at this calls it the highway route; counting
    // maneuvers would name a side street.
    const road = dominantStreet([
      leg('Start St', 0.2),
      leg('Oak Ln', 0.3),
      leg('Elm Ln', 0.2),
      leg('Maple Ln', 0.3),
      leg('I-30', 8.4),
      leg('End St', 0.2),
    ])
    expect(road).toBe('I-30')
  })

  it('ignores the first and last maneuvers', () => {
    // Every candidate for the same trip leaves from and arrives on the same
    // street, so those legs distinguish nothing — and on a short trip they are
    // often the longest, which is exactly when they would win and make every
    // card read identically.
    const road = dominantStreet([
      leg('Shared Origin Rd', 9),
      leg('Cooper St', 1.5),
      leg('Shared Destination Rd', 9),
    ])
    expect(road).toBe('Cooper St')
  })

  it('has no answer when nothing in the middle is named', () => {
    // Unnamed service roads and slip lanes carry no street_names at all.
    expect(dominantStreet([leg('A', 1), leg(undefined, 5), leg('B', 1)])).toBeUndefined()
  })

  it('degrades on trips too short to have a middle', () => {
    expect(dominantStreet([])).toBeUndefined()
    expect(dominantStreet([leg('Only St', 3)])).toBeUndefined()
    expect(dominantStreet([leg('A St', 3), leg('B St', 3)])).toBeUndefined()
  })

  it('sums a road split across several maneuvers', () => {
    // One road crossed by turns still has to beat a single longer-looking leg.
    const road = dominantStreet([
      leg('Origin Rd', 1),
      leg('Cooper St', 2),
      leg('Cooper St', 2),
      leg('Division St', 3),
      leg('Destination Rd', 1),
    ])
    expect(road).toBe('Cooper St')
  })
})

// Two legs of three points each — a trip with one stop in the middle.
const shape = (points: [number, number][]) =>
  polyline.encode(points.map(([lng, lat]) => [lat, lng]) as [number, number][], 6)

const maneuver = (over: Record<string, unknown> = {}) => ({
  instruction: 'Turn left',
  length: 1,
  time: 60,
  ...over,
})

describe('parseTrip', () => {
  it('shifts each leg’s shape indices into the concatenated coordinate array', () => {
    // THE regression this exists for. Valhalla numbers shape indices per leg,
    // so leg 2's maneuvers start again at 0 — but parseTrip concatenates every
    // leg's points into one array. Unshifted, leg 2's "index 0" would address
    // the trip's origin instead of the stop, and the error grows with each leg.
    const route = parseTrip(
      {
        summary: { time: 600, length: 5 },
        legs: [
          {
            shape: shape([
              [-97.1, 32.7],
              [-97.11, 32.71],
              [-97.12, 32.72],
            ]),
            maneuvers: [maneuver({ begin_shape_index: 0, end_shape_index: 2 })],
          },
          {
            shape: shape([
              [-97.12, 32.72],
              [-97.13, 32.73],
              [-97.14, 32.74],
            ]),
            maneuvers: [maneuver({ begin_shape_index: 0, end_shape_index: 2 })],
          },
        ],
      },
      'Fastest',
    )

    expect(route.coords).toHaveLength(6) // both legs' copies of the junction
    expect(route.steps[0].beginShapeIndex).toBe(0)
    expect(route.steps[0].endShapeIndex).toBe(2)
    // Leg 2's own 0 and 2, shifted past leg 1's three points.
    expect(route.steps[1].beginShapeIndex).toBe(3)
    expect(route.steps[1].endShapeIndex).toBe(5)
    // And the shifted index really does address that leg's geometry.
    expect(route.coords[route.steps[1].beginShapeIndex!]).toEqual([-97.12, 32.72])
  })

  it('keeps index 0 rather than treating it as missing', () => {
    // `if (i)` or `i ?? undefined` would drop this — 0 is falsy and is the
    // commonest shape index there is.
    const route = parseTrip(
      {
        summary: { time: 60, length: 1 },
        legs: [
          {
            shape: shape([
              [-97.1, 32.7],
              [-97.11, 32.71],
            ]),
            maneuvers: [maneuver({ begin_shape_index: 0, end_shape_index: 0 })],
          },
        ],
      },
      'Fastest',
    )
    expect(route.steps[0].beginShapeIndex).toBe(0)
    expect(route.steps[0].endShapeIndex).toBe(0)
  })

  it('carries lanes, verbal strings and signs through', () => {
    const lanes = [
      { indications: ['left'], valid: false, active: false },
      { indications: ['right'], valid_indication: 'right', valid: true, active: true },
    ]
    const route = parseTrip(
      {
        summary: { time: 60, length: 1 },
        legs: [
          {
            shape: shape([
              [-97.1, 32.7],
              [-97.11, 32.71],
            ]),
            maneuvers: [
              maneuver({
                type: 10,
                lanes,
                verbal_transition_alert_instruction: 'Turn right onto Cooper Street.',
                verbal_pre_transition_instruction: 'Turn right onto Cooper Street, FM 157.',
                verbal_multi_cue: true,
                roundabout_exit_count: 2,
                sign: {
                  exit_number_elements: [{ text: '28A' }],
                  exit_toward_elements: [{ text: 'Dallas' }, { text: 'Fort Worth' }],
                },
              }),
            ],
          },
        ],
      },
      'Fastest',
    )
    const step = route.steps[0]
    expect(step.type).toBe(10)
    expect(step.lanes).toEqual(lanes)
    expect(step.verbalAlert).toBe('Turn right onto Cooper Street.')
    expect(step.verbalMultiCue).toBe(true)
    expect(step.roundaboutExitCount).toBe(2)
    expect(step.sign?.exitNumbers).toEqual(['28A'])
    expect(step.sign?.exitToward).toEqual(['Dallas', 'Fort Worth'])
    // Sign groups Valhalla didn't emit stay undefined rather than becoming [].
    expect(step.sign?.exitBranches).toBeUndefined()
  })

  it('parses a maneuver carrying none of the optional fields', () => {
    // Most Arlington maneuvers have no turn:lanes, and a costing that emits no
    // typed maneuvers is a real possibility — neither may throw.
    const route = parseTrip(
      {
        summary: { time: 60, length: 1 },
        legs: [
          {
            shape: shape([
              [-97.1, 32.7],
              [-97.11, 32.71],
            ]),
            maneuvers: [maneuver()],
          },
        ],
      },
      'Fastest',
    )
    const step = route.steps[0]
    expect(step.text).toBe('Turn left')
    expect(step.lanes).toBeUndefined()
    expect(step.type).toBeUndefined()
    expect(step.beginShapeIndex).toBeUndefined()
    expect(step.sign).toBeUndefined()
  })
})
