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
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from geoalchemy2.elements import WKTElement
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.models import Trip, UserPreference
from db.session import get_db
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


class RouteResponse(BaseModel):
    trip_id: str
    routes: list[dict]                    # Primary route first, then alternates
    recommended_index: int                # Which one we suggest (RL picks this later)
    estimated_minutes: float
    context_summary: str


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


@router.post("/route", response_model=RouteResponse)
async def get_route(
    request: RouteRequest,
    db: AsyncSession = Depends(get_db),
    router_client: ValhallaRouter = Depends(_get_router),
    ranker: RouteRanker = Depends(_get_ranker),
):
    prefs = await _load_prefs(db, request.user_id, request.declared_intent)

    try:
        data = await router_client.get_route(
            origin=(request.origin_lat, request.origin_lon),
            destination=(request.dest_lat, request.dest_lon),
            waypoints=[(wp["lat"], wp["lon"]) for wp in request.waypoints] or None,
            prefs=prefs,
            costing=request.mode,
        )
    except httpx.HTTPStatusError as exc:
        # Valhalla returns 400 with a JSON error for unroutable points (e.g.
        # outside the tiled region) — surface that instead of a blind 500.
        detail = exc.response.json().get("error", "routing failed")
        raise HTTPException(status_code=exc.response.status_code, detail=detail)
    except httpx.HTTPError:
        raise HTTPException(status_code=503, detail="routing engine unreachable")

    routes = [data["trip"]] + [alt["trip"] for alt in data.get("alternates", [])]

    # Which candidate to recommend. With no trained scorer this returns 0
    # (Valhalla's own primary), so the endpoint behaves exactly as before until
    # scripts/train_route_scorer.py has enough labelled trips. The candidate
    # list is never reordered — see RankedRoutes' docstring.
    route_context = {"declared_intent": request.declared_intent, "mode": request.mode}
    ranked = ranker.rank(routes, prefs, route_context)

    trip = Trip(
        user_id=uuid.UUID(request.user_id) if request.user_id else None,
        origin=WKTElement(f"POINT({request.origin_lon} {request.origin_lat})", srid=4326),
        destination=WKTElement(f"POINT({request.dest_lon} {request.dest_lat})", srid=4326),
        suggested_route=data,
        context={
            "declared_intent": request.declared_intent,
            "origin_label": request.origin_label,
            "dest_label": request.dest_label,
            "waypoints": request.waypoints,
            "mode": request.mode,
            # Recorded so training can reconstruct which route we actually put
            # in front of the user — `suggested_route` keeps every candidate,
            # and this says which one was recommended out of them.
            "recommended_index": ranked.recommended_index,
            "route_scores": ranked.scores,
            "personalization_active": ranked.personalization_active,
        },
    )
    db.add(trip)
    await db.commit()

    recommended = routes[ranked.recommended_index]
    return RouteResponse(
        trip_id=str(trip.id),
        routes=routes,
        recommended_index=ranked.recommended_index,
        estimated_minutes=recommended["summary"]["time"] / 60,
        context_summary="Route calculated based on your preferences.",
    )


@router.get("/search")
async def search_place(q: str, request: Request):
    # get_map_data_source() constructs per call today (cheap: one httpx client);
    # a shared instance can move to app.state alongside the Valhalla router if
    # profiling ever says so.
    from mapdata.factory import get_map_data_source

    source = get_map_data_source()
    try:
        results = await source.search_addresses(q, limit=5)
    finally:
        if hasattr(source, "aclose"):
            await source.aclose()
    return {
        "results": [
            {"lat": r.lat, "lon": r.lon, "display_name": r.formatted} for r in results
        ]
    }
