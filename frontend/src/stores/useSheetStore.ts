// How tall the bottom sheet currently is, and how tall it wants to be.
//
// This is a store rather than component state because MapView is a *sibling* of
// the sheet, not a descendant, and it needs the live height to keep the route
// clear of the sheet when fitting bounds.
import { create } from 'zustand'

export type Snap = 'peek' | 'half' | 'full'

export const SNAP_ORDER: Snap[] = ['peek', 'half', 'full']

/** Must match the dvh values on `.sheet[data-snap]` in index.css. */
export const SNAP_FRACTION: Record<Snap, number> = {
  peek: 0.26,
  half: 0.5,
  full: 0.88,
}

interface SheetState {
  snap: Snap
  /**
   * Measured height in CSS pixels, published by a ResizeObserver on the sheet.
   * Measured, not computed from dvh × innerHeight: mobile browser chrome slides
   * in and out while driving, so that mapping shifts underneath you.
   */
  heightPx: number
  setSnap(snap: Snap): void
  /** Advance peek → half → full → peek. The tap-the-grabber path. */
  cycleSnap(): void
  setHeightPx(px: number): void
}

export const useSheetStore = create<SheetState>((set, get) => ({
  snap: 'half',
  heightPx: 0,

  setSnap(snap) {
    if (get().snap !== snap) set({ snap })
  },

  cycleSnap() {
    const next = SNAP_ORDER[(SNAP_ORDER.indexOf(get().snap) + 1) % SNAP_ORDER.length]
    set({ snap: next })
  },

  setHeightPx(px) {
    // Sub-pixel churn from the ResizeObserver would re-render MapView on every
    // frame of the height transition.
    if (Math.abs(get().heightPx - px) >= 1) set({ heightPx: px })
  },
}))

/** Nearest snap to a dragged pixel height. */
export function nearestSnap(heightPx: number, viewportPx: number): Snap {
  let best: Snap = 'peek'
  let bestDistance = Infinity
  for (const snap of SNAP_ORDER) {
    const distance = Math.abs(SNAP_FRACTION[snap] * viewportPx - heightPx)
    if (distance < bestDistance) {
      bestDistance = distance
      best = snap
    }
  }
  return best
}

/**
 * Where a drag should land: a decisive flick moves one step in its own
 * direction regardless of distance, otherwise the nearest snap wins.
 *
 * `velocity` is px/ms, positive when the sheet is growing (dragging up).
 */
export function resolveSnap(
  heightPx: number,
  viewportPx: number,
  velocity: number,
  from: Snap,
): Snap {
  const FLICK = 0.5
  if (Math.abs(velocity) > FLICK) {
    const step = velocity > 0 ? 1 : -1
    const index = SNAP_ORDER.indexOf(from)
    const next = Math.min(SNAP_ORDER.length - 1, Math.max(0, index + step))
    return SNAP_ORDER[next]
  }
  return nearestSnap(heightPx, viewportPx)
}
