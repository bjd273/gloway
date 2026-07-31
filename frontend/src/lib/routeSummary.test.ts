import { describe, expect, it } from 'vitest'

import type { ParsedRoute } from './api'
import {
  abbreviateRoad,
  formatDelta,
  formatDistanceToTurn,
  formatMiles,
  formatMinutes,
  routeDisplayOrder,
  routeLabels,
  routeReason,
} from './routeSummary'

function route(over: Partial<ParsedRoute> = {}): ParsedRoute {
  return {
    coords: [],
    minutes: 30,
    miles: 19,
    steps: [],
    label: 'Fastest',
    ...over,
  }
}

const steps = (n: number) => Array.from({ length: n }, () => ({ text: 'go', miles: 1, seconds: 60 }))

describe('formatMinutes', () => {
  it('rounds to whole minutes under an hour', () => {
    expect(formatMinutes(29.4)).toBe('29 min')
  })

  it('breaks into hours past 60', () => {
    expect(formatMinutes(65)).toBe('1 hr 5 min')
    expect(formatMinutes(120)).toBe('2 hr')
  })

  it('never renders a zero-minute trip', () => {
    expect(formatMinutes(0.6)).toBe('1 min')
    expect(formatMinutes(0)).toBe('1 min')
  })
})

describe('formatDistanceToTurn', () => {
  it('says Now once the junction is the thing to look at', () => {
    expect(formatDistanceToTurn(0)).toBe('Now')
    expect(formatDistanceToTurn(29)).toBe('Now')
  })

  it('rounds feet to 50 so the number is actionable, not precise', () => {
    // formatMiles would render 419, 407, 395 — noise at 40 mph, and precision
    // nobody can act on. Nav apps land on the same few round values.
    expect(formatDistanceToTurn(120)).toBe('400 ft')
    expect(formatDistanceToTurn(125)).toBe('400 ft')
    expect(formatDistanceToTurn(150)).toBe('500 ft')
  })

  it('switches to miles once feet stop being useful', () => {
    expect(formatDistanceToTurn(800)).toBe('0.5 mi')
    expect(formatDistanceToTurn(3000)).toBe('1.9 mi')
  })

  it('drops the decimal on long hauls', () => {
    expect(formatDistanceToTurn(40_000)).toBe('25 mi')
  })
})

describe('formatMiles', () => {
  it('switches to feet under 0.2 mi', () => {
    expect(formatMiles(0.1)).toBe('528 ft')
  })

  it('shows one decimal otherwise', () => {
    expect(formatMiles(19.04)).toBe('19.0 mi')
  })
})

describe('formatDelta', () => {
  it('returns null when the difference rounds away', () => {
    // The recommended route compares against itself, and a "(+0)" badge would
    // imply a distinction that is not there.
    expect(formatDelta(0)).toBeNull()
    expect(formatDelta(0.4)).toBeNull()
    expect(formatDelta(-0.4)).toBeNull()
  })

  it('signs slower routes with a plus', () => {
    expect(formatDelta(11)).toBe('+11')
    expect(formatDelta(10.6)).toBe('+11')
  })

  it('signs faster routes with a real minus, not a hyphen', () => {
    expect(formatDelta(-4)).toBe('−4')
    expect(formatDelta(-4)).not.toBe('-4')
  })
})

