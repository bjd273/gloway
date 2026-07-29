// The only place route-line colours are written down.
//
// These values are consumed twice — by the MapLibre paint expressions in
// routeLayers.ts, and by the route cards, which publish them to CSS as inline
// custom properties. That indirection exists so a card's swatch and its line on
// the map cannot drift apart: they read the same constant.
//
// Deliberately NOT one colour per route. Six coloured lines is the cluttered
// map-app look DESIGN.md names as its anti-reference, and it would break the
// Neutral Alternates Rule — anything the user has not chosen renders grey, so
// that selection is the only thing that earns colour. The card↔line link is
// carried by hover instead: pointing at a card brightens its line.

import type { Theme } from './mapStyles'

export const ROUTE_COLORS = {
  /** Gradient start — the selected route's bright end, at the origin. */
  glowA: '#3ee7ed',
  /** Gradient end — the selected route's deep end, at the destination. */
  glowB: '#05767a',
  /** Unselected routes, at rest. */
  alt: { light: '#9aa3b2', dark: '#8b93a7' },
  /** Unselected route being previewed from its card. Still neutral — it reads
   *  as "this one", not as a second accent competing with the selection. */
  altHover: { light: '#6d7688', dark: '#b6bdcc' },
  /**
   * The stretch of the selected route already driven. Two tones because the
   * ribbon is two stacked lines: the wide casing goes lighter, the narrow core
   * goes darker, so the traveled span still reads as a drawn road rather than
   * a smudge — just a spent one. Deliberately translucent, so the basemap
   * comes back through behind the driver and the lit remainder is the only
   * thing on screen still claiming attention.
   *
   * rgba() rather than hex because these are consumed as `line-gradient`
   * stops, where the alpha channel is the whole point (see routeLayers.ts).
   */
  traveledCasing: { light: 'rgba(150, 158, 173, 0.5)', dark: 'rgba(104, 113, 133, 0.45)' },
  traveledCore: { light: 'rgba(109, 118, 136, 0.72)', dark: 'rgba(139, 147, 167, 0.55)' },
} as const

/** The colour a given route's line is currently drawn in. */
export function routeLineColor(
  index: number,
  selectedIndex: number,
  theme: Theme,
): string {
  // The selected line is a gradient; its deep end is the honest single-colour
  // stand-in for a card swatch.
  return index === selectedIndex ? ROUTE_COLORS.glowB : ROUTE_COLORS.alt[theme]
}
