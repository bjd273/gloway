import { describe, expect, it } from 'vitest'

import {
  approach,
  approachAngle,
  lerpAngle,
  shortestAngleDelta,
  smoothFactor,
  smoothstep,
  wrap360,
} from './smoothing'

describe('shortestAngleDelta', () => {
  it('takes the short way across north in both directions', () => {
    // The bug this prevents: a northbound driver crossing 0 sends the camera
    // 358 degrees the long way round, mid-turn.
    expect(shortestAngleDelta(359, 1)).toBe(2)
    expect(shortestAngleDelta(1, 359)).toBe(-2)
  })

  it('is signed by direction of travel', () => {
    expect(shortestAngleDelta(10, 40)).toBe(30)
    expect(shortestAngleDelta(40, 10)).toBe(-30)
  })

  it('never returns more than half a turn', () => {
    for (let from = 0; from < 360; from += 7) {
      for (let to = 0; to < 360; to += 11) {
        expect(Math.abs(shortestAngleDelta(from, to))).toBeLessThanOrEqual(180)
      }
    }
  })
})

describe('wrap360', () => {
  it('folds negatives and overflow back into range', () => {
    expect(wrap360(-10)).toBe(350)
    expect(wrap360(370)).toBe(10)
    expect(wrap360(0)).toBe(0)
  })
})

describe('approach', () => {
  it('is frame-rate independent', () => {
    // The property the exponential form exists for: the camera must land in the
    // same place whether the browser gave us 10 frames or 1. A fixed per-frame
    // factor breaks this, and it is the most likely later "simplification".
    const tau = 0.4
    let stepped = 0
    for (let i = 0; i < 10; i += 1) stepped = approach(stepped, 100, 0.1, tau)
    const single = approach(0, 100, 1.0, tau)
    expect(stepped).toBeCloseTo(single, 9)
  })

  it('closes ~63% of the gap in one time constant', () => {
    expect(approach(0, 100, 0.5, 0.5)).toBeCloseTo(63.2, 1)
  })

  it('converges without overshooting', () => {
    let value = 0
    for (let i = 0; i < 500; i += 1) {
      value = approach(value, 10, 1 / 60, 0.35)
      expect(value).toBeLessThanOrEqual(10)
    }
    expect(value).toBeCloseTo(10, 6)
  })

  it('treats a zero time constant as an immediate jump', () => {
    expect(approach(0, 42, 0.016, 0)).toBe(42)
  })
})

describe('approachAngle', () => {
  it('crosses north the short way rather than unwinding', () => {
    const next = approachAngle(350, 10, 0.1, 0.2)
    // Somewhere between 350 and 370-wrapped — never down through 180.
    expect(next > 350 || next < 10).toBe(true)
    expect(next).toBeGreaterThan(180)
  })

  it('accumulates no wrap error over repeated crossings', () => {
    let bearing = 0
    for (let lap = 0; lap < 20; lap += 1) {
      for (const target of [90, 180, 270, 0]) {
        for (let i = 0; i < 120; i += 1) bearing = approachAngle(bearing, target, 1 / 60, 0.2)
      }
    }
    expect(bearing).toBeGreaterThanOrEqual(0)
    expect(bearing).toBeLessThan(360)
    expect(Math.abs(shortestAngleDelta(bearing, 0))).toBeLessThan(0.5)
  })

  it('always returns a value in 0..360', () => {
    for (const [from, to] of [[359, 1], [1, 359], [180, 0], [0, 180]]) {
      const next = approachAngle(from, to, 0.5, 0.3)
      expect(next).toBeGreaterThanOrEqual(0)
      expect(next).toBeLessThan(360)
    }
  })
})

describe('lerpAngle', () => {
  it('blends the short way', () => {
    expect(lerpAngle(350, 10, 0.5)).toBeCloseTo(0, 6)
  })

  it('returns the endpoints exactly', () => {
    expect(lerpAngle(350, 10, 0)).toBeCloseTo(350, 6)
    expect(lerpAngle(350, 10, 1)).toBeCloseTo(10, 6)
  })
})

describe('smoothFactor', () => {
  it('grows with dt and never exceeds 1', () => {
    expect(smoothFactor(0, 0.5)).toBe(0)
    expect(smoothFactor(0.1, 0.5)).toBeLessThan(smoothFactor(0.5, 0.5))
    expect(smoothFactor(100, 0.5)).toBeLessThanOrEqual(1)
  })
})

describe('smoothstep', () => {
  it('is flat outside the edges and monotonic between them', () => {
    expect(smoothstep(10, 20, 5)).toBe(0)
    expect(smoothstep(10, 20, 25)).toBe(1)
    expect(smoothstep(10, 20, 15)).toBeCloseTo(0.5, 6)
    expect(smoothstep(10, 20, 12)).toBeLessThan(smoothstep(10, 20, 18))
  })

  it('degenerates to a step when the edges coincide', () => {
    expect(smoothstep(10, 10, 9)).toBe(0)
    expect(smoothstep(10, 10, 11)).toBe(1)
  })
})
