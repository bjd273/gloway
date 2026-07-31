import { describe, expect, it } from 'vitest'

import type { LaneInfo } from './api'
import { decodeLanes, laneHint } from './lanes'

const lane = (indications: string[], over: Partial<LaneInfo> = {}): LaneInfo => ({
  indications,
  valid: false,
  active: false,
  ...over,
})

describe('decodeLanes', () => {
  it('reads a lane’s arrows, validity and the one to follow', () => {
    const [decoded] = decodeLanes([
      lane(['right'], { valid: true, active: true, valid_indication: 'right' }),
    ])
    expect(decoded).toEqual({ arrows: ['right'], valid: true, active: 'right' })
  })

  it('orders arrows as they are painted, not as they arrive', () => {
    // A lane marked "left + through" is painted with the left arrow beside the
    // straight one. Rendering them in response order — or any other order —
    // would draw a lane that doesn't match the tarmac.
    const [ltr] = decodeLanes([lane(['left', 'straight'])])
    const [rtl] = decodeLanes([lane(['straight', 'left'])])
    expect(ltr.arrows).toEqual(['left', 'through'])
    expect(rtl.arrows).toEqual(['left', 'through'])
  })

  it('places every indication in road order', () => {
    const [decoded] = decodeLanes([
      lane(['sharp right', 'uturn', 'straight', 'slight left', 'right']),
    ])
    expect(decoded.arrows).toEqual(['uturn', 'slight-left', 'through', 'right', 'sharp-right'])
  })

  it('marks a lane inactive when it is not the one to be in', () => {
    const decoded = decodeLanes([
      lane(['left'], { valid: false }),
      lane(['straight'], { valid: true, active: true, valid_indication: 'straight' }),
      lane(['straight'], { valid: true, active: false, valid_indication: 'straight' }),
    ])
    expect(decoded.map((l) => l.valid)).toEqual([false, true, true])
    expect(decoded.map((l) => l.active)).toEqual([null, 'through', null])
  })

  it('never marks an invalid lane active, whatever the payload says', () => {
    // Following an arrow in a lane that leaves the route is the one thing this
    // display must not tell someone to do.
    const [decoded] = decodeLanes([
      lane(['left'], { valid: false, active: true, valid_indication: 'left' }),
    ])
    expect(decoded.active).toBeNull()
  })

  it('infers the arrow to follow when a valid lane has only one', () => {
    const [decoded] = decodeLanes([lane(['right'], { valid: true, active: true })])
    expect(decoded.active).toBe('right')
  })

  it('handles missing or unknown fields without throwing', () => {
    expect(decodeLanes(undefined)).toEqual([])
    expect(decodeLanes([])).toEqual([])
    expect(decodeLanes([{ indications: [], valid: true, active: false }])[0].arrows).toEqual([])
    expect(decodeLanes([lane(['sideways'])])[0].arrows).toEqual([])
  })
})

describe('laneHint', () => {
  const decode = (specs: [string[], boolean][]) =>
    decodeLanes(specs.map(([ind, valid]) => lane(ind, { valid })))

  it('names a run of lanes on the left', () => {
    const hint = laneHint(
      decode([
        [['left'], true],
        [['left'], true],
        [['straight'], false],
      ]),
    )
    expect(hint).toBe('Use the left 2 lanes')
  })

  it('names a single lane on the right without pluralising', () => {
    const hint = laneHint(
      decode([
        [['straight'], false],
        [['right'], true],
      ]),
    )
    expect(hint).toBe('Use the right lane')
  })

  it('says any lane when every one of them works', () => {
    expect(laneHint(decode([[['straight'], true], [['straight'], true]]))).toBe('Any lane')
  })

  it('avoids a misleading phrase when the valid lanes are split', () => {
    // "the left 2 lanes" would be wrong here — they aren't adjacent.
    const hint = laneHint(
      decode([
        [['left'], true],
        [['straight'], false],
        [['right'], true],
      ]),
    )
    expect(hint).toBe('Use any of 2 marked lanes')
  })

  it('has nothing to say when no lane serves the turn', () => {
    // Which is the same condition that hides the strip — an all-invalid row is
    // far likelier bad data than a junction you genuinely cannot turn at.
    expect(laneHint(decode([[['left'], false], [['straight'], false]]))).toBeNull()
    expect(laneHint([])).toBeNull()
  })
})
