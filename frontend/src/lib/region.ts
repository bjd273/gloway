// The area Gloway can currently route: the Central Arlington, TX extract that
// Valhalla's tiles and Martin's basemap were built from (data/download_osm.sh).
// Grows as bigger OSM extracts are built — this file is the single place the
// frontend knows about coverage.

export const REGION_BBOX = {
  west: -97.14,
  south: 32.715,
  east: -97.08,
  north: 32.76,
}

// Padded so users can breathe at the edges without ever reaching blank tiles.
const PAD = 0.06
export const MAP_MAX_BOUNDS: [[number, number], [number, number]] = [
  [REGION_BBOX.west - PAD, REGION_BBOX.south - PAD],
  [REGION_BBOX.east + PAD, REGION_BBOX.north + PAD],
]

export const REGION_CENTER: [number, number] = [
  (REGION_BBOX.west + REGION_BBOX.east) / 2,
  (REGION_BBOX.south + REGION_BBOX.north) / 2,
]

export function inRegion(lat: number, lon: number): boolean {
  return (
    lat >= REGION_BBOX.south &&
    lat <= REGION_BBOX.north &&
    lon >= REGION_BBOX.west &&
    lon <= REGION_BBOX.east
  )
}

export const OUT_OF_AREA_MESSAGE =
  'Gloway is just getting started — right now it knows central Arlington, TX.'
