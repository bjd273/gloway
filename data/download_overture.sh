#!/bin/bash
set -e

mkdir -p data/overture

# Bbox comes from data/region.json, the same source data/download_osm.sh and
# the frontend's coverage gate read — so places can never cover a different
# area than the routing tiles.
# Uses the latest Overture release (same "latest" convention as texas-latest
# in download_osm.sh); pin with `pip install overturemaps==<version>` if
# reproducibility matters later. Needs the overturemaps CLI: `uvx` runs it
# ephemeral; otherwise `pipx run overturemaps` or `pip install overturemaps`.
BBOX=$(python3 -c "
import json
b = json.load(open('data/region.json'))['bbox']
print(f\"{b['west']},{b['south']},{b['east']},{b['north']}\")
")

echo "Downloading Overture places for $BBOX..."
uvx overturemaps download --bbox="$BBOX" \
    -f geoparquet --type=place -o data/overture/places.parquet

echo "Verifying the extract..."
python3 -c "import duckdb; print(duckdb.sql(\"SELECT count(*) AS places, count(DISTINCT categories['primary']) AS categories FROM read_parquet('data/overture/places.parquet')\"))"
