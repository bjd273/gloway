"""HybridMapDataSource merge behavior, exercised with stub sources — no
network, no parquet."""
from mapdata.base import MapDataSource
from mapdata.hybrid_source import HybridMapDataSource
from mapdata.models import Address, BBox, Place, PlaceCategory, RoutingGraphRef


def _addr(id_: str, lat: float, lon: float, source: str) -> Address:
    return Address(id=id_, formatted=id_, lat=lat, lon=lon, source=source)


class StubSource(MapDataSource):
    def __init__(self, addresses=(), place=None, fail_search=False):
        self._addresses = list(addresses)
        self._place = place
        self._fail_search = fail_search

    async def get_places(self, category: PlaceCategory, bbox: BBox) -> list[Place]:
        return []

    async def get_place_by_id(self, place_id: str) -> Place | None:
        return self._place

    async def search_addresses(self, query: str, limit: int = 5) -> list[Address]:
        if self._fail_search:
            raise RuntimeError("source down")
        return self._addresses[:limit]

    async def get_routing_graph_ref(self, bbox: BBox) -> RoutingGraphRef:
        return RoutingGraphRef(region_id="test", built_at="", source="osm")


async def test_places_rank_before_addresses_and_limit_applies():
    hybrid = HybridMapDataSource(
        routing_source=StubSource(addresses=[_addr("addr1", 32.70, -97.20, "osm")]),
        places_source=StubSource(
            addresses=[_addr("place1", 32.73, -97.11, "overture"), _addr("place2", 32.74, -97.12, "overture")]
        ),
    )
    results = await hybrid.search_addresses("q", limit=2)
    assert [r.id for r in results] == ["place1", "place2"]  # places first, truncated


async def test_nearby_address_deduped_against_place():
    hybrid = HybridMapDataSource(
        routing_source=StubSource(
            addresses=[
                _addr("dup", 32.7301, -97.1101, "osm"),   # ~15 m from place1 — same venue
                _addr("kept", 32.7500, -97.0900, "osm"),  # far away — genuinely different
            ]
        ),
        places_source=StubSource(addresses=[_addr("place1", 32.7300, -97.1100, "overture")]),
    )
    results = await hybrid.search_addresses("q")
    assert [r.id for r in results] == ["place1", "kept"]


async def test_nominatim_failure_still_returns_places():
    hybrid = HybridMapDataSource(
        routing_source=StubSource(fail_search=True),
        places_source=StubSource(addresses=[_addr("place1", 32.73, -97.11, "overture")]),
    )
    assert [r.id for r in await hybrid.search_addresses("q")] == ["place1"]


async def test_places_failure_still_returns_addresses():
    hybrid = HybridMapDataSource(
        routing_source=StubSource(addresses=[_addr("addr1", 32.70, -97.20, "osm")]),
        places_source=StubSource(fail_search=True),
    )
    assert [r.id for r in await hybrid.search_addresses("q")] == ["addr1"]


async def test_get_place_by_id_falls_back_to_routing_source():
    place = Place(
        id="osm:node/1", name="X", category=PlaceCategory.CAFE, lat=1.0, lon=2.0, source="osm"
    )
    hybrid = HybridMapDataSource(
        routing_source=StubSource(place=place), places_source=StubSource(place=None)
    )
    assert await hybrid.get_place_by_id("osm:node/1") is place
