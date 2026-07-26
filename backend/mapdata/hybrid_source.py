"""Composes two MapDataSource implementations, one method at a time.

Active policy (see factory.py): OSM backs routing metadata (the only mature
routing pipeline) and address geocoding; Overture backs places. Free-text
search merges both — Overture place-name matches first (better US POI
coverage), Nominatim address geocoding appended — so typing either a business
name or a street address in the destination bar works. Either source failing
degrades to the other rather than erroring the whole search.
"""
from __future__ import annotations

import asyncio

from mapdata.base import MapDataSource
from mapdata.models import Address, BBox, Place, PlaceCategory, RoutingGraphRef

# Two results closer than this (~50 m) are the same real-world place; keep the
# places-source copy, which carries the cleaner name.
_DEDUPE_DEGREES = 0.0005


def _near_any(candidate: Address, existing: list[Address]) -> bool:
    return any(
        abs(candidate.lat - a.lat) < _DEDUPE_DEGREES
        and abs(candidate.lon - a.lon) < _DEDUPE_DEGREES
        for a in existing
    )


class HybridMapDataSource(MapDataSource):
    def __init__(self, routing_source: MapDataSource, places_source: MapDataSource):
        self._routing_source = routing_source   # e.g. OSMMapDataSource
        self._places_source = places_source     # e.g. OvertureMapDataSource

    async def get_places(self, category: PlaceCategory, bbox: BBox) -> list[Place]:
        return await self._places_source.get_places(category, bbox)

    async def get_place_by_id(self, place_id: str) -> Place | None:
        # Each source answers only for its own id prefix, so trying both is
        # cheap — the wrong one returns None immediately.
        return await self._places_source.get_place_by_id(
            place_id
        ) or await self._routing_source.get_place_by_id(place_id)

    async def search_addresses(self, query: str, limit: int = 5) -> list[Address]:
        places, addresses = await asyncio.gather(
            self._places_source.search_addresses(query, limit),
            self._routing_source.search_addresses(query, limit),
            return_exceptions=True,
        )
        results = list(places) if not isinstance(places, BaseException) else []
        if not isinstance(addresses, BaseException):
            results.extend(a for a in addresses if not _near_any(a, results))
        return results[:limit]

    async def get_routing_graph_ref(self, bbox: BBox) -> RoutingGraphRef:
        return await self._routing_source.get_routing_graph_ref(bbox)
