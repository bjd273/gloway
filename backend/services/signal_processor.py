"""Implicit trip signals from GPS behavior (Week 15-16 + 23-24).

The frontend streams a real GPS trace into `trips.actual_path_taken` while the
user drives, and `trips.suggested_route` holds the Valhalla response for the
route we proposed. This module turns those into behavioral reward signals:
how closely the driver followed the route, how far/often they strayed, and a
scalar implicit reward. The reward engine (ml/rl/reward_engine.py) fuses that
with the debrief's explicit-feedback reward.

Corrections vs the roadmap sample: it converted shapely's degree distances to
meters with a flat `degrees * 111_000`, which is only right for latitude —
a degree of longitude is ~cos(lat) shorter. Here both the route and the trace
are projected into a local equirectangular meters frame first, so deviation
distances are accurate for a metro-sized area. `app_switch_count` has no data
source yet (no column, never collected), so it is stubbed at 0.
"""
from __future__ import annotations

import math
from datetime import datetime

import numpy as np
from shapely.geometry import LineString, Point


def decode_polyline(encoded: str, precision: int = 6) -> list[tuple[float, float]]:
    """Decode a Google/Valhalla-encoded polyline to (lon, lat) pairs.

    Valhalla encodes at precision 6 (see the frontend's parseTrip). Returns
    (lon, lat) — shapely's (x, y) order — rather than the usual (lat, lon).
    """
    coords: list[tuple[float, float]] = []
    index = lat = lon = 0
    factor = 10 ** precision
    length = len(encoded)
    while index < length:
        for axis in range(2):  # 0 = latitude delta, 1 = longitude delta
            shift = result = 0
            while True:
                byte = ord(encoded[index]) - 63
                index += 1
                result |= (byte & 0x1F) << shift
                shift += 5
                if byte < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else (result >> 1)
            if axis == 0:
                lat += delta
            else:
                lon += delta
        coords.append((lon / factor, lat / factor))
    return coords


def route_coords_from_suggested(suggested_route: dict) -> list[tuple[float, float]]:
    """Extract + decode the full route geometry (all legs) as (lon, lat).

    Returns [] for any missing/malformed structure so callers degrade rather
    than raise on an empty or unexpected suggested_route.
    """
    if not isinstance(suggested_route, dict):
        return []
    trip = suggested_route.get("trip")
    if not isinstance(trip, dict):
        return []
    coords: list[tuple[float, float]] = []
    for leg in trip.get("legs") or []:
        shape = leg.get("shape") if isinstance(leg, dict) else None
        if isinstance(shape, str) and shape:
            coords.extend(decode_polyline(shape))
    return coords


def _to_meters(coords, lat0: float, lon0: float) -> list[tuple[float, float]]:
    """Local equirectangular projection to meters around (lat0, lon0)."""
    k = math.cos(math.radians(lat0))
    return [((lon - lon0) * 111_320.0 * k, (lat - lat0) * 110_540.0) for lon, lat in coords]


def compute_route_adherence(
    route_coords: list[tuple[float, float]],
    actual_gps_trace: list[tuple[float, float]],
    deviation_threshold_meters: float = 50.0,
) -> dict:
    """How closely the trace followed the route, in real meters.

    Both inputs are (lon, lat). Returns adherence_rate (fraction of fixes
    within the threshold), deviation_count (distinct off-route excursions),
    and max/mean deviation. adherence_rate is None when there's too little
    data to judge.
    """
    if len(route_coords) < 2 or len(actual_gps_trace) < 2:
        return {"adherence_rate": None, "deviation_count": 0}

    lat0 = float(np.mean([lat for _, lat in route_coords]))
    lon0 = float(np.mean([lon for lon, _ in route_coords]))
    route_line = LineString(_to_meters(route_coords, lat0, lon0))

    deviations = np.array([
        route_line.distance(Point(x, y)) for x, y in _to_meters(actual_gps_trace, lat0, lon0)
    ])
    off_route = deviations > deviation_threshold_meters

    # Count distinct excursions (rising edges of the off-route mask), not fixes.
    deviation_events = int(np.sum(off_route[1:] & ~off_route[:-1]) + (1 if off_route[0] else 0))

    return {
        "adherence_rate": float(1.0 - off_route.mean()),
        "deviation_count": deviation_events,
        "max_deviation_meters": float(deviations.max()),
        "mean_deviation_meters": float(deviations.mean()),
    }


