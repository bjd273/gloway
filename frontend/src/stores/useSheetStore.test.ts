import { describe, expect, it } from 'vitest'

import { nearestSnap, resolveSnap, SNAP_FRACTION } from './useSheetStore'

const VIEWPORT = 800
const px = (snap: keyof typeof SNAP_FRACTION) => SNAP_FRACTION[snap] * VIEWPORT

describe('nearestSnap', () => {
  it('snaps to whichever height is closest', () => {
    expect(nearestSnap(px('peek'), VIEWPORT)).toBe('peek')
    expect(nearestSnap(px('half'), VIEWPORT)).toBe('half')
    expect(nearestSnap(px('full'), VIEWPORT)).toBe('full')
  })

  it('resolves a height between two snaps to the nearer one', () => {
    // peek is 208px, half is 400px — 260 is nearer peek, 360 nearer half.
    expect(nearestSnap(260, VIEWPORT)).toBe('peek')
    expect(nearestSnap(360, VIEWPORT)).toBe('half')
  })

  it('clamps a rubber-banded overshoot to the extremes', () => {
    expect(nearestSnap(0, VIEWPORT)).toBe('peek')
    expect(nearestSnap(VIEWPORT * 1.2, VIEWPORT)).toBe('full')
  })
})

describe('resolveSnap', () => {
  it('follows a decisive upward flick one step, regardless of distance', () => {
    // Barely moved, but thrown upward — intent beats displacement.
    expect(resolveSnap(px('peek') + 5, VIEWPORT, 1.4, 'peek')).toBe('half')
    expect(resolveSnap(px('half') + 5, VIEWPORT, 1.4, 'half')).toBe('full')
  })

  it('follows a decisive downward flick one step', () => {
    expect(resolveSnap(px('full') - 5, VIEWPORT, -1.4, 'full')).toBe('half')
    expect(resolveSnap(px('half') - 5, VIEWPORT, -1.4, 'half')).toBe('peek')
  })

  it('does not run past the ends on a flick', () => {
    expect(resolveSnap(px('full'), VIEWPORT, 2, 'full')).toBe('full')
    expect(resolveSnap(px('peek'), VIEWPORT, -2, 'peek')).toBe('peek')
  })

  it('falls back to nearest when the drag was slow', () => {
    // A slow drag is a deliberate placement, so honour where it was let go.
    expect(resolveSnap(px('full'), VIEWPORT, 0.1, 'peek')).toBe('full')
    expect(resolveSnap(px('peek'), VIEWPORT, -0.05, 'full')).toBe('peek')
  })
})
