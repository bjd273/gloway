"""Composes multiple MapDataSource implementations, one method at a time.

Example shape for when Overture lands: keep OSM for routing (the only mature
option) and move places/addresses to Overture (cleaner, deduped). Adjust which
source backs which method based on what you actually measure — this class is
a template, not a fixed policy.
"""
from __future__ import annotations

from mapdata.base import MapDataSource
from mapdata.models import Address, BBox, Place, PlaceCategory, RoutingGraphRef


class HybridMapDataSource(MapDataSource):
    def __init__(self, routing_source: MapDataSource, places_source: MapDataSource):
        self._routing_source = routing_source   # e.g. OSMMapDataSource
        self._places_source = places_source     # e.g. OvertureMapDataSource

    async def get_places(self, category: PlaceCategory, bbox: BBox) -> list[Place]:
        return await self._places_source.get_places(category, bbox)

    async def get_place_by_id(self, place_id: str) -> Place | None:
        return await self._places_source.get_place_by_id(place_id)

    async def search_addresses(self, query: str, limit: int = 5) -> list[Address]:
        return await self._places_source.search_addresses(query, limit)

    async def get_routing_graph_ref(self, bbox: BBox) -> RoutingGraphRef:
        return await self._routing_source.get_routing_graph_ref(bbox)