def _parse_iso(value) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _coords_from_shapes(shapes) -> list[tuple[float, float]]:
    """Decode a route_history segment's per-leg polylines to (lon, lat)."""
    coords: list[tuple[float, float]] = []
    for shape in shapes or []:
        if isinstance(shape, str) and shape:
            coords.extend(decode_polyline(shape))
    return coords


def compute_segmented_adherence(
    route_history: list | None,
    trace_points: list,
    deviation_threshold_meters: float = 50.0,
) -> dict:
    """Adherence for a drive whose route changed partway through.

    A reroute replaces the line the driver is following. Scoring the whole trace
    against the final route would count everything before the reroute as a
    massive deviation from a route the driver was never shown — one missed turn
    would make an otherwise obedient forty-minute drive look like the route was
    ignored, and the reward would punish a perfectly good suggestion.

    So the trace is split at each reroute (`route_history[i]["started_at"]`) and
    each piece scored against the route that was actually active then, with the
    pieces recombined weighted by fix count — which is what `adherence_rate`
    already means over a single trace.

    Returns {} when there's nothing to segment (fewer than two routes, or
    timestamps we can't read), so callers fall through to the ordinary
    whole-trace path unchanged.

    Note the two clocks: segment starts are stamped server-side, trace
    timestamps come from the browser. Both are UTC wall clocks, so skew is
    small, and a point landing in the wrong bucket costs at most one fix — but
    it is why a segment that ends up too small to judge is dropped below rather
    than reported as an unknown.
    """
    segments = [s for s in (route_history or []) if isinstance(s, dict)]
    if len(segments) < 2:
        return {}

    starts = [_parse_iso(s.get("started_at")) for s in segments]
    if any(t is None for t in starts):
        return {}

    buckets: list[list[tuple[float, float]]] = [[] for _ in segments]
    for point in trace_points:
        if not isinstance(point, dict) or "lon" not in point or "lat" not in point:
            continue
        at = _parse_iso(point.get("timestamp"))
        # The last segment that had already started. Anything stamped before the
        # first one (or with no usable stamp) belongs to the original route.
        index = 0
        if at is not None:
            for i, start in enumerate(starts):
                if at >= start:
                    index = i
        buckets[index].append((point["lon"], point["lat"]))

    scored: list[tuple[int, dict]] = []
    for segment, points in zip(segments, buckets):
        result = compute_route_adherence(
            _coords_from_shapes(segment.get("shapes")), points, deviation_threshold_meters
        )
        # Too few points to judge — a segment the driver left within a second, or
        # one whose geometry didn't survive. Dropped rather than folded in at a
        # neutral 0.5, which would drag a real score toward the middle.
        if result.get("adherence_rate") is not None:
            scored.append((len(points), result))

    if not scored:
        return {}

    total = sum(n for n, _ in scored)
    return {
        "adherence_rate": sum(n * r["adherence_rate"] for n, r in scored) / total,
        "deviation_count": sum(r["deviation_count"] for _, r in scored),
        "max_deviation_meters": max(r["max_deviation_meters"] for _, r in scored),
        "mean_deviation_meters": sum(n * r["mean_deviation_meters"] for n, r in scored) / total,
        "reroute_count": len(segments) - 1,
        "segment_count": len(segments),
        "scored_segments": len(scored),
    }


