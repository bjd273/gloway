"""Routing endpoints: route calculation + geocoding search.

Route requests flow user preferences into Valhalla via UserRoutingPrefs (the
RL injection seam) and persist every request as a `trips` row — that record
is the raw material for the Phase 2/3 signal collection and RL training, so
it exists from day one even though nothing consumes it yet.

Geocoding goes through the MapDataSource interface, never a provider URL —
see the Map Data Abstraction Layer section of the roadmap for the rule.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from geoalchemy2.elements import WKTElement
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.models import Trip, UserPreference
from db.session import get_db
from routing.candidate_generator import generate_candidates
from routing.route_ranker import RouteRanker
from routing.valhalla_client import UserRoutingPrefs, ValhallaRouter

router = APIRouter()


class RouteRequest(BaseModel):
    origin_lat: float
    origin_lon: float
    dest_lat: float
    dest_lon: float
    user_id: str | None = None
    declared_intent: str | None = None   # "hurry", "explore", "commute"
    waypoints: list[dict] = Field(default_factory=list)
    mode: Literal["auto", "bicycle", "pedestrian"] = "auto"
    # Human labels for the endpoints — stored in trips.context so the
    # conversation layer can say "to Globe Life Field" instead of coordinates.
    origin_label: str | None = None
    dest_label: str | None = None
    # Ask for one costing strategy by key ("avoid_highways", "relaxed", ...)
    # instead of the whole sweep. A reroute passes back the strategy behind the
    # route the driver already picked, so missing a turn doesn't silently move
    # someone off "Calmer roads" and onto the fastest way.
    strategy: str | None = None
    # Which candidate the driver was actually following, indexed into the
    # `routes` array of the response being replaced. Selection happens purely
    # client-side, so without this the server believes the drive followed
    # whichever route it recommended — and the segment of `route_history` that
    # just ended would carry the wrong geometry to score the trace against.
    selected_index: int | None = None
    # Reroute an existing trip rather than starting a new one. That trip is
    # updated in place and its id comes back unchanged, which is what keeps one
    # drive as one GPS trace, one completion and one debrief.
    reroute_of_trip_id: str | None = None


class RouteResponse(BaseModel):
    trip_id: str
    routes: list[dict]                    # Distinct candidates, recommended one indexed below
    recommended_index: int                # Which one we suggest (RL picks this later)
    estimated_minutes: float
    context_summary: str
    # Plain-language name for each candidate ("Fewest turns", "No highways"),
    # parallel to `routes`. Note these are NOT unique: every Valhalla alternate
    # is labelled "Another way", so clients must key on index, not label.
    route_labels: list[str] = Field(default_factory=list)
    # Machine key for each candidate ("avoid_highways", "fewest_turns"), also
    # parallel to `routes`. Same values already recorded in
    # trips.context["route_strategies"]. The frontend picks its per-route
    # "why" line off this rather than string-matching route_labels, which are
    # display copy and expected to get reworded.
    route_strategies: list[str] = Field(default_factory=list)
    # Whether each candidate is the route its strategy actually optimised for,
    # parallel to `routes`. False means it is one of the alternates Valhalla
    # returned alongside that strategy's own route — useful variety, but not
    # what the strategy asked for, so its label carries no information (they are
    # all "Another way"). The frontend keys off this to decide whether to show
    # the strategy's name or to name the route by the road it mostly runs on.
    route_primary: list[bool] = Field(default_factory=list)


def _get_router(request: Request) -> ValhallaRouter:
    # Created once in the app lifespan (api/main.py) so connections pool.
    return request.app.state.valhalla_router


def _get_ranker(request: Request) -> RouteRanker:
    # Also built once in the lifespan (loads the scorer from disk at most once).
    # Tests that construct routes without the lifespan get a fallback ranker.
    return getattr(request.app.state, "route_ranker", None) or RouteRanker(None)


async def _load_prefs(
    db: AsyncSession, user_id: str | None, declared_intent: str | None
) -> UserRoutingPrefs:
    prefs = UserRoutingPrefs()
    if user_id is not None:
        try:
            uid = uuid.UUID(user_id)
        except ValueError:
            raise HTTPException(status_code=422, detail="user_id must be a UUID")
        row = await db.scalar(select(UserPreference).where(UserPreference.user_id == uid))
        if row is not None:
            prefs = UserRoutingPrefs(
                avoid_highways=1.0 if row.avoid_highways else 0.0,
                avoid_tolls=1.0 if row.avoid_tolls else 0.0,
                prefer_scenic=1.0 if row.prefer_scenic else 0.0,
                avoid_left_turns=1.0 if row.avoid_left_turns else 0.0,
            )
    if declared_intent == "hurry":
        prefs.urgency = 1.0
    elif declared_intent == "explore":
        prefs.urgency = 0.2
    return prefs


def _leg_shapes(trip: dict) -> list[str]:
    """The encoded polyline of every leg, in order.

    Geometry only, deliberately. This is what `route_history` keeps for the
    segments of a drive that have already ended, and the only thing that reads it
    is per-segment adherence scoring — which needs the line and nothing else.
    Keeping the whole Valhalla trip per reroute would multiply the row size by
    the number of wrong turns for data nobody asks for; the CURRENT route is
    still stored in full under `suggested_route`.
    """
    return [
        leg["shape"]
        for leg in (trip.get("legs") or [])
        if isinstance(leg, dict) and isinstance(leg.get("shape"), str) and leg["shape"]
    ]


def _candidate_trip(stored_route: dict, recommended: int, index: int) -> dict | None:
    """The candidate at `index` of the response `stored_route` came from.

    Recovered from what is already persisted rather than kept a second time:
    `stored_route` holds the recommended trip plus every alternate, and the
    alternates sit in ascending original-index order with the recommended one
    skipped — see how `stored_route` is built below. Duplicating the geometry
    into its own context key would be simpler to read and several tens of
    kilobytes per trip heavier for no new information.
    """
    if not isinstance(stored_route, dict):
        return None
    if index == recommended:
        trip = stored_route.get("trip")
        return trip if isinstance(trip, dict) else None
    alternates = stored_route.get("alternates") or []
    position = index if index < recommended else index - 1
    if not 0 <= position < len(alternates):
        return None
    entry = alternates[position]
    trip = entry.get("trip") if isinstance(entry, dict) else None
    return trip if isinstance(trip, dict) else None


async def _load_reroute_target(db: AsyncSession, trip_id: str, user_id: str | None) -> Trip:
    """The trip a reroute is updating, or a 4xx explaining why it can't be."""
    try:
        tid = uuid.UUID(trip_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="reroute_of_trip_id must be a UUID")
    trip = await db.get(Trip, tid)
    if trip is None:
        raise HTTPException(status_code=404, detail="trip not found")
    if trip.completed_at is not None:
        # The reward for this trip has already been scored. Reopening it would
        # rewrite history behind the learning pipeline's back.
        raise HTTPException(status_code=422, detail="trip already completed")
    if trip.user_id is not None and user_id is not None and str(trip.user_id) != user_id:
        raise HTTPException(status_code=403, detail="trip belongs to another user")
    return trip


