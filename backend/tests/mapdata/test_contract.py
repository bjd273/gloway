"""Shared behavioral contract for every MapDataSource implementation.

Parametrize over every concrete class as it's built (OSMMapDataSource now,
OvertureMapDataSource / HybridMapDataSource later). A new implementation is
not safe to wire into factory.get_map_data_source() until it passes this file.

The network-touching tests are marked integration: they hit the public
Overpass/Nominatim endpoints and skip automatically when the network (or the
service) is unavailable, so the suite stays green offline.
"""
import socket

import pytest

from mapdata.factory import get_map_data_source
from mapdata.models import BBox, PlaceCategory
from mapdata.osm_source import OSMMapDataSource

# Extend this list as new implementations are built:
IMPLEMENTATIONS = [OSMMapDataSource]

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
async def source(request):
    impl = request.param()
    yield impl
    if hasattr(impl, "aclose"):
        await impl.aclose()


def test_factory_returns_configured_source():
    # Default settings say "osm" — the factory must honor that.
    assert isinstance(get_map_data_source(), OSMMapDataSource)


async def test_unmapped_category_returns_empty_list_without_network(source):
    # OTHER has no provider tag mapping — must short-circuit to [] locally.
    result = await source.get_places(PlaceCategory.OTHER, _EMPTY_OCEAN_BBOX)
    assert result == []


async def test_foreign_place_id_returns_none_without_network(source):
    assert await source.get_place_by_id("overture:place/abc") is None


async def test_get_routing_graph_ref_reports_osm_source(source):
    ref = await source.get_routing_graph_ref(_EMPTY_OCEAN_BBOX)
    assert ref.source == "osm"  # true regardless of implementation — see module docstrings
    assert ref.region_id


@pytest.mark.integration
@requires_network
async def test_get_places_returns_empty_list_not_none(source):
    result = await source.get_places(PlaceCategory.EV_CHARGING, _EMPTY_OCEAN_BBOX)
    assert result == []


@pytest.mark.integration
@requires_network
async def test_search_addresses_returns_normalized_type(source):
    results = await source.search_addresses("Arlington, TX", limit=1)
    assert results
    assert results[0].lat and results[0].lon
    assert results[0].source == "osm"
    assert "Arlington" in results[0].formatted