describe('routeReason', () => {
  it('names the trade-off for each costing strategy', () => {
    expect(routeReason(route({ strategy: 'avoid_highways' }))).toBe('19.0 mi · surface streets')
    expect(routeReason(route({ strategy: 'shortest_distance' }))).toBe('19.0 mi · shortest way')
    expect(routeReason(route({ strategy: 'relaxed' }))).toBe('19.0 mi · calmer roads')
    expect(routeReason(route({ strategy: 'quiet' }))).toBe('19.0 mi · calmer roads')
    expect(routeReason(route({ strategy: 'avoid_tolls' }))).toBe('19.0 mi · no tolls')
    expect(routeReason(route({ strategy: 'well_lit' }))).toBe('19.0 mi · lit streets')
    expect(routeReason(route({ strategy: 'fewer_steps' }))).toBe('19.0 mi · fewer stairs')
  })

  it('counts turns for fewest_turns and for the baseline', () => {
    expect(routeReason(route({ strategy: 'fewest_turns', steps: steps(6) }))).toBe('19.0 mi · 6 turns')
    expect(routeReason(route({ strategy: 'fastest', steps: steps(14) }))).toBe('19.0 mi · 14 turns')
  })

  it('falls back to turn count when the backend sends no strategy', () => {
    // An older backend omits route_strategies entirely.
    expect(routeReason(route({ strategy: undefined, steps: steps(9) }))).toBe('19.0 mi · 9 turns')
  })

  it('treats an absent Valhalla summary flag as unknown, not as false', () => {
    // has_highway is emitted only on some builds/costings. Undefined must not
    // be read as "no highway" — that would put a false claim on the card.
    expect(routeReason(route({ strategy: undefined, hasHighway: undefined, steps: steps(3) })))
      .toBe('19.0 mi · 3 turns')
    expect(routeReason(route({ strategy: undefined, hasHighway: false, steps: steps(3) })))
      .toBe('19.0 mi · surface streets')
    expect(routeReason(route({ strategy: undefined, hasHighway: true, steps: steps(3) })))
      .toBe('19.0 mi · 3 turns')
  })

  it('handles the duplicate "Another way" label without depending on it', () => {
    // Every Valhalla alternate carries this same label, so the reason line has
    // to differentiate them. Two alternates differ by distance and turns.
    const a = route({ label: 'Another way', strategy: undefined, miles: 22.7, steps: steps(6) })
    const b = route({ label: 'Another way', strategy: undefined, miles: 19.0, steps: steps(11) })
    expect(routeReason(a)).not.toBe(routeReason(b))
  })
})

describe('abbreviateRoad', () => {
  it('shortens the names Valhalla actually returns for this region', () => {
    // Every one of these came off a live route response.
    expect(abbreviateRoad('South Cooper Street')).toBe('S Cooper St')
    expect(abbreviateRoad('South Collins Street')).toBe('S Collins St')
    expect(abbreviateRoad('North Fielder Road')).toBe('N Fielder Rd')
    expect(abbreviateRoad('West Park Row Drive')).toBe('W Park Row Dr')
    expect(abbreviateRoad('West Pioneer Parkway')).toBe('W Pioneer Pkwy')
    expect(abbreviateRoad('West Tucker Boulevard')).toBe('W Tucker Blvd')
  })

  it('leaves route numbers alone', () => {
    // They carry no directional and no type word, so the rules simply miss —
    // which is the intended outcome, not a lucky one.
    expect(abbreviateRoad('TX 180')).toBe('TX 180')
    expect(abbreviateRoad('FM 157')).toBe('FM 157')
    expect(abbreviateRoad('I-30')).toBe('I-30')
  })

  it('only abbreviates a type word in final position', () => {
    // "Trail" and "Avenue" here are part of the name, not the road's type.
    expect(abbreviateRoad('Trail Lake Drive')).toBe('Trail Lake Dr')
    expect(abbreviateRoad('Avenue H')).toBe('Avenue H')
  })

  it('keeps a two-token name readable rather than cryptic', () => {
    // A street genuinely called "North Street" must not collapse to "N St".
    expect(abbreviateRoad('North Street')).toBe('North St')
    expect(abbreviateRoad('West Lane')).toBe('West Ln')
  })

  it('handles a directional that trails the type', () => {
    expect(abbreviateRoad('Cooper Street South')).toBe('Cooper St S')
  })

  it('abbreviates compound directions', () => {
    expect(abbreviateRoad('Northwest Green Oaks Boulevard')).toBe('NW Green Oaks Blvd')
  })

  it('is case-insensitive without rewriting the rest of the name', () => {
    expect(abbreviateRoad('SOUTH Cooper STREET')).toBe('S Cooper St')
    expect(abbreviateRoad('South McKinney Street')).toBe('S McKinney St')
  })

  it('returns anything it cannot improve untouched', () => {
    expect(abbreviateRoad('Broadway')).toBe('Broadway')
    expect(abbreviateRoad('')).toBe('')
    expect(abbreviateRoad('Main Loop')).toBe('Main Loop')
  })
})

