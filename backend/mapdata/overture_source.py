"""Overture Maps-backed MapDataSource.

Queries a local GeoParquet extract of Overture's Places theme (regenerate via
data/download_overture.sh) through duckdb — no live API to call, unlike OSM's
Overpass. Places are points, so the parquet's bbox struct doubles as the
coordinate source (bbox.xmin = lon, bbox.ymin = lat) and no spatial extension
is needed.

Category names come from Overture's taxonomy
(https://docs.overturemaps.org/schema/concepts/by-theme/places/overture_categories/),
which maps far more cleanly onto PlaceCategory than OSM's free-form tags do.
Primaries are taxonomy *leaves* ("mexican_restaurant", not "restaurant"), so
the exact-match dict is supplemented by suffix rules that catch whole subtrees.

If the parquet is missing the source degrades: one warning at construction,
every query returns empty. The app then runs on Nominatim geocoding alone
(see HybridMapDataSource), rather than crashing on startup.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import duckdb

from mapdata.base import MapDataSource
from mapdata.models import Address, BBox, Place, PlaceCategory, RoutingGraphRef

logger = logging.getLogger(__name__)

# Verified against the central-Arlington extract (SELECT DISTINCT
# categories['primary']) — every name below either appears there or is a
# standard taxonomy sibling kept for when the bbox grows.
_OVERTURE_CATEGORY_TO_CATEGORY: dict[str, PlaceCategory] = {
    "ev_charging_station": PlaceCategory.EV_CHARGING,
    "electric_vehicle_charging_station": PlaceCategory.EV_CHARGING,
    "gas_station": PlaceCategory.FUEL,
    "parking": PlaceCategory.PARKING,
    "parking_lot": PlaceCategory.PARKING,
    "park": PlaceCategory.PARK,
    "dog_park": PlaceCategory.PARK,
    "cafe": PlaceCategory.CAFE,
    "cafeteria": PlaceCategory.CAFE,
    "coffee_shop": PlaceCategory.CAFE,
    "restaurant": PlaceCategory.RESTAURANT,
    "grocery_store": PlaceCategory.GROCERY,
    "organic_grocery_store": PlaceCategory.GROCERY,
    "specialty_grocery_store": PlaceCategory.GROCERY,
    "supermarket": PlaceCategory.GROCERY,
    "convenience_store": PlaceCategory.GROCERY,
    "hotel": PlaceCategory.LODGING,
    "motel": PlaceCategory.LODGING,
    "bed_and_breakfast": PlaceCategory.LODGING,
    "bicycle_parking": PlaceCategory.BIKE_PARKING,
    "bicycle_parking_station": PlaceCategory.BIKE_PARKING,
    "bus_stop": PlaceCategory.TRANSIT_STOP,
    "bus_station": PlaceCategory.TRANSIT_STOP,
    "train_station": PlaceCategory.TRANSIT_STOP,
}

# Subtree catch-alls, applied after the exact dict. "%_restaurant" pulls in
# mexican_restaurant, pizza_restaurant, fast_food_restaurant, etc. — 40+ leaf
# names in the Arlington extract alone, pointless to enumerate.
_SUFFIX_RULES: list[tuple[str, PlaceCategory]] = [
    ("_restaurant", PlaceCategory.RESTAURANT),
]

_CATEGORY_TO_OVERTURE: dict[PlaceCategory, list[str]] = {}
for _name, _cat in _OVERTURE_CATEGORY_TO_CATEGORY.items():
    _CATEGORY_TO_OVERTURE.setdefault(_cat, []).append(_name)

_CATEGORY_TO_SUFFIXES: dict[PlaceCategory, list[str]] = {}
for _suffix, _cat in _SUFFIX_RULES:
    _CATEGORY_TO_SUFFIXES.setdefault(_cat, []).append(_suffix)


def _category_for(primary: str | None) -> PlaceCategory:
    if primary is None:
        return PlaceCategory.OTHER
    mapped = _OVERTURE_CATEGORY_TO_CATEGORY.get(primary)
    if mapped is not None:
        return mapped
    for suffix, cat in _SUFFIX_RULES:
        if primary.endswith(suffix):
            return cat
    return PlaceCategory.OTHER


def _format_address(name: str, addresses: list[dict] | None) -> str:
    """"Name, street, locality" — each part only when present, so the
    frontend's display-name splitting works the same as Nominatim output."""
    parts = [name]
    first = addresses[0] if addresses else None
    if first:
        if first.get("freeform"):
            parts.append(first["freeform"])
        if first.get("locality"):
            parts.append(first["locality"])
    return ", ".join(parts)


