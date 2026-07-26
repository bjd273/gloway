#!/bin/bash
set -e

mkdir -p data/overture

# Same bbox as data/download_osm.sh and frontend/src/lib/region.ts.
# Uses the latest Overture release (same "latest" convention as texas-latest
# in download_osm.sh); pin with `pip install overturemaps==<version>` if
# reproducibility matters later. Needs the overturemaps CLI: `uvx` runs it
# ephemeral; otherwise `pipx run overturemaps` or `pip install overturemaps`.
echo "Downloading Overture places for Central Arlington..."
uvx overturemaps download --bbox=-97.140,32.715,-97.080,32.760 \
    -f geoparquet --type=place -o data/overture/places.parquet

echo "Verifying the extract..."
python3 -c "import duckdb; print(duckdb.sql(\"SELECT count(*) AS places, count(DISTINCT categories['primary']) AS categories FROM read_parquet('data/overture/places.parquet')\"))"
