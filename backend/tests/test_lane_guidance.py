"""Tests for grafting OSRM turn lanes onto native maneuvers.

The unit tests use hand-built responses shaped like the real ones. The
integration test hits a live Valhalla and is skipped when none is reachable —
it is the only thing that can catch Valhalla changing which intersection holds
a maneuver's lanes, which no fixture can.
"""
import socket
from urllib.parse import urlparse

import pytest

from config import settings
from routing.lane_guidance import merge_lane_guidance
from routing.valhalla_client import ValhallaRouter

_LEFT = [{"indications": ["left"], "valid_indication": "left", "valid": True, "active": True}]
_RIGHT = [{"indications": ["right"], "valid_indication": "right", "valid": True, "active": True}]


def _native(time: float, maneuvers: int) -> dict:
    return {
        "summary": {"time": time, "length": 5.0},
        "legs": [{"shape": "abc", "maneuvers": [{"instruction": f"m{i}"} for i in range(maneuvers)]}],
    }


def _osrm(duration: float, lanes_per_step: list) -> dict:
    return {
        "duration": duration,
        "legs": [
            {
                "steps": [
                    {"intersections": [{"lanes": lanes}] if lanes else [{}]}
                    for lanes in lanes_per_step
                ]
            }
        ],
    }


def test_lanes_land_on_the_matching_maneuver():
    native = {"trip": _native(100.0, 2)}
    osrm = {"routes": [_osrm(100.0, [_LEFT, _RIGHT])]}
    assert merge_lane_guidance(native, osrm) == 2
    maneuvers = native["trip"]["legs"][0]["maneuvers"]
    assert maneuvers[0]["lanes"] == _LEFT
    assert maneuvers[1]["lanes"] == _RIGHT


def test_alternates_pair_by_order():
    native = {"trip": _native(100.0, 1), "alternates": [{"trip": _native(200.0, 1)}]}
    osrm = {"routes": [_osrm(100.0, [_LEFT]), _osrm(200.0, [_RIGHT])]}
    assert merge_lane_guidance(native, osrm) == 2
    assert native["trip"]["legs"][0]["maneuvers"][0]["lanes"] == _LEFT
    assert native["alternates"][0]["trip"]["legs"][0]["maneuvers"][0]["lanes"] == _RIGHT


def test_duration_mismatch_drops_lanes_rather_than_guessing():
    """Wrong lanes are worse than no lanes — they point at a real lane."""
    native = {"trip": _native(100.0, 2)}
    osrm = {"routes": [_osrm(999.0, [_LEFT, _RIGHT])]}
    assert merge_lane_guidance(native, osrm) == 0
    assert "lanes" not in native["trip"]["legs"][0]["maneuvers"][0]


def test_maneuver_count_mismatch_drops_lanes():
    # Same duration, different shape: the zip would silently misalign.
    native = {"trip": _native(100.0, 3)}
    osrm = {"routes": [_osrm(100.0, [_LEFT, _RIGHT])]}
    assert merge_lane_guidance(native, osrm) == 0


def test_steps_without_lanes_are_left_alone():
    native = {"trip": _native(100.0, 2)}
    osrm = {"routes": [_osrm(100.0, [None, _RIGHT])]}
    assert merge_lane_guidance(native, osrm) == 1
    maneuvers = native["trip"]["legs"][0]["maneuvers"]
    assert "lanes" not in maneuvers[0]
    assert maneuvers[1]["lanes"] == _RIGHT


def test_empty_lane_list_is_treated_as_absent():
    native = {"trip": _native(100.0, 1)}
    osrm = {"routes": [_osrm(100.0, [[]])]}
    assert merge_lane_guidance(native, osrm) == 0
    assert "lanes" not in native["trip"]["legs"][0]["maneuvers"][0]


@pytest.mark.parametrize(
    "native, osrm",
    [
        ({}, {}),
        ({"trip": None}, {"routes": None}),
        ({"trip": _native(1.0, 1)}, {"routes": [{"duration": 1.0, "legs": None}]}),
        ("not a dict", {"routes": []}),
    ],
)
def test_malformed_input_never_raises(native, osrm):
    """This runs in the routing hot path; it must not be able to fail a request."""
    assert merge_lane_guidance(native, osrm) == 0


def _valhalla_reachable() -> bool:
    parsed = urlparse(settings.valhalla_url)
    host, port = parsed.hostname or "localhost", parsed.port or 8002
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


@pytest.mark.integration
@pytest.mark.skipif(not _valhalla_reachable(), reason="live Valhalla instance not reachable")
async def test_live_lanes_agree_with_the_turn_being_made():
    """The one test that can catch Valhalla moving lanes to another intersection.

    A maneuver's lanes come from `intersections[0]` of the matching step. If
    that ever became `intersections[-1]`, the arrows would describe the turn
    AFTER this one — so assert that a lane marked valid actually points the way
    the maneuver goes.
    """
    origin, destination = (32.70, -97.11), (32.75, -97.09)
    async with ValhallaRouter(settings.valhalla_url) as router:
        native = await router.get_route(origin, destination, alternatives=3)
        osrm = await router.get_route(
            origin, destination, alternatives=3, response_format="osrm"
        )

    assert merge_lane_guidance(native, osrm) > 0, "no lanes merged from a live route"

    # Valhalla maneuver type -> the indication a valid lane should carry.
    wanted = {10: "right", 15: "left", 9: "slight right", 16: "slight left"}
    checked = 0
    for leg in native["trip"]["legs"]:
        for maneuver in leg["maneuvers"]:
            expected = wanted.get(maneuver.get("type"))
            lanes = maneuver.get("lanes")
            if not expected or not lanes:
                continue
            valid = [lane for lane in lanes if lane.get("valid")]
            if not valid:
                continue  # legal: no lane on this approach serves the turn
            assert any(
                expected in lane.get("indications", []) for lane in valid
            ), f"maneuver {maneuver['instruction']!r} wants {expected}, lanes say {valid}"
            checked += 1
    assert checked > 0, "no turn maneuver carried usable lane data to verify"
