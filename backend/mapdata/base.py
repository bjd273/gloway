"""Abstract interface every map data source must implement.

Adding Overture, or blending it with OSM, means writing one new class in this
package and flipping `settings.map_data_source` in config.py — nothing above
this layer (API routes, enrichment logic, ML feature extraction) changes.
Every implementation must pass `backend/tests/mapdata/test_contract.py`
before it is wired into `factory.get_map_data_source()`.
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from mapdata.models import Address, BBox, Place, PlaceCategory, RoutingGraphRef


class MapDataSource(ABC):
    @abstractmethod
    async def get_places(self, category: PlaceCategory, bbox: BBox) -> list[Place]:
        """All places of one category inside bbox.

        Must return an empty list, never None or raise, when nothing matches —
        callers (e.g. EV charging waypoint insertion) treat "no results" as a
        normal case, not an error path.
        """

    @abstractmethod
    async def get_place_by_id(self, place_id: str) -> Place | None:
        ...

    @abstractmethod
    async def search_addresses(self, query: str, limit: int = 5) -> list[Address]:
        """Free-text geocoding. Replaces calling Nominatim/Overture geocoding
        directly from route handlers."""

    @abstractmethod
    async def get_routing_graph_ref(self, bbox: BBox) -> RoutingGraphRef:
        """Which built routing tileset covers this bbox. Metadata only —
        actual routing still goes through routing.valhalla_client."""
