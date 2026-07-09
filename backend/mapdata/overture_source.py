"""Overture Maps-backed MapDataSource.

Not implemented until OSM place data quality is a measured bottleneck for a
specific enrichment feature — see the Tech Stack table's note on Overture.
Kept here, unimplemented, so `MapDataSource` is proven complete against a
second provider's shape rather than assumed complete.

Expected implementation approach when this is built: query Overture's
released Parquet files (places/addresses/buildings themes) via `duckdb` with
the spatial extension, filtered by bbox — no live API to call, unlike OSM's
Overpass. `_OVERTURE_CATEGORY_TO_CATEGORY` below mirrors the structure of
`_OSM_TAG_TO_CATEGORY` in osm_source.py; Overture's category taxonomy
(https://docs.overturemaps.org/schema/concepts/by-theme/places/overture_categories/)
maps far more cleanly onto PlaceCategory than OSM's free-form tags do.
"""
from __future__ import annotations

from mapdata.base import MapDataSource
from mapdata.models import Address, BBox, Place, PlaceCategory, RoutingGraphRef

_OVERTURE_CATEGORY_TO_CATEGORY: dict[str, PlaceCategory] = {
    "electric_vehicle_charging_station": PlaceCategory.EV_CHARGING,
    "gas_station": PlaceCategory.FUEL,
    "parking_lot": PlaceCategory.PARKING,
    "park": PlaceCategory.PARK,
    "restaurant": PlaceCategory.RESTAURANT,
    "grocery_store": PlaceCategory.GROCERY,
    "hotel": PlaceCategory.LODGING,
    "bicycle_parking_station": PlaceCategory.BIKE_PARKING,
    "bus_stop": PlaceCategory.TRANSIT_STOP,
}


class OvertureMapDataSource(MapDataSource):
    async def get_places(self, category: PlaceCategory, bbox: BBox) -> list[Place]:
        raise NotImplementedError(
            "Build this when a specific feature is blocked on OSM place quality. "
            "See module docstring for the intended duckdb/Parquet approach."
        )

    async def get_place_by_id(self, place_id: str) -> Place | None:
        raise NotImplementedError

    async def search_addresses(self, query: str, limit: int = 5) -> list[Address]:
        raise NotImplementedError

    async def get_routing_graph_ref(self, bbox: BBox) -> RoutingGraphRef:
        # Overture has no mature routing-graph pipeline — this should never
        # actually be reached; routing graphs stay OSM-only (see osm_source.py).
        raise NotImplementedError("Routing graphs are OSM-only; use OSMMapDataSource for this.")
