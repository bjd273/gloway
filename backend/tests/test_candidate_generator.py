"""Candidate generation tests — stub router, no network.

The live-Valhalla behaviour is covered by test_api_routing.py; what matters
here is the logic that turns many overlapping Valhalla responses into a short
list of genuinely different routes.
"""
import pytest

from routing.candidate_generator import (
    Candidate,
    _straight_line_miles,
    dedupe,
    generate_candidates,
    strategies_for,
)
from services.signal_processor import decode_polyline


def encode_polyline(coords, precision: int = 6) -> str:
    """(lon, lat) -> encoded polyline. Inverse of signal_processor.decode_polyline."""
    factor = 10 ** precision
    out: list[str] = []
    prev_lat = prev_lon = 0
    for lon, lat in coords:
        ilat, ilon = round(lat * factor), round(lon * factor)
        for delta in (ilat - prev_lat, ilon - prev_lon):
            v = ~(delta << 1) if delta < 0 else (delta << 1)
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        prev_lat, prev_lon = ilat, ilon
    return "".join(out)


def test_encoder_round_trips():
    """Guard the test helper itself — a broken encoder would fake passes below."""
    coords = [(-97.13, 32.72), (-97.12, 32.73), (-97.11, 32.74)]
    assert decode_polyline(encode_polyline(coords)) == pytest.approx(coords, abs=1e-6)


def _line(lon0, lat0, lon1, lat1, n=30):
    return [
        (lon0 + (lon1 - lon0) * i / (n - 1), lat0 + (lat1 - lat0) * i / (n - 1))
        for i in range(n)
    ]


def _trip(coords, length=5.0, time_s=600.0):
    return {
        "summary": {"length": length, "time": time_s},
        "legs": [{"shape": encode_polyline(coords)}],
    }


def _cand(coords, key="s", label="S", primary=True, **kw):
    return Candidate(trip=_trip(coords, **kw), strategy=key, label=label, is_primary=primary)


# Two corridors ~1.5km apart — far beyond the 50m duplicate threshold.
NORTH = _line(-97.14, 32.760, -97.08, 32.760)
SOUTH = _line(-97.14, 32.745, -97.08, 32.745)


class StubRouter:
    """Returns a canned response per strategy, or raises for named failures.

    Every strategy fires twice — once natively and once in OSRM shape to
    harvest turn lanes (see routing/lane_guidance.py). `calls` counts only the
    native ones, so the assertions below stay about strategies rather than
    about how many dialects we happen to ask in; `osrm_calls` covers the rest.
    """

    def __init__(self, responses, fail_for=()):
        self._responses = responses
        self._fail_for = set(fail_for)
        self.calls: list[dict | None] = []
        self.osrm_calls: list[dict | None] = []

    async def get_route(self, *, costing_overrides=None, response_format=None, **kwargs):
        key = tuple(sorted((costing_overrides or {}).items()))
        if response_format == "osrm":
            self.osrm_calls.append(costing_overrides)
            # The lane merge drops anything that doesn't pair cleanly, so a stub
            # that returned nothing usable is the "no lanes today" path.
            return {"routes": []}
        self.calls.append(costing_overrides)
        if key in self._fail_for:
            raise RuntimeError("valhalla said no")
        return self._responses.get(key, self._responses.get("default"))


def _response(primary_coords, alternate_coords=()):
    return {
        "trip": _trip(primary_coords),
        "alternates": [{"trip": _trip(c)} for c in alternate_coords],
    }


# --- dedupe ----------------------------------------------------------------

def test_dedupe_collapses_identical_routes():
    kept = dedupe([_cand(NORTH, "a", "A"), _cand(NORTH, "b", "B")])
    assert len(kept) == 1
    assert kept[0].strategy == "a"  # first wins, so Valhalla's own primary survives


def test_dedupe_keeps_genuinely_different_routes():
    kept = dedupe([_cand(NORTH, "a", "A"), _cand(SOUTH, "b", "B")])
    assert [c.strategy for c in kept] == ["a", "b"]


def test_dedupe_respects_the_cap():
    lats = [32.700, 32.715, 32.730, 32.745, 32.760, 32.775, 32.790]
    cands = [_cand(_line(-97.14, la, -97.08, la), f"s{i}") for i, la in enumerate(lats)]
    assert len(dedupe(cands, max_candidates=3)) == 3


def test_dedupe_skips_routes_without_usable_geometry():
    empty = Candidate(trip={"summary": {}, "legs": []}, strategy="x", label="X")
    kept = dedupe([empty, _cand(NORTH, "a", "A")])
    assert [c.strategy for c in kept] == ["a"]


# --- generation ------------------------------------------------------------

