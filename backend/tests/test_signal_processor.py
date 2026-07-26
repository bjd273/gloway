"""Unit tests for GPS implicit-signal computation. Pure functions — shapely
and numpy are main deps, so no DB and no importorskip needed."""
from types import SimpleNamespace

import pytest

from services.signal_processor import (
    compute_implicit_reward,
    compute_implicit_signals,
    compute_route_adherence,
    decode_polyline,
    route_coords_from_suggested,
)


def encode_polyline(coords: list[tuple[float, float]], precision: int = 6) -> str:
    """(lon, lat) pairs -> encoded polyline. Test-only inverse of decode."""
    factor = 10 ** precision
    result = []
    prev_lat = prev_lon = 0
    for lon, lat in coords:
        ilat, ilon = round(lat * factor), round(lon * factor)
        for delta in (ilat - prev_lat, ilon - prev_lon):
            delta = ~(delta << 1) if delta < 0 else (delta << 1)
            while delta >= 0x20:
                result.append(chr((0x20 | (delta & 0x1F)) + 63))
                delta >>= 5
            result.append(chr(delta + 63))
        prev_lat, prev_lon = ilat, ilon
    return "".join(result)


# A short line heading east across downtown Arlington, ~1 point per ~35 m.
_ROUTE = [(-97.110 + i * 0.0004, 32.735) for i in range(10)]


def test_decode_is_inverse_of_encode():
    decoded = decode_polyline(encode_polyline(_ROUTE))
    for (lon, lat), (dlon, dlat) in zip(_ROUTE, decoded):
        assert dlon == pytest.approx(lon, abs=1e-5)
        assert dlat == pytest.approx(lat, abs=1e-5)


def test_route_coords_from_suggested_extracts_legs():
    suggested = {"trip": {"legs": [{"shape": encode_polyline(_ROUTE)}]}}
    coords = route_coords_from_suggested(suggested)
    assert len(coords) == len(_ROUTE)
    assert coords[0][0] == pytest.approx(_ROUTE[0][0], abs=1e-5)


@pytest.mark.parametrize("bad", [{}, {"trip": {}}, {"trip": {"legs": []}}, None, {"trip": None}])
def test_route_coords_from_malformed_is_empty(bad):
    assert route_coords_from_suggested(bad) == []


def test_adherence_high_for_on_route_trace():
    result = compute_route_adherence(_ROUTE, _ROUTE)
    assert result["adherence_rate"] == pytest.approx(1.0)
    assert result["deviation_count"] == 0
    assert result["max_deviation_meters"] < 1.0


def test_adherence_flags_off_route_excursion():
    # Nudge the middle three fixes ~120 m north (0.0011 deg lat).
    trace = [(lon, lat + (0.0011 if 3 <= i <= 5 else 0)) for i, (lon, lat) in enumerate(_ROUTE)]
    result = compute_route_adherence(_ROUTE, trace)
    assert result["adherence_rate"] < 1.0
    assert result["deviation_count"] == 1
    assert result["max_deviation_meters"] > 50.0


def test_adherence_meters_projection_threshold():
    # ~40 m north stays on-route; ~60 m north trips the 50 m threshold.
    near = [(lon, lat + 0.00036) for lon, lat in _ROUTE]
    far = [(lon, lat + 0.00054) for lon, lat in _ROUTE]
    assert compute_route_adherence(_ROUTE, near)["adherence_rate"] == pytest.approx(1.0)
    assert compute_route_adherence(_ROUTE, far)["adherence_rate"] == pytest.approx(0.0)


def test_adherence_none_for_too_few_points():
    assert compute_route_adherence(_ROUTE, [(-97.1, 32.7)])["adherence_rate"] is None


def test_implicit_reward_signs():
    perfect = {"adherence_rate": 1.0}
    assert compute_implicit_reward(perfect, time_delta_minutes=-5, app_switch_count=0,
                                   trip_completed=True) > 0
    assert compute_implicit_reward({}, 0, 0, trip_completed=False) == -0.5
    bad = compute_implicit_reward({"adherence_rate": 0.1}, time_delta_minutes=15,
                                  app_switch_count=5, trip_completed=True)
    assert bad < 0
    assert -1.0 <= bad <= 1.0


def _trip(actual_path, suggested=None, duration=None):
    return SimpleNamespace(
        actual_path_taken=actual_path,
        suggested_route=suggested or {"trip": {"legs": [{"shape": encode_polyline(_ROUTE)}],
                                               "summary": {"time": 600}}},
        started_at=None,
        completed_at=None,
        implicit_signals={"client_summary": {"duration_minutes": duration}} if duration else {},
    )


def test_compute_implicit_signals_end_to_end():
    trace = [{"lat": lat, "lon": lon} for lon, lat in _ROUTE]
    signals = compute_implicit_signals(_trip(trace, duration=8.0))  # 8 min vs 10 min ETA
    assert signals["adherence_rate"] == pytest.approx(1.0)
    assert signals["time_delta_minutes"] == pytest.approx(-2.0)  # arrived 2 min early
    assert signals["implicit_reward"] > 0
    assert signals["app_switch_count"] == 0


def test_compute_implicit_signals_empty_without_trace():
    assert compute_implicit_signals(_trip([])) == {}
    assert compute_implicit_signals(_trip(None)) == {}
