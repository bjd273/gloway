"""Populate the road_segments table from the local OSM extract.

Usage (from repo root or backend/):
    poetry --directory backend run python backend/scripts/ingest_road_segments.py
    poetry run python scripts/ingest_road_segments.py --pbf ../data/osm/region.osm.pbf

Host requirement: the `osmium` CLI (same requirement as data/download_osm.sh).
Needs Postgres up (docker compose). Full reload: existing rows are replaced.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

# Runnable from anywhere: put backend/ on the path before importing ml.*.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ml.gnn.ingest import ingest_pbf  # noqa: E402

_DEFAULT_PBF = Path(__file__).resolve().parents[2] / "data" / "osm" / "region.osm.pbf"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pbf", type=Path, default=_DEFAULT_PBF, help="OSM .pbf extract to load")
    args = parser.parse_args()
    if not args.pbf.exists():
        raise SystemExit(f"pbf not found: {args.pbf} — run data/download_osm.sh first")
    count = asyncio.run(ingest_pbf(args.pbf))
    print(f"road_segments loaded: {count} rows from {args.pbf.name}")


if __name__ == "__main__":
    main()
