"""Shared behavioral contract for every MapDataSource implementation.

Parametrized over all three concrete shapes: OSM (live APIs), Overture (local
parquet — tests run against the tiny fixture extract), and Hybrid (OSM routing
+ Overture places). A new implementation is not safe to wire into
factory.get_map_data_source() until it passes this file.

The network-touching tests are marked integration: they hit the public
Overpass/Nominatim endpoints and skip automatically when the network (or the
service) is unavailable, so the suite stays green offline.
"""
import socket

import pytest

from mapdata.factory import get_map_data_source
from mapdata.hybrid_source import HybridMapDataSource
from mapdata.models import BBox, PlaceCategory
from mapdata.osm_source import OSMMapDataSource
from mapdata.overture_source import OvertureMapDataSource

IMPLEMENTATIONS = ["osm", "overture", "hybrid"]

_EMPTY_OCEAN_BBOX = BBox(min_lat=0.0, min_lon=-30.0, max_lat=0.5, max_lon=-29.5)


def _internet_reachable() -> bool:
    try:
        with socket.create_connection(("nominatim.openstreetmap.org", 443), timeout=2):
            return True
    except OSError:
        return False


requires_network = pytest.mark.skipif(
    not _internet_reachable(), reason="public OSM endpoints not reachable"
)


@pytest.fixture(params=IMPLEMENTATIONS)
async def source(request, tiny_places_parquet):
    if request.param == "osm":
        impl = OSMMapDataSource()
    elif request.param == "overture":
        impl = OvertureMapDataSource(places_path=tiny_places_parquet)
    else:
        impl = HybridMapDataSource(
            routing_source=OSMMapDataSource(),
            places_source=OvertureMapDataSource(places_path=tiny_places_parquet),
        )
    yield impl
    if hasattr(impl, "aclose"):
        await impl.aclose()


def test_factory_returns_configured_source():
    # Default settings say "hybrid" — the factory must honor that.
    assert isinstance(get_map_data_source(), HybridMapDataSource)


async def test_unmapped_category_returns_empty_list_without_network(source):
    # OTHER has no provider tag/category mapping — must short-circuit to []
    # locally, before touching any network or file.
    result = await source.get_places(PlaceCategory.OTHER, _EMPTY_OCEAN_BBOX)
    assert result == []


async def test_foreign_place_id_returns_none_without_network(source):
    assert await source.get_place_by_id("custom:foo/1") is None


async def test_get_routing_graph_ref_reports_osm_source(source):
    if isinstance(source, OvertureMapDataSource):
        # Routing graphs are OSM-only by design; the pure-Overture source
        # raising here is the documented contract, not a violation.
        with pytest.raises(NotImplementedError):
            await source.get_routing_graph_ref(_EMPTY_OCEAN_BBOX)
        return
    ref = await source.get_routing_graph_ref(_EMPTY_OCEAN_BBOX)
    assert ref.source == "osm"  # true regardless of implementation — see module docstrings
    assert ref.region_id


@pytest.mark.integration
@requires_network
async def test_get_places_returns_empty_list_not_none(source):
    import httpx

    try:
        result = await source.get_places(PlaceCategory.EV_CHARGING, _EMPTY_OCEAN_BBOX)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code >= 500:
            # The public Overpass API 504s under load — that's their outage,
            # not a contract violation. Same spirit as requires_network.
            pytest.skip(f"public Overpass API unavailable ({exc.response.status_code})")
        raise
    assert result == []


@pytest.mark.integration
@requires_network
async def test_search_addresses_returns_normalized_type(source):
    if isinstance(source, OvertureMapDataSource):
        pytest.skip("pure Overture has no geocoder; name search is covered offline")
    results = await source.search_addresses("Arlington, TX", limit=1)
    assert results
    assert results[0].lat and results[0].lon
    assert results[0].source in {"osm", "overture"}
    assert "Arlington" in results[0].formatted