def compute_implicit_reward(
    route_adherence: dict,
    time_delta_minutes: float,
    app_switch_count: int,
    trip_completed: bool,
) -> float:
    """Scalar reward in [-1, 1] from behavioral signals alone (roadmap formula)."""
    if not trip_completed:
        return -0.5  # abandoned — penalize the route

    reward = 0.0
    adherence = route_adherence.get("adherence_rate")
    if adherence is None:
        adherence = 0.5  # unknown — neutral
    reward += (adherence - 0.5) * 1.2                       # following is the strongest signal
    reward += float(np.clip(-time_delta_minutes / 10.0, -0.3, 0.3))  # early = good
    reward -= min(app_switch_count * 0.1, 0.3)              # switching away = frustration
    # Every reroute is a route we suggested that the driver did not take — the
    # clearest behavioral evidence a drive produces short of the debrief, and one
    # that segmented adherence deliberately hides (each piece scores well on its
    # own). Capped, because three wrong turns on an unfamiliar drive is not three
    # times the indictment of the route. Absent from every trip recorded before
    # rerouting existed, so this is a no-op on the existing corpus.
    reward -= float(np.clip(0.12 * (route_adherence.get("reroute_count") or 0), 0, 0.3))
    return float(np.clip(reward, -1.0, 1.0))


def _valhalla_eta_minutes(suggested_route: dict) -> float | None:
    try:
        return float(suggested_route["trip"]["summary"]["time"]) / 60.0
    except (KeyError, TypeError, ValueError):
        return None


def ensure_implicit_signals(trip) -> dict | None:
    """The trip's implicit-signal block, computing it if it isn't there yet.

    Completion can win a race against the drive's final GPS flush: the client
    marks the trip done while the tail batch is still in flight, so
    compute_implicit_signals() sees a trace too short to judge and returns {}.
    The trace is whole moments later, but nothing ever looked again — every
    trip in the database carried a null adherence as a result.

    So every later touch point (a retried complete, the post-trip debrief)
    calls this instead of reading the stored block directly. Already computed
    -> returned as-is; missing -> computed now, against the full trace.
    Returns None when there is still nothing usable to compute from.
    """
    stored = (trip.implicit_signals or {}).get("implicit")
    if stored:
        return stored
    return compute_implicit_signals(trip) or None


def compute_implicit_signals(trip) -> dict:
    """Full implicit-signal dict for a completed Trip, or {} when there's no
    usable GPS trace (caller then keeps the neutral default).

    Reads trip.suggested_route, trip.actual_path_taken, trip.started_at /
    completed_at, and trip.implicit_signals.client_summary.duration_minutes.
    """
    trace_raw = trip.actual_path_taken or []
    trace = [(p["lon"], p["lat"]) for p in trace_raw if "lon" in p and "lat" in p]
    if len(trace) < 2:
        return {}

    # A drive that rerouted has to be scored piece by piece against the route
    # that was live for each piece; compute_segmented_adherence returns {} when
    # there was only ever one route, so the ordinary path below is unchanged for
    # every trip that didn't reroute.
    adherence = compute_segmented_adherence(
        (trip.context or {}).get("route_history"), trace_raw
    ) or compute_route_adherence(
        route_coords_from_suggested(trip.suggested_route or {}), trace
    )

    # Actual duration: client-reported if present, else wall-clock; ETA from
    # Valhalla. time_delta 0 when neither side is known (neutral).
    client_summary = (trip.implicit_signals or {}).get("client_summary") or {}
    actual_minutes = client_summary.get("duration_minutes")
    # Wall-clock fallback only when both timestamps are real datetimes — during
    # the completion request itself completed_at is still an unflushed SQL
    # func.now() clause, so we lean on the client-reported duration there.
    if (
        actual_minutes is None
        and isinstance(trip.completed_at, datetime)
        and isinstance(trip.started_at, datetime)
    ):
        actual_minutes = (trip.completed_at - trip.started_at).total_seconds() / 60.0
    eta_minutes = _valhalla_eta_minutes(trip.suggested_route or {})
    time_delta_minutes = (
        float(actual_minutes) - eta_minutes
        if actual_minutes is not None and eta_minutes is not None
        else 0.0
    )

    app_switch_count = 0  # no data source yet — see module docstring
    implicit_reward = compute_implicit_reward(
        adherence, time_delta_minutes, app_switch_count, trip_completed=True
    )

    return {
        **adherence,
        "time_delta_minutes": time_delta_minutes,
        "app_switch_count": app_switch_count,
        "implicit_reward": implicit_reward,
    }
