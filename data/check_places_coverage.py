#!/usr/bin/env python
"""Verify data/overture/places.parquet covers data/region.json, and report it.

Run from the repo root, through the backend's Poetry env (duckdb lives there):

    poetry --directory backend run python data/check_places_coverage.py

Exits non-zero when the extract is short of the region, so it can gate a build.
The comparison itself is backend/mapdata/places_coverage.py — shared with the
runtime check so the build and the service can never disagree about what
"covered" means.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from mapdata.places_coverage import check_coverage  # noqa: E402

PARQUET = ROOT / "data/overture/places.parquet"

RED, GREEN, YELLOW, RESET = "\033[31m", "\033[32m", "\033[33m", "\033[0m"


def main() -> int:
    result = check_coverage(f"{PARQUET}.state", ROOT / "data/region.json")
    if not result.ok:
        print(f"  {RED}x{RESET} {result.message}")
        return 1
    print(f"  {GREEN}v{RESET} {result.message}")

    if not PARQUET.exists():
        print(f"  {RED}x{RESET} {PARQUET} is missing")
        return 1

    import duckdb

    places, categories, branded = duckdb.sql(f"""
        SELECT count(*),
               count(DISTINCT categories['primary']),
               count(*) FILTER (WHERE brand IS NOT NULL)
        FROM read_parquet('{PARQUET}')
    """).fetchone()
    print(f"  {GREEN}v{RESET} {places:,} places, {categories:,} categories, {branded:,} with a brand")
    if places == 0:
        print(f"  {YELLOW}!{RESET} The extract is empty — search will fall back to Nominatim only.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
