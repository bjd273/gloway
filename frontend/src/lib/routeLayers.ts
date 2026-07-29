// The glowing route — Gloway's visual signature — plus dim alternate routes.
//
// Everything map-owned that we add at runtime uses the `gw-` id prefix. That
// prefix is the contract the theme-swap logic relies on (MapView preserves
// `gw-` sources across setStyle, then re-adds these layers with the right
// theme's paints).
import type { GeoJSONSource, Map as MaplibreMap } from 'maplibre-gl'
import type { Feature, FeatureCollection, LineString } from 'geojson'

import type { ParsedRoute } from './api'
import type { Theme } from './mapStyles'
import { ROUTE_COLORS } from './routeColors'

export const SELECTED_SOURCE = 'gw-route-selected'
export const ALT_SOURCE = 'gw-routes-alt'
export const ALT_LAYER = 'gw-routes-alt'

/**
 * Where the lit part of the ribbon begins, as a fraction of route length.
 * A short ramp rather than a hard cut: at a hard cut the boundary advances in
 * visible stair-steps as `line-progress` quantises across zoom levels, and the
 * ramp gives the puck a lit lip to sit on instead of appearing to drag a wall.
 */
const PROGRESS_EDGE = 0.006

/** Fully transparent — the traveled span's "colour" in the glow layer. There
 * is no glow behind you; the halo exists to say "this way". */
const CLEAR = 'rgba(0, 0, 0, 0)'

type ColorAt = (fraction: number) => string

function hexChannels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** The colour the full-length glow gradient shows at `fraction`.
 *
 * The lit remainder stays on this ORIGINAL ramp rather than restarting it at
 * the driver, so a given stretch of road keeps the same colour for the whole
 * drive. Restarting looked livelier in isolation and awful in motion: the
 * ribbon recoloured itself under you continuously, which reads as the route
 * changing rather than as you advancing along it. */
