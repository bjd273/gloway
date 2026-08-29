"""Build a pool of genuinely different routes for the ranker to choose from.

One Valhalla call is not enough. Measured on a north-south Arlington pair it
returns three routes — 13.14, 13.16 and 19.44 mi — where the first two are the
same road with a trivial variation. Asking for six alternates still returns
three. Since ranking can only pick from what generation produced, the whole
personalization stack was choosing between two identical routes and one bad
one; the first real drive went 460 m off-route precisely because the rider's
preferred route was never a candidate.

So: run several deliberately different costing strategies concurrently, pool
everything they return (each call carries its own alternates), drop the
duplicates, and hand what survives to RouteRanker.

Every strategy below was verified against the live engine to actually change a
route. Deliberately absent, because probing showed they do nothing on this
extract: `use_living_streets` (which is why the existing prefer_scenic is a
no-op), `use_hills`/`avoid_bad_surfaces` (flat, paved), `use_ferry`,
`use_tracks`, `alley_factor`, `service_factor`, and `date_time` — time-of-day
routing is accepted but inert without traffic data in the tiles, so rush-hour
avoidance is not available today.
"""
from __future__ import annotations

import asyncio
import logging
import math
from dataclasses import dataclass, field

from routing.lane_guidance import merge_lane_guidance
from services.signal_processor import compute_route_adherence, decode_polyline

logger = logging.getLogger(__name__)

# Two routes whose points sit this closely on top of each other are the same
# road wearing a different label. Compared symmetrically (see _overlap).
_DUPLICATE_OVERLAP = 0.8

# Below this straight-line distance the sweep is pointless: on a 1.7 mi local
# pair, no probed knob changed the route at all — there is genuinely one way to
# go, and the extra calls would only rediscover it.
_MIN_SWEEP_MILES = 2.0

_MAX_CANDIDATES = 6
_SAMPLE_POINTS = 40  # points sampled per route when comparing geometry


@dataclass(frozen=True)
class Strategy:
    """One way of asking Valhalla for a route.

    `costing_options` are merged over whatever the user's preferences already
    produced, so a strategy expresses "and also lean this way" rather than
    discarding the user's settings.
    """

    key: str
    label: str                       # shown to the user, so keep it plain
    costing_options: dict = field(default_factory=dict)


# The baseline must stay first: dedupe keeps the first occurrence, so Valhalla's
# own preferred route survives and stays index 0 for callers that ignore ranking.
_BASELINE = Strategy("fastest", "Fastest", {})

_STRATEGIES: dict[str, tuple[Strategy, ...]] = {
    "auto": (
        _BASELINE,
        # 29.4 mi/29.6 min -> 28.7 mi/38.8 min when probed: a real trade, not a tweak.
        Strategy("avoid_highways", "No highways", {"use_highways": 0.0}),
        # 29.4 -> 36.0 mi. Longer, but far less navigating — worth offering to
        # anyone driving somewhere unfamiliar.
        Strategy("fewest_turns", "Fewest turns", {"maneuver_penalty": 300.0}),
        # Distance-optimised, and reliably slower. For fuel and EV range, not haste.
        Strategy("shortest_distance", "Shortest way", {"shortest": True}),
        # Caps speed, which steers off fast arterials onto calmer roads.
        Strategy("relaxed", "Calmer roads", {"top_speed": 45}),
        Strategy("avoid_tolls", "No tolls", {"use_tolls": 0.0}),
    ),
    "bicycle": (
        _BASELINE,
        # The "safer for biking" knob: 13.9 -> 14.5 mi, detouring off roads
        # shared with traffic.
        Strategy("quiet", "Quieter streets", {"use_roads": 0.1}),
        Strategy("shortest_distance", "Shortest way", {"shortest": True}),
    ),
    "pedestrian": (
        _BASELINE,
        # 1.88 -> 2.39 mi to stay on lit streets. Genuine night-safety routing.
        Strategy("well_lit", "Well-lit", {"use_lit": 1.0}),
        Strategy("fewer_steps", "Fewer steps", {"step_penalty": 600.0}),
    ),
}


