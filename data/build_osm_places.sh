#!/bin/bash
set -e

# Build the OSM POI search index from the SAME region.osm.pbf that Planetiler
# turns into the basemap's label layer. That shared input is the entire point:
# it makes "anything labelled on the map is findable by name" true by
# construction, rather than a coincidence of two providers happening to agree.
#
# Runs offline — region.osm.pbf is already on disk after data/download_osm.sh.
# Needs osmium (brew install osmium-tool); duckdb comes from the backend's
# Poetry env, which is also why absolute paths are handed to it (`poetry
# --directory backend run` executes with the working directory set to backend/).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SRC="data/osm/region.osm.pbf"
OUT="$ROOT/data/osm/places.parquet"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if ! command -v osmium >/dev/null 2>&1; then
  echo "osmium not found — install it with: brew install osmium-tool" >&2
  exit 1
fi
if [ ! -f "$SRC" ]; then
  echo "$SRC is missing — run data/download_osm.sh first." >&2
  exit 1
fi

echo "Filtering POI tags out of $SRC..."
# The tag set mirrors what the OpenMapTiles `poi` layer draws, so the index and
# the labels stay in step. tags-filter also drags in the untagged nodes that
# matching ways reference; build_osm_places.py drops those by requiring a name.
osmium tags-filter "$SRC" \
  nwr/amenity nwr/shop nwr/leisure nwr/tourism nwr/office nwr/healthcare \
  nwr/historic nwr/aeroway nwr/railway=station,halt nwr/public_transport=station \
  -o "$WORK/poi.osm.pbf" --overwrite

echo "Exporting geometry..."
osmium export "$WORK/poi.osm.pbf" -f geojsonseq --add-unique-id=type_id \
  -o "$WORK/poi.geojsonseq" --overwrite

echo "Building the index..."
poetry --directory backend run python "$ROOT/data/build_osm_places.py" \
  "$WORK/poi.geojsonseq" "$OUT"
