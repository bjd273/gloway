"""OSM-backed MapDataSource — the only implementation needed through Phase 2.

Uses the public Overpass API for get_places and Nominatim for
search_addresses (fine for development and low query volume). Once query
volume matters, replace their internals with reads against a PostGIS table
bulk-loaded from the same .pbf via osmium/imposm — the public interface below
does not change, so nothing calling this class needs to know which one is
happening.

get_routing_graph_ref always reports source="osm": the routing graph build
in valhalla/ is OSM-only regardless of what this class (or a future
OvertureMapDataSource/HybridMapDataSource) backs places/addresses with.
"""
from __future__ import annotations

import httpx

from mapdata.base import MapDataSource
from mapdata.models import Address, BBox, Place, PlaceCategory, RoutingGraphRef

_OVERPASS_URL = "https://overpass-api.de/api/interpreter"
_NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
# Both Overpass and Nominatim reject requests without an identifying
# User-Agent (Overpass answers 406 Not Acceptable) — send it on every call.
_USER_AGENT = "AdaptiveMapApp/0.1 (dev)"
_HEADERS = {"User-Agent": _USER_AGENT}

# OSM (key, value) tag -> normalized category. Extend this as new use cases
# need new categories — this table is the ONLY place OSM tag vocabulary
# should appear outside of osm_source.py itself.
_OSM_TAG_TO_CATEGORY: dict[tuple[str, str], PlaceCategory] = {
    ("amenity", "charging_station"): PlaceCategory.EV_CHARGING,
    ("amenity", "fuel"): PlaceCategory.FUEL,
    ("amenity", "parking"): PlaceCategory.PARKING,
    ("leisure", "park"): PlaceCategory.PARK,
    ("amenity", "cafe"): PlaceCategory.CAFE,
    ("amenity", "restaurant"): PlaceCategory.RESTAURANT,
    ("shop", "supermarket"): PlaceCategory.GROCERY,
    ("tourism", "hotel"): PlaceCategory.LODGING,
    ("amenity", "bicycle_parking"): PlaceCategory.BIKE_PARKING,
    ("highway", "bus_stop"): PlaceCategory.TRANSIT_STOP,
}
_CATEGORY_TO_OSM_TAG = {v: k for k, v in _OSM_TAG_TO_CATEGORY.items()}


class OSMMapDataSource(MapDataSource):
    def __init__(self, client: httpx.AsyncClient | None = None):
        self._client = client or httpx.AsyncClient(timeout=30.0)
        self._owns_client = client is None

    async def get_places(self, category: PlaceCategory, bbox: BBox) -> list[Place]:
        tag = _CATEGORY_TO_OSM_TAG.get(category)
        if tag is None:
            return []  # No OSM tag mapped for this category yet — not an error.
        key, value = tag

        query = f"""
        [out:json][timeout:25];
        node["{key}"="{value}"]
          ({bbox.min_lat},{bbox.min_lon},{bbox.max_lat},{bbox.max_lon});
        out body;
        """
        response = await self._client.post(_OVERPASS_URL, data={"data": query}, headers=_HEADERS)
        response.raise_for_status()
        elements = response.json().get("elements", [])

        return [
            Place(
                id=f"osm:node/{el['id']}",
                name=el.get("tags", {}).get("name"),
                category=category,
                lat=el["lat"],
                lon=el["lon"],
                source="osm",
                metadata=el.get("tags", {}),
            )
            for el in elements
        ]

    async def get_place_by_id(self, place_id: str) -> Place | None:
        if not place_id.startswith("osm:node/"):
            return None
        node_id = place_id.removeprefix("osm:node/")
        query = f"[out:json][timeout:25]; node({node_id}); out body;"
        response = await self._client.post(_OVERPASS_URL, data={"data": query}, headers=_HEADERS)
        response.raise_for_status()
        elements = response.json().get("elements", [])
        if not elements:
            return None
        el = elements[0]
        tags = el.get("tags", {})
        category = next(
            (cat for (k, v), cat in _OSM_TAG_TO_CATEGORY.items() if tags.get(k) == v),
            PlaceCategory.OTHER,
        )
        return Place(
            id=place_id, name=tags.get("name"), category=category,
            lat=el["lat"], lon=el["lon"], source="osm", metadata=tags,
        )

    async def search_addresses(self, query: str, limit: int = 5) -> list[Address]:
        """Address geocoding, bounded to the region.

        Unbounded, this is a worldwide search: "Parks Mall" or "Main Street"
        spends every slot on higher-ranked places in other cities, which the
        frontend then greys out as "outside the current area" — the search
        appears to work and returns nothing usable. viewbox+bounded confines it
        to the box the routing tiles actually cover.
        """
        from mapdata.region_config import load_bbox

        params: dict[str, str | int] = {"q": query, "format": "json", "limit": limit}
        bbox = load_bbox()
        if bbox is not None:
            # Nominatim's viewbox order is left,top,right,bottom.
            params["viewbox"] = f"{bbox.min_lon},{bbox.max_lat},{bbox.max_lon},{bbox.min_lat}"
            params["bounded"] = 1
        response = await self._client.get(_NOMINATIM_URL, params=params, headers=_HEADERS)
        response.raise_for_status()
        return [
            Address(
                id=f"osm:{r['osm_type']}/{r['osm_id']}",
                formatted=r["display_name"],
                lat=float(r["lat"]),
                lon=float(r["lon"]),
                source="osm",
                metadata=r,
            )
            for r in response.json()
        ]

    async def get_routing_graph_ref(self, bbox: BBox) -> RoutingGraphRef:
        # Static for now — one region, one build. Once multiple regions exist,
        # look this up from the tileset manifest written by the Week 1-2 build.
        from config import settings

        return RoutingGraphRef(
            region_id=settings.routing_region_id,
            built_at=settings.routing_tiles_built_at,
            source="osm",
        )

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()