@dataclass
class Candidate:
    """A route plus the strategy that produced it."""

    trip: dict
    strategy: str
    label: str
    # True for the route a strategy actually optimised for; False for the
    # alternates Valhalla threw in alongside it. Those alternates are useful
    # variety but they are NOT what the strategy asked for, so they must not
    # inherit its label — an alternate from the "fastest" call is not the
    # fastest route, it is just another way round.
    is_primary: bool = True


def _trip_coords(trip: dict) -> list[tuple[float, float]]:
    """Decode a trip's full geometry to (lon, lat).

    Note this takes a *trip* (legs at the top level), not the whole Valhalla
    response — that is what route_coords_from_suggested handles, and the two
    shapes are easy to confuse.
    """
    coords: list[tuple[float, float]] = []
    for leg in trip.get("legs") or []:
        shape = leg.get("shape") if isinstance(leg, dict) else None
        if isinstance(shape, str) and shape:
            coords.extend(decode_polyline(shape))
    return coords


def _sample(coords: list[tuple[float, float]], n: int = _SAMPLE_POINTS):
    if len(coords) <= n:
        return coords
    step = max(1, len(coords) // n)
    return coords[::step]


def _overlap(a: list[tuple[float, float]], b: list[tuple[float, float]]) -> float:
    """How much two routes coincide, 0..1.

    Reuses compute_route_adherence, which already answers "what fraction of
    these points lie within 50 m of that line" — exactly the question, with no
    new geometry code.

    Symmetric (the smaller of both directions) on purpose: a short route lying
    entirely along a longer one scores 1.0 in one direction but is not the same
    route, and keeping an extra candidate is cheaper than discarding a real
    alternative.
    """
    if len(a) < 2 or len(b) < 2:
        return 0.0
    ab = compute_route_adherence(a, _sample(b)).get("adherence_rate")
    ba = compute_route_adherence(b, _sample(a)).get("adherence_rate")
    if ab is None or ba is None:
        return 0.0
    return min(ab, ba)


def _straight_line_miles(origin: tuple[float, float], destination: tuple[float, float]) -> float:
    lat1, lon1 = origin
    lat2, lon2 = destination
    k = math.cos(math.radians((lat1 + lat2) / 2))
    dx = (lon2 - lon1) * 69.17 * k       # miles per degree longitude at this latitude
    dy = (lat2 - lat1) * 69.05
    return math.hypot(dx, dy)


def strategies_for(mode: str) -> tuple[Strategy, ...]:
    return _STRATEGIES.get(mode, _STRATEGIES["auto"])


def strategy_by_key(mode: str, key: str | None) -> Strategy | None:
    """Look one strategy up by its machine key, or None if there is no such key.

    The key is what the client got back in `route_strategies` and hands back on a
    reroute, so an unknown one means a stale client or a renamed strategy — the
    caller falls back to the baseline rather than failing the request.
    """
    if key is None:
        return None
    return next((s for s in strategies_for(mode) if s.key == key), None)


def dedupe(candidates: list[Candidate], max_candidates: int = _MAX_CANDIDATES) -> list[Candidate]:
    """Keep the first of each group of near-identical routes, capped."""
    kept: list[Candidate] = []
    kept_coords: list[list[tuple[float, float]]] = []
    for cand in candidates:
        coords = _trip_coords(cand.trip)
        if len(coords) < 2:
            continue
        if any(_overlap(seen, coords) >= _DUPLICATE_OVERLAP for seen in kept_coords):
            continue
        kept.append(cand)
        kept_coords.append(coords)
        if len(kept) >= max_candidates:
            break
    return kept


async def generate_candidates(
    router,
    origin: tuple[float, float],
    destination: tuple[float, float],
    prefs=None,
    mode: str = "auto",
    waypoints: list[tuple[float, float]] | None = None,
    max_candidates: int = _MAX_CANDIDATES,
    only_strategy: str | None = None,
    alternatives: int = 3,
) -> list[Candidate]:
    """Sweep strategies concurrently, pool the routes, drop duplicates.

    Always returns at least the baseline route when Valhalla is reachable; the
    caller's request must never fail because one exploratory strategy did.

    `only_strategy` runs exactly one strategy instead of the sweep. That is what
    a mid-drive reroute asks for, and it is two different wins at once: the
    driver who chose "Calmer roads" stays on calmer roads instead of being
    quietly returned to the fastest way at the first wrong turn, and the request
    is one Valhalla call pair rather than six — which matters a great deal when
    the answer is wanted while the car is moving.

    The `_MIN_SWEEP_MILES` guard does not apply to it: that guard exists to skip
    five pointless extra calls on a short trip, and with one strategy there are
    no extra calls to skip.
    """
    forced = strategy_by_key(mode, only_strategy)
    if only_strategy is not None:
        # An unrecognised key falls back to the baseline rather than 400ing: a
        # reroute failing outright leaves a moving car with stale guidance,
        # which is far worse than routing it the ordinary way.
        strategies = (forced or _BASELINE,)
    elif _straight_line_miles(origin, destination) >= _MIN_SWEEP_MILES:
        strategies = strategies_for(mode)
    else:
        strategies = (_BASELINE,)

    async def run(strategy: Strategy):
        request = dict(
            origin=origin,
            destination=destination,
            waypoints=waypoints,
            prefs=prefs,
            alternatives=alternatives,   # each strategy contributes its own alternates
            costing=mode,
            costing_overrides=strategy.costing_options or None,
        )
        # The same route asked for twice, concurrently: once natively (the
        # response we return and persist) and once in OSRM shape purely to
        # harvest turn lanes, which 3.5.1 emits in no other format. See
        # routing/lane_guidance.py for why this is a graft and not a migration.
        native, osrm = await asyncio.gather(
            router.get_route(**request),
            router.get_route(**request, response_format="osrm"),
            # Lane guidance is a nicety; the route is not. A failed or slow
            # OSRM call must cost the strip, never the trip.
            return_exceptions=True,
        )
        if isinstance(native, BaseException):
            raise native
        if isinstance(osrm, BaseException):
            logger.warning("Lane guidance unavailable for %r: %s", strategy.key, osrm)
        else:
            merge_lane_guidance(native, osrm)
        return native

    # return_exceptions: an exploratory strategy that errors (or a costing
    # option this Valhalla build rejects) must not take the whole request down.
    results = await asyncio.gather(*(run(s) for s in strategies), return_exceptions=True)

    primaries: list[Candidate] = []
    extras: list[Candidate] = []
    for strategy, result in zip(strategies, results):
        if isinstance(result, BaseException):
            logger.warning("Route strategy %r failed: %s", strategy.key, result)
            continue
        primary = result.get("trip")
        if primary:
            primaries.append(
                Candidate(trip=primary, strategy=strategy.key, label=strategy.label)
            )
        for alt in result.get("alternates") or []:
            trip = alt.get("trip")
            if trip:
                extras.append(
                    Candidate(
                        trip=trip,
                        strategy=strategy.key,
                        label="Another way",
                        is_primary=False,
                    )
                )

    if not primaries and not extras:
        # Everything failed, which usually means the request itself was bad
        # (a point outside the tiled region returns 400 for every strategy).
        # Re-raise the original so the endpoint's existing handlers can turn it
        # into the specific message Valhalla gave, rather than a generic 500.
        first_error = next((r for r in results if isinstance(r, BaseException)), None)
        if first_error is not None:
            raise first_error
        raise RuntimeError("no routes returned by any strategy")

    # Every strategy's own route gets considered before any strategy's
    # leftovers. Ordering by strategy first is what makes the pool diverse:
    # ranked purely by arrival order, the baseline's alternates filled the cap
    # and "no highways", "calmer roads" and "no tolls" were never even looked at.
    return dedupe(primaries + extras, max_candidates)
