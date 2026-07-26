"""OvertureMapDataSource behavior against the tiny fixture parquet — fully
offline; no network, no real extract needed."""
from mapdata.models import BBox, PlaceCategory
from mapdata.overture_source import OvertureMapDataSource

_REGION_BBOX = BBox(min_lat=32.715, min_lon=-97.140, max_lat=32.760, max_lon=-97.080)


def _source(tiny_places_parquet: str) -> OvertureMapDataSource:
    return OvertureMapDataSource(places_path=tiny_places_parquet)


async def test_get_places_by_category(tiny_places_parquet):
    places = await _source(tiny_places_parquet).get_places(PlaceCategory.CAFE, _REGION_BBOX)
    assert len(places) == 1
    place = places[0]
    assert place.name == "Loft Coffee"
    assert place.id == "overture:place/p-coffee"
    assert place.source == "overture"
    assert place.category == PlaceCategory.CAFE
    assert place.metadata["overture_category"] == "coffee_shop"


async def test_suffix_rule_catches_restaurant_leaves(tiny_places_parquet):
    # "italian_restaurant" is not in the exact-match dict; only the
    # *_restaurant suffix rule can reach it.
    places = await _source(tiny_places_parquet).get_places(
        PlaceCategory.RESTAURANT, _REGION_BBOX
    )
    assert [p.name for p in places] == ["Trattoria Nona"]
    assert places[0].category == PlaceCategory.RESTAURANT


async def test_bbox_filters_out_far_places(tiny_places_parquet):
    far_bbox = BBox(min_lat=40.0, min_lon=-75.0, max_lat=41.0, max_lon=-74.0)
    assert await _source(tiny_places_parquet).get_places(PlaceCategory.CAFE, far_bbox) == []


async def test_search_is_case_insensitive_and_formats_address(tiny_places_parquet):
    results = await _source(tiny_places_parquet).search_addresses("loft")
    # Substring hits both "Loft Coffee" and "Ink Loft"; prefix match ranks first.
    assert [r.formatted.split(",")[0] for r in results] == ["Loft Coffee", "Ink Loft"]
    assert results[0].formatted == "Loft Coffee, 201 E Front St, Arlington"
    assert results[0].source == "overture"


async def test_search_formats_partial_address(tiny_places_parquet):
    # Trattoria Nona has a locality but no street — formatted skips the hole.
    results = await _source(tiny_places_parquet).search_addresses("trattoria")
    assert results[0].formatted == "Trattoria Nona, Arlington"


async def test_search_respects_limit(tiny_places_parquet):
    results = await _source(tiny_places_parquet).search_addresses("loft", limit=1)
    assert len(results) == 1


async def test_get_place_by_id_round_trip(tiny_places_parquet):
    source = _source(tiny_places_parquet)
    place = await source.get_place_by_id("overture:place/p-italian")
    assert place is not None
    assert place.name == "Trattoria Nona"
    assert place.category == PlaceCategory.RESTAURANT
    assert await source.get_place_by_id("overture:place/nonexistent") is None


async def test_unmapped_category_maps_to_other(tiny_places_parquet):
    place = await _source(tiny_places_parquet).get_place_by_id("overture:place/p-tattoo")
    assert place is not None
    assert place.category == PlaceCategory.OTHER


async def test_missing_parquet_degrades_to_empty(caplog):
    source = OvertureMapDataSource(places_path="/nonexistent/places.parquet")
    assert await source.get_places(PlaceCategory.CAFE, _REGION_BBOX) == []
    assert await source.search_addresses("coffee") == []
    assert await source.get_place_by_id("overture:place/p-coffee") is None
