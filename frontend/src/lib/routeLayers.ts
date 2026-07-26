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

export const SELECTED_SOURCE = 'gw-route-selected'
export const ALT_SOURCE = 'gw-routes-alt'
export const ALT_LAYER = 'gw-routes-alt'

const GLOW_GRADIENT = [
  'interpolate',
  ['linear'],
  ['line-progress'],
  0,
  '#3ee7ed',
  1,
  '#05767a',
]

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

function layerSpecs(theme: Theme) {
  const dark = theme === 'dark'
  const specs: object[] = [
    {
      id: ALT_LAYER,
      type: 'line',
      source: ALT_SOURCE,
      layout: ROUND,
      paint: {
        'line-color': dark ? '#8b93a7' : '#9aa3b2',
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3.5, 16, 5],
        'line-opacity': dark ? 0.55 : 0.6,
      },
    },
    {
      id: 'gw-route-halo',
      type: 'line',
      source: SELECTED_SOURCE,
      layout: ROUND,
      paint: {
        'line-gradient': GLOW_GRADIENT,
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
        'line-color': '#ffffff',
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
        'line-gradient': GLOW_GRADIENT,
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
 * Idempotently ensures sources+layers exist for the theme, then updates data.
 * Cheap on selection change (setData only); rebuilds layers when theme paints
 * must change.
 */
export function syncRouteLayers(
  map: MaplibreMap,
  routes: ParsedRoute[],
  selectedIndex: number,
  theme: Theme,
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
    for (const spec of layerSpecs(theme)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      map.addLayer(spec as any, beforeId)
    }
  }
}
