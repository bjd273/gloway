#!/bin/bash
# Rebuild every artifact derived from the routable region's bounding box.
#
# Edit data/region.json, run this, and the routing tiles, basemap, place data
# and the frontend's coverage gate all move together. Doing it by hand means
# four files to update and no signal when one is missed — the failure mode is
# silent (the app offers destinations the router has no tiles for, or falls back
# to the map centre as a trip origin).
#
#   ./scripts/rebuild_region.sh                       # tiles, basemap, places
#   ./scripts/rebuild_region.sh --with-road-segments  # ...plus the GNN graph
#
# Safe to re-run. Everything except the Overture download works offline once
# data/osm/texas.osm.pbf and data/sources/ are cached.
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE="docker compose -f infra/docker-compose.yml --project-directory ."
WITH_ROAD_SEGMENTS=0
[ "${1:-}" = "--with-road-segments" ] && WITH_ROAD_SEGMENTS=1

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

read -r WEST SOUTH EAST NORTH < <(python3 -c "
import json
b = json.load(open('data/region.json'))['bbox']
print(b['west'], b['south'], b['east'], b['north'])
")
BBOX="$WEST,$SOUTH,$EAST,$NORTH"

bold "Region: $(python3 -c "import json;print(json.load(open('data/region.json'))['description'])")"
python3 -c "
import math
w = ($EAST - ($WEST)) * 111.32 * math.cos(math.radians(($SOUTH + $NORTH) / 2))
h = ($NORTH - ($SOUTH)) * 110.54
print(f'  bbox {\"$BBOX\"}  ->  {w:.1f} x {h:.1f} km  ({w * h:.0f} km2)')
"

# --- 1. OSM extract ---------------------------------------------------------
# download_osm.sh reads the same data/region.json and reuses the cached
# ~700MB state extract, so this is a local crop, not a download.
bold "[1/6] Cropping the OSM extract"
./data/download_osm.sh

# --- 2. Valhalla routing tiles ---------------------------------------------
# The container only rebuilds when use_tiles_ignore_pbf=False; with the default
# True it loads the cached tar and would happily serve the OLD region against
# the new .pbf. Clearing the tar and hash file makes the rebuild unambiguous.
bold "[2/6] Rebuilding Valhalla tiles (this is the slow one)"
cp data/osm/region.osm.pbf valhalla/custom_files/region.osm.pbf
rm -f valhalla/custom_files/valhalla_tiles.tar valhalla/custom_files/file_hashes.txt
$COMPOSE stop valhalla >/dev/null 2>&1 || true
VALHALLA_USE_CACHED_TILES=False $COMPOSE up -d --force-recreate valhalla

echo "  waiting for the tile build to finish..."
for _ in $(seq 1 120); do
  if docker logs gloway-valhalla-1 2>&1 | grep -q "Starting valhalla service"; then
    echo "  tiles built"
    break
  fi
  sleep 5
done

# Back to the cached-tile default so ordinary restarts stay near-instant.
$COMPOSE up -d --force-recreate valhalla >/dev/null
echo "  valhalla restarted with cached tiles"

# --- 3. Basemap vector tiles ------------------------------------------------
# --download is a no-op once data/sources/ (~1.3GB of water polygons, Natural
# Earth, lake centerlines) is cached from the first run.
bold "[3/6] Building the basemap (Planetiler -> PMTiles)"
mkdir -p data/tiles
docker run --rm -e JAVA_TOOL_OPTIONS="-Xmx2g" -v "$(pwd)/data:/data" \
  ghcr.io/onthegomap/planetiler:latest \
  --osm-path=/data/osm/region.osm.pbf \
  --output=/data/tiles/region.pmtiles \
  --force --download

$COMPOSE restart martin >/dev/null 2>&1 || true

# --- 4. Overture places -----------------------------------------------------
# Non-fatal on purpose. Places only enrich destination search; routing and the
# basemap don't need them, and config.py already degrades to Nominatim-only
# when the parquet is missing. Failing hard here would also skip step 5 and
# leave the frontend's coverage gate disagreeing with the tiles just built —
# a much worse outcome than slightly thinner POI search.
bold "[4/6] Downloading Overture places"
if ./data/download_overture.sh; then
  PLACES_OK=1
else
  PLACES_OK=0
  warn "Failed — the download needs network access to Overture's S3 bucket."
  echo "      Destination search still works meanwhile: it falls back to the"
  echo "      OSM POI index and Nominatim, just with fewer place-name matches."
fi

# --- 5. OSM POI search index ------------------------------------------------
# Built from the region.osm.pbf cropped in step 1 — the same input step 3 turns
# into the basemap's label layer. That shared input is what makes "anything
# labelled on the map can be found by name" true rather than coincidental;
# Overture is a different provider with a different vocabulary and does not
# guarantee it. Offline and quick, so unlike the Overture download this one
# failing is worth reporting but still not fatal.
bold "[5/6] Building the OSM POI search index"
if ./data/build_osm_places.sh; then
  OSM_PLACES_OK=1
else
  OSM_PLACES_OK=0
  warn "Failed — destination search falls back to Overture and Nominatim."
  echo "      Places labelled on the map may not be findable by name."
fi

# --- 6. Frontend coverage gate ---------------------------------------------
# The frontend imports its own copy because data/ sits outside Vite's root.
# Copying here is what stops the two from drifting.
bold "[6/6] Syncing the frontend's copy of region.json"
cp data/region.json frontend/src/lib/region.json
echo "  frontend/src/lib/region.json updated"

if [ "$WITH_ROAD_SEGMENTS" = "1" ]; then
  # Opt-in: slow, and only the GNN/RL work reads road_segments. Nothing being
  # served depends on it, so a normal rebuild skips it.
  bold "[extra] Re-ingesting road_segments for the GNN"
  poetry --directory backend run python scripts/ingest_road_segments.py
fi

bold "Done."
cat <<EOF

  Artifacts:
$(ls -lh data/osm/region.osm.pbf data/tiles/region.pmtiles data/overture/places.parquet data/osm/places.parquet 2>/dev/null | awk '{printf "    %-6s %s\n", $5, $9}')
EOF

if [ "$PLACES_OK" = "0" ]; then
  # Say it plainly: the parquet on disk still covers whatever bbox it was built
  # for, which is now narrower than the routing tiles.
  printf '\033[33m  Note: places.parquet still covers the PREVIOUS region.\033[0m\n'
fi

if [ "$OSM_PLACES_OK" = "0" ]; then
  printf '\033[33m  Note: the OSM POI index is stale or missing — map labels are not\033[0m\n'
  printf '\033[33m        guaranteed to be searchable.\033[0m\n'
fi

cat <<EOF

  Next:
    - restart the frontend if it is running, so it picks up the new region.json
    - ./scripts/drive.sh   to go collect a real drive
EOF
