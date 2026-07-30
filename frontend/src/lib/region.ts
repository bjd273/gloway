// The area Gloway can currently route: the Arlington, TX extract that
// Valhalla's tiles and Martin's basemap were built from (data/download_osm.sh).
// This file is the single place the *frontend* knows about coverage, and the
// numbers themselves come from region.json — a copy of the canonical
// data/region.json that scripts/rebuild_region.sh keeps in sync. They live in
// JSON so the shell scripts, the RL trainer and this file all read one bbox
// rather than four hand-maintained copies that can silently disagree with the
// tiles actually built. Do not edit region.json here; edit data/region.json and
// re-run scripts/rebuild_region.sh.
import regionData from './region.json'

export const REGION_BBOX = regionData.bbox

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
  'Gloway is just getting started — right now it knows Arlington, TX.'