describe('routeLabels', () => {
  /** An alternate Valhalla threw in: generic label, no strategy of its own. */
  const alt = (over: Partial<ParsedRoute> = {}) =>
    route({ label: 'Another way', strategy: undefined, isPrimary: false, ...over })

  it('leaves a strategy-built route under its own name', () => {
    const labels = routeLabels([
      route({ label: 'Fastest', strategy: 'fastest', isPrimary: true }),
      route({ label: 'No highways', strategy: 'avoid_highways', isPrimary: true }),
    ])
    expect(labels).toEqual(['Fastest', 'No highways'])
  })

  it('names an alternate by the road it mostly runs on, abbreviated', () => {
    const labels = routeLabels([
      route({ label: 'Fastest', isPrimary: true }),
      alt({ viaRoad: 'South Cooper Street' }),
      alt({ viaRoad: 'West Abram Street' }),
    ])
    expect(labels).toEqual(['Fastest', 'via S Cooper St', 'via W Abram St'])
  })

  it('never gives two cards the same name', () => {
    // Two alternates whose dominant road is the same street would both read
    // "via Cooper St" — a worse lie than "Another way", because it claims a
    // distinction and gets it wrong. The second falls through to what it is
    // measurably best at.
    const labels = routeLabels([
      route({ label: 'Fastest', isPrimary: true, miles: 19, steps: steps(10) }),
      alt({ viaRoad: 'Cooper St', miles: 22, steps: steps(4) }),
      alt({ viaRoad: 'Cooper St', miles: 17, steps: steps(9) }),
    ])
    expect(labels[1]).toBe('via Cooper St')
    expect(labels[2]).not.toBe('via Cooper St')
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('falls back to a superlative that is true of the set on offer', () => {
    const labels = routeLabels([
      route({ label: 'Fastest', isPrimary: true, miles: 19, steps: steps(10) }),
      alt({ miles: 12, steps: steps(9) }), // shortest of the three
      alt({ miles: 25, steps: steps(3) }), // fewest turns of the three
    ])
    expect(labels[1]).toBe('Shortest')
    expect(labels[2]).toBe('Fewest turns')
  })

  it('keeps the backend label when there is nothing better to say', () => {
    // No road name, and the primary already owns both superlatives.
    const labels = routeLabels([
      route({ label: 'Fastest', isPrimary: true, miles: 5, steps: steps(2) }),
      alt({ miles: 20, steps: steps(12) }),
    ])
    expect(labels[1]).toBe('Another way')
  })

  it('treats a missing isPrimary as purpose-built, the way an old backend read', () => {
    // route_primary is additive; before it existed every label was taken at
    // face value, and that behaviour has to survive a backend rollback.
    const labels = routeLabels([route({ label: 'Fastest' }), route({ label: 'No highways' })])
    expect(labels).toEqual(['Fastest', 'No highways'])
  })

  it('survives a route with no street names and no steps', () => {
    expect(() => routeLabels([alt({ viaRoad: undefined, steps: [] })])).not.toThrow()
    expect(routeLabels([])).toEqual([])
  })
})

describe('routeDisplayOrder', () => {
  it('hoists the recommended route and preserves backend order behind it', () => {
    expect(routeDisplayOrder(5, 2)).toEqual([2, 0, 1, 3, 4])
  })

  it('is identity when the backend already recommends the first', () => {
    expect(routeDisplayOrder(3, 0)).toEqual([0, 1, 2])
  })

  it('handles the single-candidate short trip', () => {
    // Under 2 miles straight-line the backend runs only the baseline.
    expect(routeDisplayOrder(1, 0)).toEqual([0])
  })

  it('does not invent an index when recommendedIndex is out of range', () => {
    expect(routeDisplayOrder(3, 7)).toEqual([0, 1, 2])
  })
})
