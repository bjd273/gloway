"""Tests for /api/v1/places/along-route.

No Postgres and no Overpass: the DB session and the map data source are both
swapped out, because what is worth testing here is the geometry — that the
polyline really is cut at the driver and that nothing behind them survives.

Fixtures use a straight east-west line at ~32.72 N (the Arlington extract the
rest of the suite routes in), where a degree of longitude is ~94 km, not 111.
That difference is the whole point of projecting to meters first, so the
distances below would be wrong under flat degree math.
"""
import uuid

import httpx
import pytest

from api.routes import places as places_module
from db.session import get_db
from mapdata.models import Place, PlaceCategory

LAT = 32.72
# ~1 km of longitude at this latitude, so the fixtures read in round numbers.
KM_LON = 1000.0 / (111_320.0 * 0.8422)


def _encode(coords):
    """Valhalla-style precision-6 polyline of (lon, lat) pairs."""
    out = []
    prev_lat = prev_lon = 0
    for lon, lat in coords:
        for value, prev in ((lat, prev_lat), (lon, prev_lon)):
            delta = int(round(value * 1e6)) - prev
            delta = ~(delta << 1) if delta < 0 else (delta << 1)
            while delta >= 0x20:
                out.append(chr((0x20 | (delta & 0x1F)) + 63))
                delta >>= 5
            out.append(chr(delta + 63))
        prev_lat = int(round(lat * 1e6))
        prev_lon = int(round(lon * 1e6))
    return "".join(out)


def _trip_with_route(coords):
    class _Trip:
        suggested_route = {"trip": {"legs": [{"shape": _encode(coords)}]}}

    return _Trip()


class _FakeSource:
    def __init__(self, places):
        self._places = places
        self.bboxes = []

    async def get_places(self, category, bbox):
        self.bboxes.append(bbox)
        return self._places

    async def aclose(self):
        self.closed = True


class _DownSource:
    async def get_places(self, category, bbox):
        raise RuntimeError("overpass 502")

    async def aclose(self):
        pass


def _place(name, lon, lat):
    return Place(
        id=f"osm:node/{name}", name=name, category=PlaceCategory.FUEL,
        lat=lat, lon=lon, source="osm",
    )


@pytest.fixture
def client(monkeypatch):
    """App wired to a fixed trip and a fixed place list."""
    from api.main import app

    state = {"trip": None, "source": None}

    class _FakeDb:
        async def get(self, model, tid):
            return state["trip"]

    async def _db():
        yield _FakeDb()

    app.dependency_overrides[get_db] = _db
    monkeypatch.setattr(places_module, "get_map_data_source", lambda: state["source"])

    async def make(trip, source):
        state["trip"] = trip
        state["source"] = source
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        )

    yield make
    app.dependency_overrides.pop(get_db, None)


def _query(**overrides):
    params = {
        "trip_id": str(uuid.uuid4()),
        "category": "fuel",
        "from_lat": LAT,
        "from_lon": 0.0,
    }
    params.update(overrides)
    return params


async def test_places_behind_the_driver_are_dropped(client):
    """The bug this endpoint exists to avoid: a corridor search around the whole
    trip happily returns the gas station you passed ten minutes ago."""
    route = [(0.0, LAT), (10 * KM_LON, LAT)]
    source = _FakeSource([
        _place("Behind", 1 * KM_LON, LAT),
        _place("Ahead", 8 * KM_LON, LAT),
    ])
    async with await client(_trip_with_route(route), source) as c:
        response = await c.get(
            "/api/v1/places/along-route", params=_query(from_lon=5 * KM_LON)
        )
    assert response.status_code == 200
    names = [p["name"] for p in response.json()["places"]]
    assert names == ["Ahead"]


async def test_ranked_by_detour_then_by_how_soon(client):
    """Both keys, in order: a far-but-on-route stop beats a near-but-off-route
    one, and among equally on-route stops the nearer one comes first."""
    route = [(0.0, LAT), (10 * KM_LON, LAT)]
    source = _FakeSource([
        # 500 m off route, 1 km ahead — the closest by straight-line distance
        # from the driver, and still the worst of the three.
        _place("Detour", 1 * KM_LON, LAT + 500 / 110_540.0),
        _place("Far", 8 * KM_LON, LAT),
        _place("Near", 3 * KM_LON, LAT),
    ])
    async with await client(_trip_with_route(route), source) as c:
        response = await c.get("/api/v1/places/along-route", params=_query())
    assert [p["name"] for p in response.json()["places"]] == ["Near", "Far", "Detour"]


