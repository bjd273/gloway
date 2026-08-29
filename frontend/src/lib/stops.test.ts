import { describe, expect, it } from 'vitest'

import { stopsAhead } from './stops'

/** A straight ~940m west→east route: 11 points, ~94m apart. */
const ROUTE: [number, number][] = Array.from({ length: 11 }, (_, i) => [
  -97.13 + i * 0.001,
  32.72,
])

/** A stop sitting on the route at point `i` (so ~94i metres along). */
const at = (i: number, label: string) => ({ lng: -97.13 + i * 0.001, lat: 32.72, label })

describe('stopsAhead', () => {
  it('drops the stops already driven past', () => {
    const stops = [at(2, 'coffee'), at(8, 'petrol')]
    // Halfway along: the stop at point 2 (~188m) is behind, point 8 (~750m) ahead.
    expect(stopsAhead(stops, ROUTE, 0.5).map((s) => s.label)).toEqual(['petrol'])
  })

  it('keeps every stop at the start of a drive', () => {
    const stops = [at(2, 'coffee'), at(8, 'petrol')]
    expect(stopsAhead(stops, ROUTE, 0)).toHaveLength(2)
  })

  it('treats a stop the driver has all but reached as done', () => {
    // The commonest reason a reroute fires near a stop is that the driver
    // pulled into its car park. Re-inserting a waypoint they are standing in
    // would route them back out of the lot and round the block to re-enter it.
    const stops = [at(5, 'coffee')] // ~470m along a ~940m route
    expect(stopsAhead(stops, ROUTE, 0.49)).toHaveLength(0) // 10m short of it
    expect(stopsAhead(stops, ROUTE, 0.4)).toHaveLength(1) // 94m short: still to come
  })

  it('keeps a stop nowhere near the route rather than guessing', () => {
    // It projects onto whichever end is nearest, and that number means nothing
    // — but it still compares against the odometer, and on a route mostly
    // driven it compares as "behind". That silently deleted stops the driver
    // had not been anywhere near.
    const stops = [{ lng: -97.2, lat: 32.8, label: 'miles away' }]
    expect(stopsAhead(stops, ROUTE, 0.9)).toHaveLength(1)
  })

  it('passes stops through untouched when there is no usable route', () => {
    const stops = [at(2, 'coffee')]
    expect(stopsAhead(stops, [], 0.5)).toEqual(stops)
    expect(stopsAhead([], ROUTE, 0.5)).toEqual([])
  })
})