@router.post("/route", response_model=RouteResponse)
async def get_route(
    request: RouteRequest,
    db: AsyncSession = Depends(get_db),
    router_client: ValhallaRouter = Depends(_get_router),
    ranker: RouteRanker = Depends(_get_ranker),
):
    prefs = await _load_prefs(db, request.user_id, request.declared_intent)

    # Resolve the target trip BEFORE spending a Valhalla call on a reroute that
    # can't be applied (already completed, gone, someone else's).
    target = (
        await _load_reroute_target(db, request.reroute_of_trip_id, request.user_id)
        if request.reroute_of_trip_id is not None
        else None
    )

    # With an explicit strategy there is exactly one route worth returning: the
    # one the driver already chose the shape of. Asking for alternates would buy
    # variety nobody is going to be offered mid-drive, at the cost of latency
    # and a round of O(n^2) shapely de-duplication.
    single = request.strategy is not None

    try:
        # A sweep of deliberately different costing strategies, not one call.
        # Valhalla's own alternates are near-duplicates (measured: 13.14, 13.16
        # and 19.44 mi for one pair), which left the ranker nothing real to
        # choose between — see routing/candidate_generator.py.
        candidates = await generate_candidates(
            router_client,
            origin=(request.origin_lat, request.origin_lon),
            destination=(request.dest_lat, request.dest_lon),
            prefs=prefs,
            mode=request.mode,
            waypoints=[(wp["lat"], wp["lon"]) for wp in request.waypoints] or None,
            only_strategy=request.strategy,
            alternatives=0 if single else 3,
            max_candidates=1 if single else 6,
        )
    except httpx.HTTPStatusError as exc:
        # Valhalla returns 400 with a JSON error for unroutable points (e.g.
        # outside the tiled region) — surface that instead of a blind 500.
        detail = exc.response.json().get("error", "routing failed")
        raise HTTPException(status_code=exc.response.status_code, detail=detail)
    except httpx.HTTPError:
        raise HTTPException(status_code=503, detail="routing engine unreachable")

    routes = [c.trip for c in candidates]

    # Which candidate to recommend. With no trained scorer this returns 0
    # (Valhalla's own primary), so the endpoint behaves exactly as before until
    # scripts/train_route_scorer.py has enough labelled trips. The candidate
    # list is never reordered — see RankedRoutes' docstring.
    route_context = {"declared_intent": request.declared_intent, "mode": request.mode}
    ranked = ranker.rank(routes, prefs, route_context)

    # Store the response with the RECOMMENDED route as `trip`, not whichever
    # candidate happened to come back first. Everything downstream that scores
    # the trip — compute_implicit_signals via route_coords_from_suggested, and
    # the scorer's training features — reads `suggested_route["trip"]`, so if
    # that isn't the route the user was actually shown, adherence gets measured
    # against a route they never saw. Harmless while the ranker always returned
    # 0; a real bug the moment it starts choosing.
    recommended_trip = routes[ranked.recommended_index]
    stored_route = {
        "trip": recommended_trip,
        "alternates": [
            {"trip": t} for i, t in enumerate(routes) if i != ranked.recommended_index
        ],
    }

    # What the driver is following from this moment on, and from where. Appended
    # rather than overwritten so a drive with reroutes can still be scored: the
    # trace before a reroute has to be measured against the route that was
    # active then, not against the one that replaced it. Without this, missing
    # one turn makes the whole first half of a drive read as off-route against a
    # line the driver was never shown.
    segment = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "from": {"lat": request.origin_lat, "lon": request.origin_lon},
        "strategy": candidates[ranked.recommended_index].strategy,
        "shapes": _leg_shapes(recommended_trip),
    }

    shared_context = {
        "declared_intent": request.declared_intent,
        "waypoints": request.waypoints,
        "mode": request.mode,
        # Recorded so training can reconstruct which route we actually put
        # in front of the user — `suggested_route` keeps every candidate,
        # and this says which one was recommended out of them.
        "recommended_index": ranked.recommended_index,
        "route_scores": ranked.scores,
        "personalization_active": ranked.personalization_active,
        # Which strategy produced each candidate, and which one won. This is
        # the label the scorer can eventually learn on ("this user keeps
        # picking fewest_turns").
        "route_strategies": [c.strategy for c in candidates],
        "recommended_strategy": candidates[ranked.recommended_index].strategy,
    }

    if target is not None:
        # A reroute UPDATES the trip rather than starting a new one. The drive
        # did not restart just because the route changed: the GPS trace is
        # continuous, there is one arrival and one debrief, and splitting it into
        # several rows would fragment all three. `origin` and `destination` stay
        # put — the trip still began where it began and still ends where it ends;
        # only the line between them moved.
        context = dict(target.context or {})
        history = [*(context.get("route_history") or [])]

        # Correct the segment that just ended before appending the new one.
        # Route selection never reaches the server — `selectRoute` is client
        # state — so the segment was written with whatever we recommended. If
        # the driver picked a different way, the trace it is about to be scored
        # against is a route they never drove. Read from the OLD context and the
        # OLD suggested_route, both of which are overwritten a few lines down.
        if history and request.selected_index is not None:
            chosen = _candidate_trip(
                target.suggested_route or {},
                int(context.get("recommended_index") or 0),
                request.selected_index,
            )
            if chosen is not None:
                history[-1]["shapes"] = _leg_shapes(chosen)
                strategies = context.get("route_strategies") or []
                if 0 <= request.selected_index < len(strategies):
                    history[-1]["strategy"] = strategies[request.selected_index]

        context.update(shared_context)
        context["route_history"] = [*history, segment]
        context["reroute_count"] = int(context.get("reroute_count") or 0) + 1
        target.context = context
        target.suggested_route = stored_route
        trip = target
    else:
        trip = Trip(
            user_id=uuid.UUID(request.user_id) if request.user_id else None,
            origin=WKTElement(f"POINT({request.origin_lon} {request.origin_lat})", srid=4326),
            destination=WKTElement(f"POINT({request.dest_lon} {request.dest_lat})", srid=4326),
            suggested_route=stored_route,
            context={
                **shared_context,
                "origin_label": request.origin_label,
                "dest_label": request.dest_label,
                # Entry zero, so the history is complete from the first route
                # rather than only from the first reroute.
                "route_history": [segment],
                "reroute_count": 0,
            },
        )
        db.add(trip)
    await db.commit()

    recommended = routes[ranked.recommended_index]
    return RouteResponse(
        trip_id=str(trip.id),
        routes=routes,
        route_labels=[c.label for c in candidates],
        route_strategies=[c.strategy for c in candidates],
        route_primary=[c.is_primary for c in candidates],
        recommended_index=ranked.recommended_index,
        estimated_minutes=recommended["summary"]["time"] / 60,
        context_summary="Route calculated based on your preferences.",
    )


@router.get("/search")
async def search_place(q: str, request: Request, limit: int = Query(10, ge=1, le=25)):
    # get_map_data_source() constructs per call today (cheap: one httpx client);
    # a shared instance can move to app.state alongside the Valhalla router if
    # profiling ever says so.
    from mapdata.factory import get_map_data_source

    source = get_map_data_source()
    try:
        results = await source.search_addresses(q, limit=limit)
    finally:
        if hasattr(source, "aclose"):
            await source.aclose()
    return {
        "results": [
            {"lat": r.lat, "lon": r.lon, "display_name": r.formatted} for r in results
        ]
    }