async def test_far_off_route_and_nameless_places_are_dropped(client):
    route = [(0.0, LAT), (10 * KM_LON, LAT)]
    source = _FakeSource([
        _place("Way off", 5 * KM_LON, LAT + 3000 / 110_540.0),   # 3 km off route
        Place(id="osm:node/1", name=None, category=PlaceCategory.FUEL,
              lat=LAT, lon=5 * KM_LON, source="osm"),
        _place("Fine", 5 * KM_LON, LAT),
    ])
    async with await client(_trip_with_route(route), source) as c:
        response = await c.get("/api/v1/places/along-route", params=_query())
    assert [p["name"] for p in response.json()["places"]] == ["Fine"]


async def test_the_same_place_from_two_providers_takes_one_slot(client):
    """The hybrid source blends Overture and OSM and carries popular POIs in
    both, metres apart. Three slots is too tight to spend two on one diner."""
    route = [(0.0, LAT), (10 * KM_LON, LAT)]
    source = _FakeSource([
        _place("Mama Deluca's", 2 * KM_LON, LAT),
        _place("mama deluca's", 2 * KM_LON + 0.00002, LAT),   # ~2 m away, other provider
        _place("Mama Deluca's", 7 * KM_LON, LAT),             # a real second branch
    ])
    async with await client(_trip_with_route(route), source) as c:
        response = await c.get("/api/v1/places/along-route", params=_query())
    places = response.json()["places"]
    assert len(places) == 2
    assert places[0]["along_meters"] == pytest.approx(2000, rel=0.02)
    assert places[1]["along_meters"] == pytest.approx(7000, rel=0.02)


async def test_limit_caps_the_list(client):
    route = [(0.0, LAT), (10 * KM_LON, LAT)]
    source = _FakeSource([_place(f"P{i}", i * KM_LON, LAT) for i in range(1, 6)])
    async with await client(_trip_with_route(route), source) as c:
        response = await c.get("/api/v1/places/along-route", params=_query(limit=2))
    assert [p["name"] for p in response.json()["places"]] == ["P1", "P2"]


async def test_along_meters_is_measured_from_the_driver(client):
    """Not from the start of the route — "in 2 mi" has to mean from here."""
    route = [(0.0, LAT), (10 * KM_LON, LAT)]
    source = _FakeSource([_place("Ahead", 8 * KM_LON, LAT)])
    async with await client(_trip_with_route(route), source) as c:
        response = await c.get(
            "/api/v1/places/along-route", params=_query(from_lon=5 * KM_LON)
        )
    ahead = response.json()["places"][0]
    assert ahead["along_meters"] == pytest.approx(3000, rel=0.02)
    assert ahead["detour_meters"] == pytest.approx(0, abs=1)


async def test_provider_failure_is_an_empty_list_not_a_500(client):
    """A driver at 60 mph gets "nothing nearby"; an error dialog would be worse
    than useless."""
    route = [(0.0, LAT), (10 * KM_LON, LAT)]
    async with await client(_trip_with_route(route), _DownSource()) as c:
        response = await c.get("/api/v1/places/along-route", params=_query())
    assert response.status_code == 200
    assert response.json()["places"] == []


async def test_route_already_finished_returns_empty(client):
    """Past the end of the line there is nothing ahead to search."""
    route = [(0.0, LAT), (10 * KM_LON, LAT)]
    source = _FakeSource([_place("Anywhere", 5 * KM_LON, LAT)])
    async with await client(_trip_with_route(route), source) as c:
        response = await c.get(
            "/api/v1/places/along-route", params=_query(from_lon=11 * KM_LON)
        )
    assert response.status_code == 200
    assert response.json()["places"] == []


async def test_unknown_trip_is_404(client):
    async with await client(None, _FakeSource([])) as c:
        response = await c.get("/api/v1/places/along-route", params=_query())
    assert response.status_code == 404


async def test_bad_trip_id_and_bad_category_are_422(client):
    async with await client(_trip_with_route([(0.0, LAT), (1.0, LAT)]), _FakeSource([])) as c:
        assert (await c.get(
            "/api/v1/places/along-route", params=_query(trip_id="not-a-uuid")
        )).status_code == 422
        assert (await c.get(
            "/api/v1/places/along-route", params=_query(category="unicorn_stable")
        )).status_code == 422
