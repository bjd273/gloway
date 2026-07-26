"""OSM pbf -> road_segments ingestion for the GNN road graph.

The Week 17-18 graph builder (graph_builder.py) turns road_segments rows into
a PyTorch Geometric graph by matching segment *endpoints*: two segments share
a junction node iff their endpoint coordinates round to the same 5-decimal
point. Raw OSM ways span many intersections, so loading them unsplit would
produce a graph of disconnected fragments (ways only ever touching mid-line).
Hence the junction-splitting pass here: any coordinate shared by more than one
way (counted after rounding) is a junction, and every way is split there so
each stored segment runs junction-to-junction.

ROUND_DECIMALS is the shared contract between this module and graph_builder —
both must round identically or split points stop matching. Known limitation:
purely coordinate-based junction detection can falsely join grade-separated
crossings (bridge over highway) if they share a vertex within ~1 m; OSM rarely
places vertices at such crossings, and the correct fix (splitting on shared
OSM *node ids* via pyosmium) can replace this if it ever shows up in practice.

Pipeline: osmium CLI (already a host requirement — data/download_osm.sh uses
it) filters the pbf to highway ways and exports GeoJSONSeq; the pure functions
below parse tags and split ways; ingest_pbf() bulk-loads the result, replacing
the table contents wholesale (same regenerate-from-source semantics as the
data/ download scripts).
"""
from __future__ import annotations

import json
import subprocess
import tempfile
from collections import Counter
from pathlib import Path
from typing import Iterator

from sqlalchemy import text

# Highway classes a car can drive; everything else (footway, cycleway, steps,
# proposed, ...) is noise for a driving-RL graph.
ROUTABLE_HIGHWAYS = frozenset({
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "unclassified", "residential", "service", "living_street", "track",
    "motorway_link", "trunk_link", "primary_link", "secondary_link",
    "tertiary_link",
})

# Shared with graph_builder: junction detection here and endpoint matching
# there must round identically. 5 decimals ~= 1.1 m at the equator.
ROUND_DECIMALS = 5

_MPH_TO_KPH = 1.609344


def round_pt(lon: float, lat: float) -> tuple[float, float]:
    """The one rounding used for junction detection and node matching."""
    return (round(lon, ROUND_DECIMALS), round(lat, ROUND_DECIMALS))


def parse_maxspeed(value: str | None) -> int | None:
    """OSM maxspeed -> kph int. Handles bare kph numbers and "N mph";
    everything else ("none", "walk", "signals", "50;60") -> None."""
    if not value:
        return None
    value = value.strip().lower()
    if value.endswith("mph"):
        try:
            return round(float(value[:-3].strip()) * _MPH_TO_KPH)
        except ValueError:
            return None
    try:
        return round(float(value))
    except ValueError:
        return None


def parse_lanes(value: str | None) -> int | None:
    try:
        lanes = int(str(value).strip())
    except (ValueError, TypeError):
        return None
    return lanes if lanes > 0 else None


def parse_oneway(tags: dict) -> tuple[bool, bool]:
    """-> (one_way, reverse_geometry). oneway=-1 means "one way, against the
    geometry direction" — we flip the coordinates at ingest so stored geometry
    direction always equals travel direction and downstream code never needs
    the special case."""
    value = str(tags.get("oneway", "")).strip().lower()
    if value in ("yes", "true", "1"):
        return True, False
    if value == "-1":
        return True, True
    return False, False


