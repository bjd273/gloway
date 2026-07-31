"""HybridMapDataSource merge behavior, exercised with stub sources — no
network, no parquet.

The ordering contract changed here: results used to be "places source first,
Nominatim appended", so a source listed first could fill the limit with weak
matches and discard a better one. Now the union is scored by ranking.py and the
best results win regardless of which source produced them.
"""
import pytest

from mapdata.base import MapDataSource
from mapdata.hybrid_source import HybridMapDataSource
from mapdata.models import Address, BBox, Place, PlaceCategory, RoutingGraphRef


def _addr(id_: str, lat: float, lon: float, source: str, name: str | None = None) -> Address:
    return Address(
        id=id_,
        formatted=name or id_,
        lat=lat,
        lon=lon,
        source=source,
        metadata={"name": name} if name else {},
    )


class StubSource(MapDataSource):
    def __init__(self, addresses=(), place=None, fail_search=False):
        self._addresses = list(addresses)
        self._place = place
        self._fail_search = fail_search
        self.last_limit: int | None = None

    async def get_places(self, category: PlaceCategory, bbox: BBox) -> list[Place]:
        return []

    async def get_place_by_id(self, place_id: str) -> Place | None:
        return self._place

    async def search_addresses(self, query: str, limit: int = 5) -> list[Address]:
        self.last_limit = limit
        if self._fail_search:
            raise RuntimeError("source down")
        return self._addresses[:limit]

    async def get_routing_graph_ref(self, bbox: BBox) -> RoutingGraphRef:
        return RoutingGraphRef(region_id="test", built_at="", source="osm")


def _hybrid(routing, *places) -> HybridMapDataSource:
    return HybridMapDataSource(routing_source=routing, places_sources=list(places))


async def test_best_match_wins_regardless_of_source_order():
    # The regression this guards: the routing source is queried last, but its
    # exact match must still beat the places source's substring matches instead
    # of being truncated away behind them.
    hybrid = _hybrid(
        StubSource(addresses=[_addr("exact", 32.70, -97.20, "osm", name="Parks Mall")]),
        StubSource(
            addresses=[
                _addr("weak1", 32.73, -97.11, "overture", name="Parks Mall Dental Suite"),
                _addr("weak2", 32.74, -97.12, "overture", name="Sparks Mallory Realty"),
            ]
        ),
    )
    results = await hybrid.search_addresses("Parks Mall", limit=2)
    assert results[0].id == "exact"


async def test_limit_truncates_the_ranked_union():
    hybrid = _hybrid(
        StubSource(addresses=[_addr("a", 32.70, -97.20, "osm", name="Cafe A")]),
        StubSource(addresses=[_addr("b", 32.73, -97.11, "overture", name="Cafe B")]),
    )
    assert len(await hybrid.search_addresses("cafe", limit=1)) == 1


async def test_sources_are_asked_for_more_than_the_caller_wants():
    # Ranking can only pick a good result if it was given candidates to pick
    # from; asking each source for exactly `limit` reintroduces the truncation
    # bug one level down.
    routing = StubSource()
    places = StubSource()
    await _hybrid(routing, places).search_addresses("q", limit=5)
    assert routing.last_limit > 5
    assert places.last_limit > 5


async def test_nearby_same_venue_is_deduped():
    hybrid = _hybrid(
        StubSource(
            addresses=[
                _addr("dup", 32.7301, -97.1101, "osm", name="Loft Coffee"),   # ~15m away
                _addr("kept", 32.7500, -97.0900, "osm", name="Other Coffee"),
            ]
        ),
        StubSource(addresses=[_addr("place1", 32.7300, -97.1100, "overture", name="Loft Coffee")]),
    )
    assert sorted(r.id for r in await hybrid.search_addresses("coffee")) == ["kept", "place1"]


async def test_identical_names_dedupe_across_a_wider_radius():
    # A theme park or stadium is a polygon in one source and a point in another,
    # and the centroids can sit hundreds of metres apart — 50 m does not catch
    # it, which is how "Six Flags Over Texas" came back twice.
    hybrid = _hybrid(
        StubSource(addresses=[_addr("osm-poly", 32.7550, -97.0700, "osm", name="Six Flags Over Texas")]),
        StubSource(addresses=[_addr("ovt-point", 32.7590, -97.0740, "overture", name="Six Flags Over Texas")]),
    )
    assert len(await hybrid.search_addresses("six flags")) == 1


async def test_distinct_names_at_one_address_are_both_kept():
    # The other side of that trade: a mall food court packs many genuinely
    # different places into one building, and collapsing them would hide most
    # of a shopping centre from search.
    hybrid = _hybrid(
        StubSource(),
        StubSource(
            addresses=[
                _addr("a", 32.7300, -97.1100, "overture", name="Panda Express"),
                _addr("b", 32.7301, -97.1101, "overture", name="Sarku Japan"),
            ]
        ),
    )
    assert len(await hybrid.search_addresses("express")) == 2


@pytest.mark.parametrize(
    "routing_fails, places_fails, expected",
    [(True, False, ["place1"]), (False, True, ["addr1"])],
)
async def test_one_source_failing_still_returns_the_other(routing_fails, places_fails, expected):
    hybrid = _hybrid(
        StubSource(addresses=[_addr("addr1", 32.70, -97.20, "osm")], fail_search=routing_fails),
        StubSource(addresses=[_addr("place1", 32.73, -97.11, "overture")], fail_search=places_fails),
    )
    assert [r.id for r in await hybrid.search_addresses("q")] == expected


async def test_all_places_sources_are_merged():
    hybrid = _hybrid(
        StubSource(),
        StubSource(addresses=[_addr("overture1", 32.73, -97.11, "overture", name="Alpha")]),
        StubSource(addresses=[_addr("osmpoi1", 32.75, -97.09, "osm", name="Alpha Two")]),
    )
    assert sorted(r.id for r in await hybrid.search_addresses("alpha")) == ["osmpoi1", "overture1"]


async def test_get_place_by_id_falls_back_to_routing_source():
    place = Place(
        id="osm:node/1", name="X", category=PlaceCategory.CAFE, lat=1.0, lon=2.0, source="osm"
    )
    hybrid = _hybrid(StubSource(place=place), StubSource(place=None))
    assert await hybrid.get_place_by_id("osm:node/1") is place