@pytest.mark.asyncio
async def test_sweep_runs_every_strategy_and_pools_results():
    router = StubRouter({"default": _response(NORTH)})
    cands = await generate_candidates(router, (32.79, -97.12), (32.70, -97.12))
    # One call per auto strategy...
    assert len(router.calls) == len(strategies_for("auto"))
    # ...each shadowed by an OSRM call carrying the same costing, so lane
    # guidance describes the route we actually return rather than some other one.
    assert router.osrm_calls == router.calls
    # ...and the baseline goes out with no overrides, so the user's own
    # preferences are still represented in the pool.
    assert router.calls[0] is None
    # All responses are the same road, so only one candidate survives.
    assert len(cands) == 1


@pytest.mark.asyncio
async def test_a_failing_strategy_does_not_sink_the_request():
    fail = tuple(sorted({"use_highways": 0.0}.items()))
    router = StubRouter({"default": _response(NORTH)}, fail_for=[fail])
    cands = await generate_candidates(router, (32.79, -97.12), (32.70, -97.12))
    assert cands, "a failed exploratory strategy must not cost the user their route"


@pytest.mark.asyncio
async def test_all_strategies_failing_raises_so_the_caller_can_surface_it():
    class Dead:
        async def get_route(self, **kwargs):
            raise RuntimeError("valhalla down")

    with pytest.raises(RuntimeError):
        await generate_candidates(Dead(), (32.79, -97.12), (32.70, -97.12))


@pytest.mark.asyncio
async def test_lane_lookup_failing_does_not_cost_the_user_their_route():
    """Lane guidance is a nicety bolted onto the routing hot path.

    It fires a second Valhalla call per strategy purely to read turn lanes. If
    that call errors the driver should lose a lane strip, not a route — so the
    failure is swallowed and the native response is returned untouched.
    """

    class OsrmIsDown(StubRouter):
        async def get_route(self, *, response_format=None, **kwargs):
            if response_format == "osrm":
                raise RuntimeError("osrm endpoint unhappy")
            return await super().get_route(**kwargs)

    router = OsrmIsDown({"default": _response(NORTH)})
    cands = await generate_candidates(router, (32.79, -97.12), (32.70, -97.12))
    assert cands
    assert all("lanes" not in m for c in cands for leg in c.trip["legs"] for m in leg.get("maneuvers", []))


@pytest.mark.asyncio
async def test_short_trips_skip_the_sweep():
    """Probing showed no knob changes a ~1.7mi route: the extra calls would
    only rediscover the same road."""
    router = StubRouter({"default": _response(NORTH)})
    await generate_candidates(router, (32.7317, -97.1028), (32.7266, -97.1170))
    assert len(router.calls) == 1


@pytest.mark.asyncio
async def test_every_strategy_is_considered_before_any_strategy_s_alternates():
    """Ordering regression.

    Ranked purely by arrival, the baseline's own alternates filled the cap and
    whole strategies ("no highways", "calmer roads") were never looked at.
    """
    lats = [32.700, 32.715, 32.730, 32.745, 32.760, 32.775, 32.790]
    distinct = [_line(-97.14, la, -97.08, la) for la in lats]
    # Baseline returns three distinct routes of its own; every other strategy
    # returns one distinct primary.
    responses = {"default": _response(distinct[0], distinct[1:3])}
    for i, strat in enumerate(strategies_for("auto")[1:], start=3):
        responses[tuple(sorted(strat.costing_options.items()))] = _response(distinct[i % len(distinct)])
    router = StubRouter(responses)

    cands = await generate_candidates(router, (32.79, -97.12), (32.70, -97.12), max_candidates=4)
    assert all(c.is_primary for c in cands), "primaries must be considered first"
    assert len({c.strategy for c in cands}) > 1, "more than one strategy must survive"


@pytest.mark.asyncio
async def test_alternates_do_not_inherit_the_strategy_label():
    router = StubRouter({"default": _response(NORTH, [SOUTH])})
    cands = await generate_candidates(router, (32.79, -97.12), (32.70, -97.12))
    alt = next(c for c in cands if not c.is_primary)
    # An alternate from the "fastest" call is not the fastest route.
    assert alt.label != "Fastest"


def test_mode_specific_strategies():
    auto = {s.key for s in strategies_for("auto")}
    bike = {s.key for s in strategies_for("bicycle")}
    walk = {s.key for s in strategies_for("pedestrian")}
    assert "avoid_highways" in auto and "avoid_highways" not in bike
    assert "quiet" in bike        # use_roads — the "safer for biking" knob
    assert "well_lit" in walk     # use_lit
    assert strategies_for("nonsense") == strategies_for("auto")


def test_straight_line_miles_is_sane():
    # ~6.2 miles north-south.
    assert _straight_line_miles((32.79, -97.12), (32.70, -97.12)) == pytest.approx(6.2, abs=0.3)