class OvertureMapDataSource(MapDataSource):
    def __init__(self, places_path: str | None = None):
        from config import settings

        self._path = places_path or settings.overture_places_path
        self._available = Path(self._path).exists()
        if not self._available:
            logger.warning(
                "Overture places parquet missing at %s — run "
                "data/download_overture.sh; place queries return empty.",
                self._path,
            )

    def _query(self, sql: str, params: list) -> list[tuple]:
        # Fresh in-memory connection per query: duckdb is embedded and sync,
        # connections are cheap, and this sidesteps cross-thread sharing since
        # callers run us via asyncio.to_thread.
        with duckdb.connect() as con:
            return con.execute(sql, params).fetchall()

    async def get_places(self, category: PlaceCategory, bbox: BBox) -> list[Place]:
        names = _CATEGORY_TO_OVERTURE.get(category, [])
        suffixes = _CATEGORY_TO_SUFFIXES.get(category, [])
        if (not names and not suffixes) or not self._available:
            return []

        clauses = []
        params: list = [self._path]
        if names:
            clauses.append(f"categories['primary'] IN ({', '.join('?' * len(names))})")
            params.extend(names)
        for suffix in suffixes:
            clauses.append("categories['primary'] LIKE ?")
            params.append(f"%{suffix}")
        params.extend([bbox.min_lon, bbox.max_lon, bbox.min_lat, bbox.max_lat])

        sql = f"""
            SELECT id, names['primary'], categories['primary'], bbox.xmin, bbox.ymin
            FROM read_parquet(?)
            WHERE ({' OR '.join(clauses)})
              AND names['primary'] IS NOT NULL
              AND bbox.xmin BETWEEN ? AND ? AND bbox.ymin BETWEEN ? AND ?
        """
        rows = await asyncio.to_thread(self._query, sql, params)
        return [
            Place(
                id=f"overture:place/{row[0]}",
                name=row[1],
                category=_category_for(row[2]),
                lat=row[4],
                lon=row[3],
                source="overture",
                metadata={"overture_category": row[2]},
            )
            for row in rows
        ]

    async def get_place_by_id(self, place_id: str) -> Place | None:
        prefix = "overture:place/"
        if not place_id.startswith(prefix) or not self._available:
            return None
        sql = """
            SELECT id, names['primary'], categories['primary'], bbox.xmin, bbox.ymin
            FROM read_parquet(?) WHERE id = ? AND names['primary'] IS NOT NULL
        """
        rows = await asyncio.to_thread(self._query, sql, [self._path, place_id[len(prefix):]])
        if not rows:
            return None
        row = rows[0]
        return Place(
            id=f"overture:place/{row[0]}",
            name=row[1],
            category=_category_for(row[2]),
            lat=row[4],
            lon=row[3],
            source="overture",
        )

    async def search_addresses(self, query: str, limit: int = 5) -> list[Address]:
        """Place-name search, not geocoding — Nominatim keeps that job (see
        HybridMapDataSource). No bbox filter: the parquet is already cropped
        to the region. Prefix matches outrank substring, then confidence."""
        if not self._available or not query.strip():
            return []
        sql = """
            SELECT id, names['primary'], bbox.xmin, bbox.ymin, addresses
            FROM read_parquet(?)
            WHERE names['primary'] ILIKE '%' || ? || '%'
            ORDER BY (names['primary'] ILIKE ? || '%') DESC, confidence DESC NULLS LAST
            LIMIT ?
        """
        q = query.strip()
        rows = await asyncio.to_thread(self._query, sql, [self._path, q, q, limit])
        return [
            Address(
                id=f"overture:place/{row[0]}",
                formatted=_format_address(row[1], row[4]),
                lat=row[3],
                lon=row[2],
                source="overture",
            )
            for row in rows
        ]

    async def get_routing_graph_ref(self, bbox: BBox) -> RoutingGraphRef:
        # Overture has no mature routing-graph pipeline — this should never
        # actually be reached; routing graphs stay OSM-only (see osm_source.py).
        raise NotImplementedError("Routing graphs are OSM-only; use OSMMapDataSource for this.")
