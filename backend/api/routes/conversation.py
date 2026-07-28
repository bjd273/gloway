"""Pre-journey conversation endpoints (Phase 2, Week 11-12 first slice).

Flow: the frontend opens a conversation once a route is drawn -> the LLM
writes one contextual opener (persisted to trip_conversations) -> the user's
reply is parsed into a trip intent (hurry/explore, re-routes immediately via
declared_intent) and durable preference updates (persisted to
user_preferences), then acknowledged.

All LLM access goes through the ml.llm seam; LLMUnavailable maps to 503,
which the frontend reads as "conversation features off" (no error surfaced).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from geoalchemy2.shape import to_shape
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from db.models import Trip, TripConversation, UserJourneyProfile, UserPreference
from db.session import get_db
from mapdata.factory import get_map_data_source
from mapdata.models import BBox, Place, PlaceCategory
from ml.llm.base import LLMClient, LLMUnavailable
from ml.llm.conversation import (
    StopRequest,
    generate_debrief_question,
    generate_pre_journey_message,
    interpret_debrief,
    interpret_reply,
)
from ml.llm.factory import get_llm_client
from ml.rl.reward_engine import compute_final_reward
from services.signal_processor import ensure_implicit_signals

router = APIRouter()


class OpenResponse(BaseModel):
    conversation_id: str
    messages: list[dict]


class RouteOption(BaseModel):
    index: int
    minutes: float
    selected: bool = False


class ReplyRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    # Summary of what's currently drawn — the conversation anchors to the
    # session's first trip while re-routes create new trip rows, so the
    # client is the only party that knows today's options.
    route_options: list[RouteOption] | None = None


class StopOut(BaseModel):
    name: str
    lat: float
    lon: float


class ReplyResponse(BaseModel):
    message: str                      # assistant acknowledgement
    intent: str | None                # "hurry" | "explore" | None — re-route hint
    preferences: dict | None          # updated prefs when any were applied
    switch_to_route: int | None       # validated index into route_options
    stop: StopOut | None              # resolved stop to route through
    stops_cleared: bool               # user asked to drop planned stops
    set_destination: str | None       # "home" | "work" — client resolves coords
    travel_mode: str | None           # "auto" | "bicycle" | "pedestrian"


async def _llm(  # noqa: ANN201 — FastAPI dependency
) -> AsyncIterator[LLMClient]:
    try:
        client = get_llm_client()
    except LLMUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    try:
        yield client
    finally:
        await client.aclose()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _load_trip(db: AsyncSession, trip_id: str) -> Trip:
    try:
        tid = uuid.UUID(trip_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="trip_id must be a UUID")
    trip = await db.get(Trip, tid)
    if trip is None:
        raise HTTPException(status_code=404, detail="trip not found")
    return trip


async def _latest_conversation(db: AsyncSession, trip_id) -> TripConversation | None:
    return await db.scalar(
        select(TripConversation)
        .where(TripConversation.trip_id == trip_id)
        .order_by(TripConversation.created_at.desc())
        .limit(1)
    )


async def _find_stop(trip: Trip, request: StopRequest) -> Place | None:
    """Resolve a stop request to a concrete place near the trip's corridor.

    Corridor = bbox around origin/destination (+~1.5km pad); winner = the
    candidate nearest the O-D midpoint (flat lat/lon distance is fine at city
    scale). Any provider failure (public Overpass 5xx, timeout) resolves to
    None — the reply says "couldn't find a stop" instead of erroring.
    """
    origin = to_shape(trip.origin)          # shapely Point: x = lon, y = lat
    destination = to_shape(trip.destination)
    pad = 0.015
    bbox = BBox(
        min_lat=min(origin.y, destination.y) - pad,
        min_lon=min(origin.x, destination.x) - pad,
        max_lat=max(origin.y, destination.y) + pad,
        max_lon=max(origin.x, destination.x) + pad,
    )
    mid_lat = (origin.y + destination.y) / 2
    mid_lon = (origin.x + destination.x) / 2

    source = get_map_data_source()
    try:
        candidates: list[Place] = []
        if request.query:
            results = await source.search_addresses(request.query, limit=5)
            candidates = [
                Place(
                    id=a.id, name=a.formatted.split(",")[0], category=PlaceCategory.OTHER,
                    lat=a.lat, lon=a.lon, source=a.source, metadata=a.metadata,
                )
                for a in results
                if bbox.min_lat <= a.lat <= bbox.max_lat and bbox.min_lon <= a.lon <= bbox.max_lon
            ]
        elif request.category:
            candidates = [
                p for p in await source.get_places(PlaceCategory(request.category), bbox)
                if p.name  # a nameless node makes a useless "via ..." label
            ]
        if not candidates:
            return None
        return min(candidates, key=lambda p: (p.lat - mid_lat) ** 2 + (p.lon - mid_lon) ** 2)
    except Exception:
        return None
    finally:
        if hasattr(source, "aclose"):
            await source.aclose()


async def _profile_dicts(db: AsyncSession, user_id) -> tuple[dict, dict]:
    """(journey, prefs) as plain dicts for prompt building; empty for anonymous."""
    journey: dict = {}
    prefs: dict = {}
    if user_id is not None:
        j = await db.get(UserJourneyProfile, user_id)
        if j is not None:
            journey = {
                "preferred_convo_style": j.preferred_convo_style,
                "typical_use_cases": j.typical_use_cases,
                "stated_dislikes": j.stated_dislikes,
            }
        p = await db.get(UserPreference, user_id)
        if p is not None:
            prefs = {
                "avoid_highways": p.avoid_highways,
                "avoid_tolls": p.avoid_tolls,
                "avoid_left_turns": p.avoid_left_turns,
                "prefer_scenic": p.prefer_scenic,
            }
    return journey, prefs


@router.post("/{trip_id}/conversation/open", response_model=OpenResponse)
async def open_conversation(
    trip_id: str,
    db: AsyncSession = Depends(get_db),
    llm: LLMClient = Depends(_llm),
):
    trip = await _load_trip(db, trip_id)

    existing = await db.scalar(
        select(TripConversation)
        .where(TripConversation.trip_id == trip.id)
        .order_by(TripConversation.created_at.desc())
        .limit(1)
    )
    if existing is not None:
        return OpenResponse(conversation_id=str(existing.id), messages=existing.messages)

    journey, prefs = await _profile_dicts(db, trip.user_id)
    context = trip.context or {}
    trip_context = {
        "origin_label": context.get("origin_label"),
        "dest_label": context.get("dest_label"),
        "local_time": datetime.now().strftime("%A %H:%M"),
    }
    try:
        opener = await generate_pre_journey_message(llm, journey, prefs, trip_context)
    except LLMUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    convo = TripConversation(
        trip_id=trip.id,
        user_id=trip.user_id,
        messages=[{"role": "assistant", "content": opener, "timestamp": _now()}],
    )
    db.add(convo)
    await db.commit()
    await db.refresh(convo)
    return OpenResponse(conversation_id=str(convo.id), messages=convo.messages)


@router.post("/{trip_id}/conversation/reply", response_model=ReplyResponse)
async def reply_conversation(
    trip_id: str,
    request: ReplyRequest,
    db: AsyncSession = Depends(get_db),
    llm: LLMClient = Depends(_llm),
):
    trip = await _load_trip(db, trip_id)
    convo = await db.scalar(
        select(TripConversation)
        .where(TripConversation.trip_id == trip.id)
        .order_by(TripConversation.created_at.desc())
        .limit(1)
    )
    if convo is None:
        raise HTTPException(status_code=404, detail="no conversation for this trip")

    route_options = [opt.model_dump() for opt in request.route_options or []]
    try:
        result = await interpret_reply(
            llm, convo.messages, request.text, route_options=route_options or None
        )
    except LLMUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    # Validate the switch index against what the client actually has drawn.
    switch_to_route = result.switch_to_route
    if switch_to_route is not None and not any(
        opt["index"] == switch_to_route for opt in route_options
    ):
        switch_to_route = None

    stop_out: StopOut | None = None
    ack = result.assistant_reply
    if result.add_stop is not None:
        place = await _find_stop(trip, result.add_stop)
        if place is not None:
            stop_out = StopOut(name=place.name or "a stop", lat=place.lat, lon=place.lon)
            ack = f"{ack} I found {stop_out.name} on the way."
        else:
            ack = f"{ack} I couldn't find a good stop near this route, sorry."

    updated_prefs: dict | None = None
    if result.preference_updates and trip.user_id is not None:
        prefs_row = await db.get(UserPreference, trip.user_id)
        if prefs_row is not None:
            for key, value in result.preference_updates.items():
                setattr(prefs_row, key, value)
            prefs_row.updated_at = func.now()
            await db.flush()
            updated_prefs = {
                "avoid_highways": prefs_row.avoid_highways,
                "avoid_tolls": prefs_row.avoid_tolls,
                "avoid_left_turns": prefs_row.avoid_left_turns,
                "prefer_scenic": prefs_row.prefer_scenic,
            }

    convo.messages = [
        *convo.messages,
        {"role": "user", "content": request.text, "timestamp": _now()},
        {"role": "assistant", "content": ack, "timestamp": _now()},
    ]
    # Append, never overwrite: every turn's extraction is training data. In
    # particular `switch_to_route` + the options we showed is a pairwise
    # preference label, which only means something if the turn it belongs to
    # survives. Reassigned (not .append()ed) so SQLAlchemy sees the JSONB change.
    convo.preference_updates_extracted = [
        *(convo.preference_updates_extracted or []),
        {
            "intent": result.intent,
            "preference_updates": result.preference_updates,
            "confidence": result.confidence,
            "switch_to_route": switch_to_route,
            # What was on offer when they chose — without it the chosen index
            # is unresolvable later, since re-routes create new trip rows.
            "route_options": route_options,
            "stop": stop_out.model_dump() if stop_out else None,
            "remove_stops": result.remove_stops,
            "set_destination": result.set_destination,
            "travel_mode": result.travel_mode,
            "phase": "pre_journey",
            "timestamp": _now(),
        },
    ]
    await db.commit()

    return ReplyResponse(
        message=ack,
        intent=result.intent,
        preferences=updated_prefs,
        switch_to_route=switch_to_route,
        stop=stop_out,
        stops_cleared=result.remove_stops,
        set_destination=result.set_destination,
        travel_mode=result.travel_mode,
    )


# --- Post-trip debrief ---------------------------------------------------
# Turns the "Done driving?" wrap-up into a one-question LLM debrief that writes
# the reward signal (trips.reward_value) the RL layer will train on. Synchronous
# for now; the roadmap's Celery/GPS-adherence version combines an implicit
# reward later — reward_value = explicit reward_delta until then.


class DebriefOpenResponse(BaseModel):
    message: str


class DebriefReplyResponse(BaseModel):
    message: str
    reward: float
    preferences: dict | None


@router.post("/{trip_id}/debrief/open", response_model=DebriefOpenResponse)
async def open_debrief(
    trip_id: str,
    db: AsyncSession = Depends(get_db),
    llm: LLMClient = Depends(_llm),
):
    trip = await _load_trip(db, trip_id)
    journey, _ = await _profile_dicts(db, trip.user_id)
    context = trip.context or {}
    try:
        question = await generate_debrief_question(
            llm, journey, {"dest_label": context.get("dest_label")}
        )
    except LLMUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    convo = await _latest_conversation(db, trip.id)
    entry = {"role": "assistant", "content": question, "timestamp": _now(), "phase": "debrief"}
    if convo is None:
        convo = TripConversation(trip_id=trip.id, user_id=trip.user_id, messages=[entry])
        db.add(convo)
    else:
        convo.messages = [*convo.messages, entry]
    await db.commit()
    return DebriefOpenResponse(message=question)


@router.post("/{trip_id}/debrief/reply", response_model=DebriefReplyResponse)
async def reply_debrief(
    trip_id: str,
    request: ReplyRequest,
    db: AsyncSession = Depends(get_db),
    llm: LLMClient = Depends(_llm),
):
    trip = await _load_trip(db, trip_id)
    convo = await _latest_conversation(db, trip.id)
    question = ""
    if convo and convo.messages:
        question = convo.messages[-1].get("content", "")

    try:
        result = await interpret_debrief(llm, question, request.text)
    except LLMUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    # Fuse the explicit sentiment with the implicit GPS reward. Computed at
    # completion normally, but recomputed here when it's missing — completion
    # can outrun the drive's final GPS flush, and by debrief time the trace is
    # whole. No usable trace at all (debrief before/without a drive) -> fusion
    # degrades to explicit-only, i.e. the raw reward_delta.
    signals = dict(trip.implicit_signals or {})
    implicit = ensure_implicit_signals(trip)
    if implicit:
        signals["implicit"] = implicit
    # reward_confidence, not confidence: the latter scores preference_updates
    # and is 0 whenever the reply implies no durable setting, which silently
    # zero-weighted the user's own sentiment out of the fused reward.
    explicit = {
        "reward_delta": result.reward_delta,
        "confidence": result.reward_confidence,
    }
    fused = compute_final_reward(implicit, explicit)
    trip.reward_value = fused["reward"]
    signals["debrief"] = {
        "reward_delta": result.reward_delta,
        "confidence": result.confidence,                 # about preference_updates
        "reward_confidence": result.reward_confidence,   # about reward_delta
        "preference_updates": result.preference_updates,
    }
    signals["fusion"] = fused
    signals["reward_source"] = fused["source"]
    trip.implicit_signals = signals
    if trip.completed_at is None:
        trip.completed_at = func.now()

    updated_prefs: dict | None = None
    if result.preference_updates and trip.user_id is not None:
        prefs_row = await db.get(UserPreference, trip.user_id)
        if prefs_row is not None:
            for key, value in result.preference_updates.items():
                setattr(prefs_row, key, value)
            prefs_row.updated_at = func.now()
            await db.flush()
            updated_prefs = {
                "avoid_highways": prefs_row.avoid_highways,
                "avoid_tolls": prefs_row.avoid_tolls,
                "avoid_left_turns": prefs_row.avoid_left_turns,
                "prefer_scenic": prefs_row.prefer_scenic,
            }

    if convo is not None:
        convo.messages = [
            *convo.messages,
            {"role": "user", "content": request.text, "timestamp": _now(), "phase": "debrief"},
            {"role": "assistant", "content": result.assistant_reply, "timestamp": _now(),
             "phase": "debrief"},
        ]
    await db.commit()

    return DebriefReplyResponse(
        message=result.assistant_reply, reward=result.reward_delta, preferences=updated_prefs
    )
