#!/bin/bash
set -e

# `poetry --directory backend run` executes with the working directory set to
# backend/, so every path handed to it has to be absolute. Anchor on the repo
# root rather than on $PWD so the script works from anywhere.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p data/overture

# Bbox comes from data/region.json, the same source data/download_osm.sh and
# the frontend's coverage gate read — so places can never cover a different
# area than the routing tiles. check_places_coverage.py enforces that they
# actually didn't; see the note at the bottom of this file.
#
# Downloads straight from Overture's public S3 with duckdb + httpfs rather than
# the `overturemaps` CLI. The CLI needs uv/pipx/pip on PATH, which is one more
# thing to have installed before a region rebuild works; duckdb is already a
# backend dependency because the query path uses it, so this route has no new
# prerequisites. Set OVERTURE_RELEASE to pin a release, otherwise the newest
# one in the bucket wins (same "latest" convention as texas-latest in
# download_osm.sh).
#
# duckdb lives in the backend's Poetry environment — the system python3 does
# not have it, so every duckdb call here goes through `poetry --directory
# backend run`.
PY="poetry --directory backend run python"

read -r WEST SOUTH EAST NORTH < <(python3 -c "
import json
b = json.load(open('data/region.json'))['bbox']
print(b['west'], b['south'], b['east'], b['north'])
")

echo "Downloading Overture places for $WEST,$SOUTH,$EAST,$NORTH..."
$PY - "$WEST" "$SOUTH" "$EAST" "$NORTH" "$ROOT/data/overture/places.parquet" <<'PYEOF'
import json, os, sys, datetime
import duckdb

west, south, east, north = (float(a) for a in sys.argv[1:5])
out = sys.argv[5]

con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")

release = os.environ.get("OVERTURE_RELEASE")
if not release:
    # The bucket holds a couple of releases at a time and there is no "latest"
    # alias, so pick the highest-sorting one. Release ids are YYYY-MM-DD.N,
    # which sorts lexicographically in release order.
    rows = con.execute("""
        SELECT DISTINCT regexp_extract(file, 'release/([^/]+)/', 1) AS rel
        FROM glob('s3://overturemaps-us-west-2/release/*/theme=places/type=place/*.parquet')
        ORDER BY rel DESC LIMIT 1
    """).fetchall()
    if not rows:
        sys.exit("Could not list Overture releases — check network access to S3.")
    release = rows[0][0]
print(f"  release {release}")

src = f"s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*.parquet"
# Places are points, so bbox.xmin == bbox.xmax; testing the min corner is the
# same test as containment. Overture writes files in spatial order with bbox
# row-group statistics, so this prunes to a handful of row groups rather than
# scanning the whole global theme.
con.execute(
    f"""
    COPY (
        SELECT * FROM read_parquet('{src}', hive_partitioning=1)
        WHERE bbox.xmin BETWEEN ? AND ? AND bbox.ymin BETWEEN ? AND ?
    ) TO '{out}' (FORMAT PARQUET)
    """,
    [west, east, south, north],
)

# The state file is what check_places_coverage.py compares against
# data/region.json. It records the bbox the extract was actually built for,
# which is the fact that silently went stale and made 81% of the region's
# labelled places unsearchable.
with open(out + ".state", "w") as f:
    json.dump({
        "last_release": release,
        "last_run": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "theme": "places",
        "type": "place",
        "bbox": {"xmin": west, "ymin": south, "xmax": east, "ymax": north},
        "backend": "geoparquet",
        "output": os.path.abspath(out),
    }, f, indent=2)
PYEOF

echo "Verifying the extract..."
$PY "$ROOT/data/check_places_coverage.py"
