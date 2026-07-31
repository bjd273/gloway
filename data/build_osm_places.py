#!/usr/bin/env python
"""Turn an osmium GeoJSONSeq export of POIs into the search index parquet.

Called by data/build_osm_places.sh, which does the osmium half. Split out
because the transform is more than a heredoc's worth: geometry has to be
reduced to a point, and OSM's free-form tags have to be flattened into the same
handful of searchable columns the Overture source exposes.

Why this index exists at all: the basemap's POI labels are built by Planetiler
from region.osm.pbf, while search queried Overture. Two providers, two
vocabularies, two id spaces, no crosswalk — so a place could be labelled on the
map and be unfindable by name, which is exactly what a driver hit. Indexing the
same OSM extract the labels come from makes "if I can see it, I can search it"
true by construction. Overture still carries far more places and stays the
primary source; this is the guarantee, not the bulk.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# Ordered: the first tag present names the category, so the more specific keys
# come first. `healthcare` before `amenity` because a clinic tagged both reads
# better as "clinic" than as "doctors".
_CATEGORY_KEYS = (
    "shop",
    "healthcare",
    "amenity",
    "leisure",
    "tourism",
    "office",
    "historic",
    "aeroway",
    "public_transport",
    "railway",
)

# Tags that are a name for this place under some other spelling — the whole
# point of indexing them is that the map's label and the driver's word for a
# place are often different strings.
_ALT_NAME_KEYS = (
    "alt_name",
    "short_name",
    "official_name",
    "old_name",
    "name:en",
    "loc_name",
    "nat_name",
)


def _centroid(geometry: dict) -> tuple[float, float] | None:
    """A single lon/lat for any geometry osmium emits.

    A mall or a stadium is a polygon in OSM, and a destination has to be one
    point. The mean of the outer ring is not the true centroid of the area, but
    for routing it only has to land inside the footprint and near the middle —
    Valhalla snaps to the nearest road either way.
    """
    kind, coords = geometry.get("type"), geometry.get("coordinates")
    if not coords:
        return None
    if kind == "Point":
        return float(coords[0]), float(coords[1])
    if kind == "LineString":
        ring = coords
    elif kind == "Polygon":
        ring = coords[0]
    elif kind == "MultiPolygon":
        ring = coords[0][0]
    elif kind == "MultiLineString":
        ring = coords[0]
    else:
        return None
    if not ring:
        return None
    return (
        sum(float(p[0]) for p in ring) / len(ring),
        sum(float(p[1]) for p in ring) / len(ring),
    )


def _address(tags: dict) -> str | None:
    house, street = tags.get("addr:housenumber"), tags.get("addr:street")
    line = " ".join(p for p in (house, street) if p)
    parts = [p for p in (line, tags.get("addr:city"), tags.get("addr:postcode")) if p]
    return ", ".join(parts) or None


def rows_from_geojsonseq(path: Path):
    """Yield one index row per named, categorised feature.

    osmium tags-filter also emits the untagged nodes that matching ways
    reference, so most input lines are geometry rather than places. Requiring
    both a name and a category tag is what filters them out — and it matches
    what the basemap labels, which also needs a name to draw anything.
    """
    with path.open() as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                feature = json.loads(line)
            except ValueError:
                continue
            tags = feature.get("properties") or {}
            name = tags.get("name")
            if not name:
                continue
            category = next(
                (f"{key}={tags[key]}" for key in _CATEGORY_KEYS if tags.get(key)), None
            )
            if not category:
                continue
            point = _centroid(feature.get("geometry") or {})
            if not point:
                continue
            alts = [tags[k] for k in _ALT_NAME_KEYS if tags.get(k)]
            yield {
                "id": feature.get("id"),
                "name": name,
                # One string, not a list: the query is a substring match and a
                # single haystack keeps the SQL the same shape as the name one.
                "alt_names": " | ".join(alts) or None,
                "category": category,
                "brand": tags.get("brand") or tags.get("operator"),
                "addr": _address(tags),
                "lon": point[0],
                "lat": point[1],
            }


def main() -> int:
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    rows = list(rows_from_geojsonseq(src))
    if not rows:
        print(f"  No named POIs found in {src} — is the extract empty?", file=sys.stderr)
        return 1

    import duckdb

    con = duckdb.connect()
    con.execute("CREATE TABLE places (id VARCHAR, name VARCHAR, alt_names VARCHAR, "
                "category VARCHAR, brand VARCHAR, addr VARCHAR, lon DOUBLE, lat DOUBLE)")
    con.executemany(
        "INSERT INTO places VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [tuple(r.values()) for r in rows],
    )
    con.execute(f"COPY places TO '{out}' (FORMAT PARQUET)")
    named_brands = sum(1 for r in rows if r["brand"])
    print(f"  {len(rows):,} named POIs, {named_brands:,} with a brand -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
