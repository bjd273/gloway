"""Tests for the Valhalla custom-costing translation (the RL injection seam).

Unit tests exercise ``_build_costing_options`` as pure logic. The integration
test hits a live Valhalla instance and is skipped automatically when none is
reachable, so the suite stays green in CI without the routing engine.
"""
import socket
from urllib.parse import urlparse

import pytest

from config import settings
from routing.valhalla_client import UserRoutingPrefs, ValhallaRouter


def _auto(prefs: UserRoutingPrefs) -> dict:
    return ValhallaRouter("http://unused")._build_costing_options(prefs)["auto"]


def test_defaults_are_neutral():
    a = _auto(UserRoutingPrefs())
    # Neutral urgency (0.5) and no aversions => highways/tolls fully allowed.
    assert a["use_highways"] == pytest.approx(1.0)
    assert a["use_tolls"] == pytest.approx(1.0)
    assert a["shortest"] is False


def test_avoid_highways_lowers_use_highways():
    assert _auto(UserRoutingPrefs(avoid_highways=1.0))["use_highways"] < 0.2
    # monotonic: stronger aversion => lower use_highways
    weak = _auto(UserRoutingPrefs(avoid_highways=0.3))["use_highways"]
    strong = _auto(UserRoutingPrefs(avoid_highways=0.8))["use_highways"]
    assert strong < weak


def test_avoid_tolls_lowers_use_tolls():
    assert _auto(UserRoutingPrefs(avoid_tolls=1.0))["use_tolls"] < 0.2


def test_scenic_prefers_local_streets_and_avoids_highways():
    neutral = _auto(UserRoutingPrefs())
    scenic = _auto(UserRoutingPrefs(prefer_scenic=1.0))
    assert scenic["use_living_streets"] > neutral["use_living_streets"]
    assert scenic["use_highways"] < neutral["use_highways"]


def test_avoid_left_turns_raises_maneuver_penalty():
    none = _auto(UserRoutingPrefs(avoid_left_turns=0.0))["maneuver_penalty"]
    full = _auto(UserRoutingPrefs(avoid_left_turns=1.0))["maneuver_penalty"]
    assert full > none
    assert full == pytest.approx(300.0)


def test_urgency_nudges_highways_up():
    calm = _auto(UserRoutingPrefs(urgency=0.0))["use_highways"]
    rushed = _auto(UserRoutingPrefs(urgency=1.0))["use_highways"]
    assert rushed > calm


def test_out_of_range_prefs_are_clamped():
    # Valhalla silently ignores out-of-range values, so the client must clamp.
    a = _auto(UserRoutingPrefs(avoid_highways=5.0, avoid_tolls=-3.0, urgency=9.0))
    assert 0.0 <= a["use_highways"] <= 1.0
    assert 0.0 <= a["use_tolls"] <= 1.0


def _valhalla_reachable() -> bool:
    parsed = urlparse(settings.valhalla_url)
    host, port = parsed.hostname or "localhost", parsed.port or 8002
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


@pytest.mark.integration
@pytest.mark.skipif(
    not _valhalla_reachable(), reason="live Valhalla instance not reachable"
)
async def test_avoid_highways_changes_live_route():
    """Prove the seam end to end: a highway aversion yields a different route."""
    origin = (32.718, -97.135)
    destination = (32.758, -97.085)
    async with ValhallaRouter(settings.valhalla_url) as router:
        baseline = await router.get_route(origin, destination)
        avoid = await router.get_route(
            origin, destination, prefs=UserRoutingPrefs(avoid_highways=1.0)
        )

    base_summary = baseline["trip"]["summary"]
    avoid_summary = avoid["trip"]["summary"]
    # Avoiding highways should change time and/or length, not error out.
    assert (base_summary["time"], base_summary["length"]) != (
        avoid_summary["time"],
        avoid_summary["length"],
    )
