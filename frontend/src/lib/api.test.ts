// Covers the parsing helpers that turn a raw Valhalla trip into something the
// route cards can name. The HTTP functions around them are exercised through
// the app; what's worth pinning here is the geometry-free judgement calls.
import { describe, expect, it } from 'vitest'

import { dominantStreet } from './api'

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
