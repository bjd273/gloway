import type { StyleSpecification, VectorSourceSpecification } from 'maplibre-gl'

import mapStyleLight from '../styles/mapStyleLight.json'
import mapStyleDark from '../styles/mapStyleDark.json'

export type Theme = 'light' | 'dark'

/**
 * Returns the basemap style for a theme, with tile URLs made absolute.
 *
 * MapLibre's tile fetches run inside a Blob-URL worker, which can't resolve
 * relative tile URL templates — they must be absolute. The style JSONs stay
 * environment-agnostic (committed with relative /api/tiles paths); we resolve
 * against the current origin here so dev, staging, and prod all work
 * unmodified.
 */
export function getMapStyle(theme: Theme): StyleSpecification {
  const source = theme === 'dark' ? mapStyleDark : mapStyleLight
  const style = structuredClone(source) as unknown as StyleSpecification
  const tileSource = style.sources.openmaptiles as VectorSourceSpecification
  tileSource.tiles = tileSource.tiles?.map((t) =>
    t.startsWith('/') ? `${window.location.origin}${t}` : t,
  )
  return style
}
