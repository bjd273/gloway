"""Graft turn-lane guidance from an OSRM-shaped response onto native maneuvers.

Valhalla 3.5.1 will tell you which lane to be in, but only in one dialect.
Ask for a route in the native format and every maneuver comes back rich —
`type`, `begin_shape_index`, the `verbal_*` strings — and completely silent
about lanes. Ask for the same route with `format: "osrm"` and the lanes are
right there on the intersections. The `turn_lanes` request flag the API
reference describes does nothing in this build, in either position; probing the
live engine on an Arlington route returned zero `lanes` keys natively and 86
lane-bearing intersections under OSRM, from the same tiles.

Switching the app to OSRM wholesale is not on the table. `trips.suggested_route`
stores the native response, and services/signal_processor.py and
scripts/train_route_scorer.py read `["trip"]["legs"][*]["shape"]` back out of it
to score every drive — the reward pipeline, and every row already written.

So we ask twice, concurrently, and copy just the lanes across.

## Which intersection holds a maneuver's lanes

`steps[N].intersections[0].lanes` — the FIRST intersection of step N, not the
last. Verified on two consecutive turns: step 2 ("turn left onto West Pioneer
Pkwy") has `left` valid+active on its first intersection, while its LAST
intersection reads `right` valid+active — which belongs to step 3's turn, one
maneuver later. Taking the last would show every driver the lane for the turn
after the one they are making.

## Why pairing by index is safe here, and checked anyway

Both responses come from the same engine, the same tiles and the same request
body, so the routes are the same routes in the same order. Measured: native
primary 755.8s/10 maneuvers, alt0 640.5s/11, alt1 864.9s/12 against OSRM
route0 755.8s/10 steps, route1 640.5s/11, route2 864.9s/12 — exact.

That is an observation about today's engine, not a guarantee, and a silent
mis-pair would paint confident arrows pointing at the wrong lane. So every pair
is checked on duration and per-leg maneuver count before anything is copied,
and a mismatch drops lane data for that route rather than guessing. No lanes is
a fine outcome; wrong lanes is not.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# Durations are echoed by both formats from the same computation, so they should
# be bit-identical. A hair of tolerance costs nothing and avoids a float-compare
# tripping over a serialisation round-trip.
_DURATION_TOLERANCE_S = 0.5


def _native_trips(native: dict) -> list[dict]:
    """The primary trip then its alternates, in response order."""
    trips: list[dict] = []
    primary = native.get("trip")
    if isinstance(primary, dict):
        trips.append(primary)
    for alt in native.get("alternates") or []:
        trip = alt.get("trip") if isinstance(alt, dict) else None
        if isinstance(trip, dict):
            trips.append(trip)
    return trips


def _pair_matches(trip: dict, route: dict) -> bool:
    """Is this OSRM route the same route as this native trip?

    Duration first (cheap, and the strongest single signal), then the per-leg
    maneuver/step counts — which is the property the copy below actually
    depends on, so checking it here is what makes the zip below safe.
    """
    summary = trip.get("summary") or {}
    trip_time, route_time = summary.get("time"), route.get("duration")
    if not isinstance(trip_time, (int, float)) or not isinstance(route_time, (int, float)):
        return False
    if abs(trip_time - route_time) > _DURATION_TOLERANCE_S:
        return False

    legs, route_legs = trip.get("legs") or [], route.get("legs") or []
    if len(legs) != len(route_legs) or not legs:
        return False
    for leg, route_leg in zip(legs, route_legs):
        maneuvers = leg.get("maneuvers") or []
        steps = route_leg.get("steps") or []
        if len(maneuvers) != len(steps):
            return False
    return True


def _lanes_for_step(step: dict) -> list | None:
    intersections = step.get("intersections") or []
    if not intersections:
        return None
    lanes = intersections[0].get("lanes")
    # An empty list means "we looked and there are none" — same as absent, and
    # not worth a key on the maneuver that the client would have to special-case.
    return lanes if isinstance(lanes, list) and lanes else None


def merge_lane_guidance(native: dict, osrm: dict) -> int:
    """Copy lane guidance from `osrm` onto `native`'s maneuvers, in place.

    Returns the number of maneuvers that gained a `lanes` key, so callers can
    log the difference between "the merge ran and this road has no turn:lanes"
    and "the merge never ran". Both are normal; only the second is a bug.

    Never raises on a shape it does not recognise. This runs inside the routing
    hot path and lane guidance is a nicety — a malformed OSRM response must
    cost the user a lane strip, not their route.
    """
    if not isinstance(native, dict) or not isinstance(osrm, dict):
        return 0

    trips = _native_trips(native)
    routes = [r for r in (osrm.get("routes") or []) if isinstance(r, dict)]
    merged = 0

    for trip, route in zip(trips, routes):
        if not _pair_matches(trip, route):
            logger.debug("Lane merge skipped: OSRM route does not match native trip")
            continue
        for leg, route_leg in zip(trip.get("legs") or [], route.get("legs") or []):
            for maneuver, step in zip(leg.get("maneuvers") or [], route_leg.get("steps") or []):
                if not isinstance(maneuver, dict) or not isinstance(step, dict):
                    continue
                lanes = _lanes_for_step(step)
                if lanes is not None:
                    maneuver["lanes"] = lanes
                    merged += 1
    return merged
