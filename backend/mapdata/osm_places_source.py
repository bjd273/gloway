"""Local OSM POI index — the source that guarantees map labels are searchable.

Queries data/osm/places.parquet, built by data/build_osm_places.sh from the same
region.osm.pbf that Planetiler turns into the basemap's label layer. Everything
this source can find is something the map can draw a label for, and vice versa.

That guarantee is the reason it exists. Overture carries several times more
places and remains the primary source for search volume, but it is a different
provider with a different vocabulary and a different id space — a place can be
labelled on the map from OSM and be absent from, or differently spelled in,
Overture. A driver hit exactly that: places visible on screen that search could
not find. Indexing both and merging (see HybridMapDataSource) covers volume and
label-fidelity at once.

Local parquet + duckdb, deliberately, not Overpass: this runs on every
keystroke of destination search, and OSMMapDataSource's Overpass calls are a
network round trip to a shared public API. Same reasoning as
OvertureMapDataSource, and the same degradation — missing file means one
warning at construction and empty results, never a crash.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import duckdb

from mapdata.base import MapDataSource
from mapdata.models import Address, BBox, Place, PlaceCategory, RoutingGraphRef
from mapdata.osm_source import _OSM_TAG_TO_CATEGORY

logger = logging.getLogger(__name__)

# The index stores category as the literal "key=value" tag it came from, so the
# mapping to PlaceCategory reuses osm_source's table rather than starting a
# second OSM vocabulary — that file states it should be the only one.
_TAG_STRING_TO_CATEGORY = {f"{k}={v}": cat for (k, v), cat in _OSM_TAG_TO_CATEGORY.items()}
_CATEGORY_TO_TAG_STRING = {cat: tag for tag, cat in _TAG_STRING_TO_CATEGORY.items()}

# Columns a free-text query is matched against. `name` is what the map label
# shows; the rest are the other ways a driver might say the same place —
# "Walmart" for a store recorded as "Walmart Supercenter #4471", or a street
# address for somewhere whose name they don't know.
_SEARCH_COLUMNS = ("name", "alt_names", "brand", "addr", "category")


def _format(name: str, addr: str | None) -> str:
    return f"{name}, {addr}" if addr else name


class OsmPlacesSource(MapDataSource):
    def __init__(self, places_path: str | None = None):
        from config import settings

        self._path = places_path or settings.osm_places_path
        self._available = Path(self._path).exists()
        if not self._available:
            logger.warning(
                "OSM POI index missing at %s — run data/build_osm_places.sh; "
                "map labels will not be guaranteed searchable.",
                self._path,
            )

    def _query(self, sql: str, params: list) -> list[tuple]:
        # Fresh in-memory connection per query, matching OvertureMapDataSource:
        # duckdb is embedded and synchronous, connections are cheap, and callers
        # run us via asyncio.to_thread so a shared one would cross threads.
        with duckdb.connect() as con:
            return con.execute(sql, params).fetchall()

    async def get_places(self, category: PlaceCategory, bbox: BBox) -> list[Place]:
        tag = _CATEGORY_TO_TAG_STRING.get(category)
        if tag is None or not self._available:
            return []
        sql = """
            SELECT id, name, category, lon, lat FROM read_parquet(?)
            WHERE category = ? AND lon BETWEEN ? AND ? AND lat BETWEEN ? AND ?
        """
        rows = await asyncio.to_thread(
            self._query, sql,
            [self._path, tag, bbox.min_lon, bbox.max_lon, bbox.min_lat, bbox.max_lat],
        )
        return [
            Place(
                id=f"osmpoi:{row[0]}", name=row[1], category=category,
                lat=row[4], lon=row[3], source="osm",
                metadata={"osm_tag": row[2]},
            )
            for row in rows
        ]

    async def get_place_by_id(self, place_id: str) -> Place | None:
        prefix = "osmpoi:"
        if not place_id.startswith(prefix) or not self._available:
            return None
        sql = "SELECT id, name, category, lon, lat FROM read_parquet(?) WHERE id = ?"
        rows = await asyncio.to_thread(
            self._query, sql, [self._path, place_id[len(prefix):]]
        )
        if not rows:
            return None
        row = rows[0]
        return Place(
            id=place_id, name=row[1],
            category=_TAG_STRING_TO_CATEGORY.get(row[2], PlaceCategory.OTHER),
            lat=row[4], lon=row[3], source="osm", metadata={"osm_tag": row[2]},
        )

    async def search_addresses(self, query: str, limit: int = 5) -> list[Address]:
        """Substring match across every searchable column.

        No ORDER BY: HybridMapDataSource ranks the merged candidates from all
        sources with one shared scorer, so sorting here would only be undone.
        The LIMIT is still applied — it caps how many candidates this source
        contributes, and callers ask for more than they intend to show.
        """
        if not self._available or not query.strip():
            return []
        q = query.strip()
        where = " OR ".join(f"{col} ILIKE '%' || ? || '%'" for col in _SEARCH_COLUMNS)
        sql = f"""
            SELECT id, name, addr, lon, lat, category, brand
            FROM read_parquet(?) WHERE {where} LIMIT ?
        """
        rows = await asyncio.to_thread(
            self._query, sql, [self._path, *([q] * len(_SEARCH_COLUMNS)), limit]
        )
        return [
            Address(
                id=f"osmpoi:{row[0]}",
                formatted=_format(row[1], row[2]),
                lat=row[4],
                lon=row[3],
                source="osm",
                # Ranking scores these separately from the formatted string so a
                # brand match doesn't have to beat an address match on length.
                metadata={"name": row[1], "category": row[5], "brand": row[6]},
            )
            for row in rows
        ]

    async def get_routing_graph_ref(self, bbox: BBox) -> RoutingGraphRef:
        # Same as Overture: routing graphs stay with OSMMapDataSource, which is
        # the source that owns the Valhalla tileset metadata.
        raise NotImplementedError("Routing graphs are OSM-only; use OSMMapDataSource for this.")
