// Frame-rate-independent smoothing, and the angle arithmetic that goes with it.
//
// Pure functions, no MapLibre, no DOM — driveCamera.ts is the only caller, and
// keeping the maths here is what makes it testable without a map.
//
// Everything uses a first-order lag ("exponential approach") rather than a
// spring. Three reasons, in order of how much they matter here:
//
//   1. It cannot overshoot. A spring settling onto a bearing swings past it
//      first, which reads as the camera rocking at the end of every turn —
//      precisely the "camera drifting rather than tracking" the old per-fix
//      easeTo comment warned about.
//   2. One constant per channel (the time constant) instead of two.
//   3. `1 - exp(-dt/tau)` is exactly frame-rate independent: ten steps of 0.1s
//      land on the same value as one step of 1.0s. That is a property a test
//      can assert, and it is the one most likely to be quietly broken by a
//      later "simplification" to a fixed per-frame factor.
//
// A time constant is "seconds to cover 63% of the remaining gap"; ~3x tau to
// cover 95%. So tau = 0.35 settles in about a second.

/** Fold any angle into 0..360. */
export function wrap360(degrees: number): number {
  return ((degrees % 360) + 360) % 360
}

/**
 * Signed degrees from `from` to `to`, always taking the short way (-180..180].
 *
 * Without this a driver heading north crosses 0 and the camera spins 358
 * degrees the long way round — a full rotation, at the exact moment they are
 * looking at the screen to make a turn.
 */
export function shortestAngleDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180
}

/**
 * Fraction of the remaining gap to close this frame.
 *
 * `dt` is clamped by the caller, not here: a monitor-refresh hiccup and a
 * five-second backgrounded tab both arrive as a large dt, and the right
 * response is the same (don't jump), but only the caller knows the budget.
 */
export function smoothFactor(dtSeconds: number, tauSeconds: number): number {
  if (tauSeconds <= 0) return 1
  return 1 - Math.exp(-dtSeconds / tauSeconds)
}

/** Move `current` toward `target` by one frame's worth of smoothing. */
export function approach(
  current: number,
  target: number,
  dtSeconds: number,
  tauSeconds: number,
): number {
  return current + (target - current) * smoothFactor(dtSeconds, tauSeconds)
}

/** `approach` for compass bearings: short way round, result wrapped to 0..360. */
export function approachAngle(
  current: number,
  target: number,
  dtSeconds: number,
  tauSeconds: number,
): number {
  const delta = shortestAngleDelta(current, target)
  return wrap360(current + delta * smoothFactor(dtSeconds, tauSeconds))
}

/** Linear blend, for callers that already have their own weight. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Blend two bearings, short way round. */
export function lerpAngle(a: number, b: number, t: number): number {
  return wrap360(a + shortestAngleDelta(a, b) * t)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Hermite ease between two edges — 0 below `edge0`, 1 above `edge1`.
 *
 * Used for every confidence gate in snapToRoute, so that nothing the driver
 * sees switches on a hard threshold: a puck that pops between snapped and raw
 * as the GPS wanders across a line is worse than either behaviour on its own.
 */
export function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 === edge0) return value < edge0 ? 0 : 1
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}