def _dedupe_consecutive(coords: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for pt in coords:
        if not out or out[-1] != pt:
            out.append(pt)
    return out


def count_coordinate_occurrences(features: Iterator[dict]) -> Counter:
    """Pass 1: count every rounded coordinate across all kept ways. A count
    above 1 means the point is shared — either between ways or by a way
    crossing itself — i.e. a junction."""
    counts: Counter = Counter()
    for feature in features:
        coords = _dedupe_consecutive(
            [round_pt(lon, lat) for lon, lat in feature["geometry"]["coordinates"]]
        )
        counts.update(coords)
    return counts


def split_way_at_junctions(
    coords: list[tuple[float, float]], counts: Counter
) -> list[list[tuple[float, float]]]:
    """Pass 2: split a way's coordinate list at interior junctions so each
    piece runs junction-to-junction. Coordinates here are the ORIGINAL
    (unrounded) points; rounding happens only for the junction lookup."""
    coords = _dedupe_consecutive(coords)
    if len(coords) < 2:
        return []
    pieces: list[list[tuple[float, float]]] = []
    piece = [coords[0]]
    for pt in coords[1:-1]:
        piece.append(pt)
        if counts[round_pt(*pt)] > 1:
            pieces.append(piece)
            piece = [pt]
    piece.append(coords[-1])
    pieces.append(piece)
    return [p for p in pieces if len(p) >= 2]


def _to_wkt(coords: list[tuple[float, float]]) -> str:
    return "LINESTRING(" + ", ".join(f"{lon} {lat}" for lon, lat in coords) + ")"


def feature_to_rows(feature: dict, counts: Counter) -> list[dict]:
    """One exported GeoJSON feature -> zero or more road_segments rows."""
    tags = feature["properties"]
    if tags.get("highway") not in ROUTABLE_HIGHWAYS:
        return []
    coords = [(lon, lat) for lon, lat in feature["geometry"]["coordinates"]]
    one_way, reverse = parse_oneway(tags)
    if reverse:
        coords = coords[::-1]
    return [
        {
            "osm_way_id": tags.get("@id"),
            "name": tags.get("name"),
            "highway_type": tags.get("highway"),
            "speed_limit_kph": parse_maxspeed(tags.get("maxspeed")),
            "lanes": parse_lanes(tags.get("lanes")),
            "one_way": one_way,
            "wkt": _to_wkt(piece),
        }
        for piece in split_way_at_junctions(coords, counts)
    ]


# --- IO --------------------------------------------------------------------

def export_highways(pbf_path: Path, tmpdir: Path) -> Path:
    """osmium: filter to highway ways, export as GeoJSONSeq with way ids."""
    filtered = tmpdir / "highways.osm.pbf"
    exported = tmpdir / "highways.geojsonseq"
    subprocess.run(
        ["osmium", "tags-filter", str(pbf_path), "w/highway", "-o", str(filtered), "--overwrite"],
        check=True,
    )
    subprocess.run(
        [
            "osmium", "export", str(filtered),
            "-f", "geojsonseq", "--geometry-types=linestring",
            "-a", "id",  # way id lands in properties["@id"]
            "-o", str(exported), "--overwrite",
        ],
        check=True,
    )
    return exported


def iter_features(path: Path) -> Iterator[dict]:
    """Yield routable LineString features from a GeoJSONSeq export. Each line
    is RS-prefixed (\\x1e, RFC 8142). Streamed so the two passes over the file
    never hold it all in memory."""
    with path.open() as f:
        for line in f:
            line = line.lstrip("\x1e").strip()
            if not line:
                continue
            feature = json.loads(line)
            if feature.get("geometry", {}).get("type") != "LineString":
                continue
            if len(feature["geometry"]["coordinates"]) < 2:
                continue
            if feature.get("properties", {}).get("highway") not in ROUTABLE_HIGHWAYS:
                continue
            yield feature


_INSERT_SQL = text(
    "INSERT INTO road_segments"
    " (osm_way_id, geom, name, highway_type, speed_limit_kph, lanes, one_way)"
    " VALUES (:osm_way_id, ST_GeogFromText(:wkt), :name, :highway_type,"
    " :speed_limit_kph, :lanes, :one_way)"
)

_BATCH_SIZE = 1000


async def ingest_pbf(pbf_path: Path) -> int:
    """Full-reload ingestion: pbf -> junction-split rows -> road_segments.
    Deletes existing rows first (single-region regenerate semantics)."""
    from db.session import get_session_factory

    with tempfile.TemporaryDirectory() as tmp:
        exported = export_highways(pbf_path, Path(tmp))
        counts = count_coordinate_occurrences(iter_features(exported))
        rows: list[dict] = []
        for feature in iter_features(exported):
            rows.extend(feature_to_rows(feature, counts))

    async with get_session_factory()() as session:
        await session.execute(text("DELETE FROM road_segments"))
        for i in range(0, len(rows), _BATCH_SIZE):
            await session.execute(_INSERT_SQL, rows[i : i + _BATCH_SIZE])
        await session.commit()
    return len(rows)
