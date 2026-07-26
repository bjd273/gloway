/**
 * Vendors the dark basemap style into src/styles/mapStyleDark.json.
 *
 * Source: openmaptiles/dark-matter-gl-style (BSD-3 code / CC-BY 4.0 design),
 * pinned to a commit so re-runs are reproducible. The upstream style targets
 * MapTiler-hosted tiles/fonts/sprites; this script rewrites it for our
 * self-hosted stack:
 *   - openmaptiles source -> our Martin tile endpoint (relative URL; resolved
 *     against window.location.origin at runtime in lib/mapStyles.ts)
 *   - glyphs -> OpenFreeMap's font CDN, with Metropolis stacks mapped to the
 *     Noto Sans stacks OpenFreeMap actually hosts
 *   - sprite dropped + icon layers removed (dark-matter only uses icons for
 *     oneway arrows and place dots; a label-only dark map beats mismatched
 *     icons from a light sprite)
 *   - building-3d fill-extrusion added (upstream has none), matching the
 *     light style's zoom handoff so the 3D-on-zoom-in behavior is identical
 *     in both themes
 *
 * Run manually when bumping the upstream pin:  npm run vendor:styles
 * The output is committed — builds never fetch from GitHub.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PINNED_COMMIT = 'd17442cb66bad8c82bda59d199d5dafeead410cf'
const UPSTREAM = `https://raw.githubusercontent.com/openmaptiles/dark-matter-gl-style/${PINNED_COMMIT}/style.json`

const TILE_URL = '/api/tiles/region/{z}/{x}/{y}'
const GLYPHS_URL = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf'
const ATTRIBUTION =
  '&copy; <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> ' +
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap contributors</a>'

// Stacks OpenFreeMap hosts (verified served): Noto Sans Regular/Italic/Bold.
const FONT_MAP = {
  'Metropolis Regular': 'Noto Sans Regular',
  'Metropolis Light': 'Noto Sans Regular',
  'Metropolis Thin': 'Noto Sans Regular',
  'Metropolis Medium': 'Noto Sans Bold',
  'Metropolis Semi Bold': 'Noto Sans Bold',
  'Metropolis Bold': 'Noto Sans Bold',
  'Metropolis Regular Italic': 'Noto Sans Italic',
  'Metropolis Light Italic': 'Noto Sans Italic',
  'Metropolis Medium Italic': 'Noto Sans Italic',
  'Noto Sans Regular': 'Noto Sans Regular',
  'Noto Sans Italic': 'Noto Sans Italic',
  'Noto Sans Bold': 'Noto Sans Bold',
}

const style = await (await fetch(UPSTREAM)).json()

style.name = 'Gloway Dark'
style.metadata = { 'gloway:vendored-from': `openmaptiles/dark-matter-gl-style@${PINNED_COMMIT}` }
delete style.id
delete style.sprite

style.sources = {
  openmaptiles: {
    type: 'vector',
    tiles: [TILE_URL],
    minzoom: 0,
    maxzoom: 14,
    attribution: ATTRIBUTION,
  },
}
style.glyphs = GLYPHS_URL

style.layers = style.layers
  // Icon-only layers (oneway arrows) can't render without a sprite.
  .filter((layer) => {
    const layout = layer.layout ?? {}
    return !('icon-image' in layout && !('text-field' in layout))
  })
  .map((layer) => {
    const layout = { ...(layer.layout ?? {}) }
    const paint = { ...(layer.paint ?? {}) }
    // Strip icon usage from text+icon layers (place dots).
    for (const key of Object.keys(layout)) if (key.startsWith('icon-')) delete layout[key]
    for (const key of Object.keys(paint)) if (key.startsWith('icon-')) delete paint[key]
    if (layout['text-font']) {
      const mapped = layout['text-font'].map((f) => {
        if (!(f in FONT_MAP)) throw new Error(`No font mapping for "${f}" — extend FONT_MAP`)
        return FONT_MAP[f]
      })
      layout['text-font'] = [...new Set(mapped)]
    }
    return { ...layer, layout, paint }
  })

// 3D buildings: mirror the light style's building(z13) -> building-3d(z14)
// handoff. Upstream's flat building layer runs at all zooms; cap it at 14.
const buildingIndex = style.layers.findIndex((l) => l.id === 'building')
if (buildingIndex === -1) throw new Error('expected a "building" layer upstream')
style.layers[buildingIndex] = { ...style.layers[buildingIndex], maxzoom: 14 }
style.layers.splice(buildingIndex + 1, 0, {
  id: 'building-3d',
  type: 'fill-extrusion',
  source: 'openmaptiles',
  'source-layer': 'building',
  minzoom: 14,
  filter: ['!=', ['get', 'hide_3d'], true],
  paint: {
    'fill-extrusion-color': 'hsl(225, 8%, 22%)',
    'fill-extrusion-height': ['get', 'render_height'],
    'fill-extrusion-base': ['get', 'render_min_height'],
    'fill-extrusion-opacity': 0.75,
  },
})

const outPath = join(dirname(fileURLToPath(import.meta.url)), '../src/styles/mapStyleDark.json')
writeFileSync(outPath, JSON.stringify(style, null, 2) + '\n')
console.log(`wrote ${outPath} (${style.layers.length} layers)`)