function glowAt(fraction: number): string {
  const a = hexChannels(ROUTE_COLORS.glowA)
  const b = hexChannels(ROUTE_COLORS.glowB)
  const mix = a.map((channel, i) => Math.round(channel + (b[i] - channel) * fraction))
  return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`
}

/** The casing is one flat white the whole way — it just needs to be expressed
 * as a gradient so its traveled half can be dimmed in place. */
const whiteAt: ColorAt = () => '#ffffff'

function fullGradient(colorAt: ColorAt): unknown[] {
  return ['interpolate', ['linear'], ['line-progress'], 0, colorAt(0), 1, colorAt(1)]
}

/**
 * `dim` behind the driver, the layer's normal colour ahead of them.
 *
 * `progress` is a fraction of route LENGTH (see routeProgress.ts). Stops must
 * be strictly ascending or MapLibre rejects the expression, hence the clamp:
 * it keeps the boundary off both ends no matter what progress arrives.
 */
function splitGradient(dim: string, colorAt: ColorAt, progress: number): unknown[] {
  // Arrived: the whole line is behind you.
  if (progress >= 1) return ['interpolate', ['linear'], ['line-progress'], 0, dim, 1, dim]
  const lo = Math.min(Math.max(progress, PROGRESS_EDGE), 1 - PROGRESS_EDGE * 2)
  const hi = lo + PROGRESS_EDGE
  return [
    'interpolate',
    ['linear'],
    ['line-progress'],
    0,
    dim,
    lo,
    dim,
    hi,
    colorAt(hi),
    1,
    colorAt(1),
  ]
}

// Paint for the unselected lines, driven off the `index` property each alt
// feature already carries. Hovering a route card brightens and thickens that
// one line — still neutral, so it reads as "this one" rather than as a second
// accent competing with the selected route.
function altPaint(theme: Theme, hoveredIndex: number | null) {
  const t = theme === 'dark' ? 'dark' : 'light'
  const isHovered = ['==', ['get', 'index'], hoveredIndex ?? -1]
  const rest = theme === 'dark' ? 0.55 : 0.6
  return {
    'line-color': ['case', isHovered, ROUTE_COLORS.altHover[t], ROUTE_COLORS.alt[t]],
    // One zoom interpolation with the hover branch at each stop — MapLibre
    // rejects an expression containing two zoom-based subexpressions, which a
    // ['case', hovered, interpolate(...), interpolate(...)] would be.
    'line-width': [
      'interpolate',
      ['linear'],
      ['zoom'],
      12,
      ['case', isHovered, 5, 3.5],
      16,
      ['case', isHovered, 7, 5],
    ],
    'line-opacity': ['case', isHovered, 0.95, rest],
  }
}

const ROUND = { 'line-cap': 'round' as const, 'line-join': 'round' as const }

function selectedFeature(route: ParsedRoute | undefined): Feature<LineString> {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: route?.coords ?? [] },
  }
}

function altCollection(routes: ParsedRoute[], selectedIndex: number): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: routes
      .map((route, index) => ({ route, index }))
      .filter(({ index }) => index !== selectedIndex)
      .map(({ route, index }) => ({
        type: 'Feature' as const,
        properties: { index },
        geometry: { type: 'LineString' as const, coordinates: route.coords },
      })),
  }
}

function layerSpecs(theme: Theme, hoveredIndex: number | null) {
  const specs: object[] = [
    {
      id: ALT_LAYER,
      type: 'line',
      source: ALT_SOURCE,
      layout: ROUND,
      paint: altPaint(theme, hoveredIndex),
    },
    {
      id: 'gw-route-halo',
      type: 'line',
      source: SELECTED_SOURCE,
      layout: ROUND,
      paint: {
        'line-gradient': fullGradient(glowAt),
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 12, 16, 26],
        'line-blur': 12,
        'line-opacity': 0.28,
      },
    },
    // The crisp white casing is what makes the gradient core read as a solid
    // glowing ribbon — on a pale basemap for contrast, on a near-black one as
    // the ribbon's body. (A dark-only halo+thin-white-center variant was tried
    // and read as "only the edges glow".)
    {
      id: 'gw-route-casing',
      type: 'line',
      source: SELECTED_SOURCE,
      layout: ROUND,
      paint: {
        // A gradient rather than a flat `line-color` purely so the traveled
        // half can be greyed out in place — `line-color` cannot vary along a
        // line, and swapping the layer per frame would drop frames.
        'line-gradient': fullGradient(whiteAt),
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 7.5, 16, 11],
        'line-opacity': 0.9,
      },
    },
    {
      id: 'gw-route-core',
      type: 'line',
      source: SELECTED_SOURCE,
      layout: ROUND,
      paint: {
        'line-gradient': fullGradient(glowAt),
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 4.5, 16, 8],
        'line-opacity': 1,
      },
    },
  ]
  return specs
}

/** First symbol layer id — routes render under labels, over roads. */
function firstSymbolLayerId(map: MaplibreMap): string | undefined {
  return map.getStyle().layers.find((l) => l.type === 'symbol')?.id
}

export function removeRouteLayers(map: MaplibreMap): void {
  for (const layer of map.getStyle().layers.filter((l) => l.id.startsWith('gw-'))) {
    map.removeLayer(layer.id)
  }
}

/**
 * Repaint the selected route for how far the drive has got: everything behind
 * the driver goes flat grey and loses its glow, everything ahead keeps the
 * ribbon. `progress` is a fraction of route LENGTH (see routeProgress.ts) —
 * index-based progress puts the boundary in the wrong place on any route with
 * uneven point spacing, which is every real route. Pass 0 for the planning
 * view, where the whole route is "ahead".
 *
 * Paint-only and idempotent: this runs on every GPS fix, and rebuilding four
 * layers at 1Hz would drop frames mid-drive.
 */
export function setRouteProgress(map: MaplibreMap, theme: Theme, progress: number): void {
  if (!map.getLayer('gw-route-core')) return
  const t = theme === 'dark' ? 'dark' : 'light'
  const driving = progress > 0
  const gradients: [string, unknown[]][] = [
    [
      'gw-route-halo',
      driving ? splitGradient(CLEAR, glowAt, progress) : fullGradient(glowAt),
    ],
    [
      'gw-route-casing',
      driving
        ? splitGradient(ROUTE_COLORS.traveledCasing[t], whiteAt, progress)
        : fullGradient(whiteAt),
    ],
    [
      'gw-route-core',
      driving
        ? splitGradient(ROUTE_COLORS.traveledCore[t], glowAt, progress)
        : fullGradient(glowAt),
    ],
  ]
  for (const [layer, gradient] of gradients) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    map.setPaintProperty(layer, 'line-gradient', gradient as any)
  }
}

/**
 * Idempotently ensures sources+layers exist for the theme, then updates data.
 * Cheap on selection change (setData only); rebuilds layers when theme paints
 * must change.
 *
 * `progress` is re-applied on every call because a rebuild — which a theme
 * swap triggers — resets the layers to their full-length gradients. Losing it
 * there would relight the whole route mid-drive the moment the phone crossed
 * into dark mode at dusk.
 */
export function syncRouteLayers(
  map: MaplibreMap,
  routes: ParsedRoute[],
  selectedIndex: number,
  theme: Theme,
  hoveredIndex: number | null = null,
  progress = 0,
): void {
  const selectedData = selectedFeature(routes[selectedIndex])
  const altData = altCollection(routes, selectedIndex)

  if (!map.getSource(SELECTED_SOURCE)) {
    // lineMetrics is required for line-gradient; negligible cost for one line.
    map.addSource(SELECTED_SOURCE, { type: 'geojson', data: selectedData, lineMetrics: true })
    map.addSource(ALT_SOURCE, { type: 'geojson', data: altData })
  } else {
    ;(map.getSource(SELECTED_SOURCE) as GeoJSONSource).setData(selectedData)
    ;(map.getSource(ALT_SOURCE) as GeoJSONSource).setData(altData)
  }

  // The stack is the same shape in both themes (theme only tints the alt
  // routes), so any missing layer means rebuild — which theme swaps trigger
  // naturally: setStyle drops every layer, then the styledata hook lands here.
  if (!map.getLayer(ALT_LAYER) || !map.getLayer('gw-route-casing')) {
    removeRouteLayers(map)
    const beforeId = firstSymbolLayerId(map)
    for (const spec of layerSpecs(theme, hoveredIndex)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      map.addLayer(spec as any, beforeId)
    }
    setRouteProgress(map, theme, progress)
    return
  }

  // Hover changes on pointer-move, so it repaints in place. Rebuilding four
  // layers per pointer event would thrash.
  const paint = altPaint(theme, hoveredIndex)
  for (const [prop, value] of Object.entries(paint)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    map.setPaintProperty(ALT_LAYER, prop as any, value as any)
  }
  setRouteProgress(map, theme, progress)
}
