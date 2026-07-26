"""Post-trip text feedback.

Stored raw on the trip row. In Phase 2 this text (plus the trip conversation)
feeds Claude's preference extraction; for now capturing it is the whole job.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from db.models import Trip
from db.session import get_db

router = APIRouter()


class FeedbackRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


@router.post("/{trip_id}")
async def submit_feedback(
    trip_id: str, request: FeedbackRequest, db: AsyncSession = Depends(get_db)
):
    try:
        tid = uuid.UUID(trip_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="trip_id must be a UUID")
    trip = await db.get(Trip, tid)
    if trip is None:
        raise HTTPException(status_code=404, detail="trip not found")

    trip.explicit_feedback = request.text.strip()
    await db.commit()
    return {"trip_id": trip_id, "stored": True}
