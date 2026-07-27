"""Trip lifecycle: GPS breadcrumbs during a drive, and completion.

Every route request already creates a `trips` row (routing.py). These
endpoints fill in the rest of that row's life: `actual_path_taken` accumulates
GPS points while driving, and `complete` stamps `completed_at` + any client
wrap-up stats into `implicit_signals`. Phase 2's Celery signal-processing task
will hang off the complete endpoint; today it just persists the raw material.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, text
from sqlalchemy.ext.asyncio import AsyncSession

from db.models import Trip
from db.session import get_db
from ml.rl.reward_engine import compute_final_reward
from services.signal_processor import ensure_implicit_signals

router = APIRouter()


class GpsPoint(BaseModel):
    lat: float
    lon: float
    timestamp: str | None = None  # client clock, ISO 8601; server fills if absent


class GpsBatch(BaseModel):
    # A batch, not a single point: during a live drive the client buffers a few
    # seconds of fixes and flushes them together — fewer requests, and the
    # atomic append below means concurrent flushes can't clobber each other.
    points: list[GpsPoint] = Field(min_length=1, max_length=1000)


class CompleteRequest(BaseModel):
    # Optional wrap-up stats from the client. Stored verbatim under
    # implicit_signals.client_summary — the Phase 2 reward pipeline decides
    # what they mean.
    duration_minutes: float | None = Field(default=None, ge=0)
    deviated: bool | None = None


async def _load_trip(db: AsyncSession, trip_id: str) -> Trip:
    try:
        tid = uuid.UUID(trip_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="trip_id must be a UUID")
    trip = await db.get(Trip, tid)
    if trip is None:
        raise HTTPException(status_code=404, detail="trip not found")
    return trip


@router.post("/{trip_id}/gps-update")
async def gps_update(trip_id: str, batch: GpsBatch, db: AsyncSession = Depends(get_db)):
    try:
        tid = uuid.UUID(trip_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="trip_id must be a UUID")

    now = datetime.now(timezone.utc).isoformat()
    points = [
        {"lat": p.lat, "lon": p.lon, "timestamp": p.timestamp or now} for p in batch.points
    ]

    # Atomic append at the DB, not read-modify-write in Python. The old version
    # loaded the whole array, appended, and overwrote it — two in-flight flushes
    # each read the same array and the second clobbered the first's points.
    # `col = col || :new` re-reads the row under its lock, so concurrent appends
    # serialize instead of racing, and app code never rewrites the full array.
    result = await db.execute(
        text(
            "UPDATE trips "
            "SET actual_path_taken = coalesce(actual_path_taken, '[]'::jsonb) "
            "|| cast(:pts as jsonb) "
            "WHERE id = :id "
            "RETURNING jsonb_array_length(actual_path_taken)"
        ),
        {"pts": json.dumps(points), "id": tid},
    )
    row = result.first()
    if row is None:
        raise HTTPException(status_code=404, detail="trip not found")
    await db.commit()
    return {"trip_id": trip_id, "points": row[0]}


@router.post("/{trip_id}/complete")
async def complete_trip(
    trip_id: str, request: CompleteRequest, db: AsyncSession = Depends(get_db)
):
    trip = await _load_trip(db, trip_id)
    already_complete = trip.completed_at is not None

    signals = dict(trip.implicit_signals or {})
    if not already_complete:
        trip.completed_at = func.now()
        client_summary = request.model_dump(exclude_none=True)
        if client_summary:
            signals["client_summary"] = client_summary
    # Make client_summary visible to compute_implicit_signals (it reads the
    # trip's own signals for the reported duration) before we compute.
    trip.implicit_signals = signals

    # Behavioral signals from the GPS trace vs the suggested route. Empty when
    # there's no usable trace (short/abandoned trips) — then keep the neutral
    # default so every completed trip still has a reward for Phase 3.
    #
    # Run on the retried path too, not just the first completion: the client's
    # final GPS flush can land after the first complete() (see
    # ensure_implicit_signals), and a trip whose trace only became usable
    # afterwards should still get a real reward rather than keeping the
    # placeholder forever.
    implicit = ensure_implicit_signals(trip)
    if implicit:
        signals["implicit"] = implicit

    # Recompute when there's no reward yet, or when the stored one is the
    # neutral placeholder written before the trace arrived. A `fused` or
    # `explicit_only` reward already carries the user's own words — never
    # overwrite that with a behavioral-only score.
    if trip.reward_value is None or signals.get("reward_source") == "default_neutral":
        fused = compute_final_reward(implicit, None)
        trip.reward_value = fused["reward"]
        signals["reward_source"] = (
            "default_neutral" if fused["source"] == "neutral" else fused["source"]
        )

    # Fresh dict so SQLAlchemy's JSONB change-tracking fires.
    trip.implicit_signals = dict(signals)
    await db.commit()
    await db.refresh(trip)
    return {"trip_id": trip_id, "completed_at": str(trip.completed_at)}
