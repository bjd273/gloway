"""User accounts + routing preferences.

Phase 1 auth is deliberately minimal: registering is claiming an email and
getting back a user id the client remembers. No passwords or JWTs until
there's something worth protecting — the point of these endpoints is to make
the preferences -> route-costing seam (routing.py's _load_prefs ->
UserRoutingPrefs) reachable end-to-end, closing out the last Phase 1
milestone item.

Registration is idempotent on email: a client that lost its stored user id
(cleared localStorage) re-registers and gets the same account back.
"""
from __future__ import annotations

import uuid

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from geoalchemy2.elements import WKTElement
from geoalchemy2.shape import to_shape
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from db.models import User, UserJourneyProfile, UserPreference
from db.session import get_db

router = APIRouter()

_EMAIL_PATTERN = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


class RegisterRequest(BaseModel):
    email: str = Field(max_length=255, pattern=_EMAIL_PATTERN)


class PreferencesPatch(BaseModel):
    """All fields optional — only what the client sends gets updated."""

    avoid_highways: bool | None = None
    avoid_tolls: bool | None = None
    avoid_left_turns: bool | None = None
    prefer_scenic: bool | None = None
    max_acceptable_detour_minutes: int | None = Field(default=None, ge=0, le=120)


class PreferencesOut(BaseModel):
    avoid_highways: bool
    avoid_tolls: bool
    avoid_left_turns: bool
    prefer_scenic: bool
    max_acceptable_detour_minutes: int


class LatLon(BaseModel):
    lat: float
    lon: float


class JourneyOut(BaseModel):
    """The Phase 2 journey profile — what the conversation engine reads."""

    typical_use_cases: list[str] | None
    stated_dislikes: list[str] | None
    home_location: LatLon | None
    work_location: LatLon | None
    known_regular_routes: list
    driving_persona: dict
    preferred_convo_style: str
    morning_routine_start_time: str | None  # "HH:MM"
    typical_commute_duration_mins: int | None


class JourneyPatch(BaseModel):
    """Partial journey-profile update. Locations distinguish 'absent' (leave
    untouched) from explicit null (clear) via exclude_unset."""

    home_location: LatLon | None = None
    work_location: LatLon | None = None
    preferred_convo_style: Literal["brief", "chatty", "silent"] | None = None
    typical_use_cases: list[str] | None = None


class UserOut(BaseModel):
    user_id: str
    email: str
    onboarding_completed: bool
    preferences: PreferencesOut
    journey: JourneyOut


def _parse_uuid(user_id: str) -> uuid.UUID:
    try:
        return uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="user_id must be a UUID")


def _prefs_out(prefs: UserPreference) -> PreferencesOut:
    return PreferencesOut(
        avoid_highways=prefs.avoid_highways,
        avoid_tolls=prefs.avoid_tolls,
        avoid_left_turns=prefs.avoid_left_turns,
        prefer_scenic=prefs.prefer_scenic,
        max_acceptable_detour_minutes=prefs.max_acceptable_detour_minutes,
    )


def _point_out(geog) -> LatLon | None:
    if geog is None:
        return None
    point = to_shape(geog)  # shapely Point: x = lon, y = lat
    return LatLon(lat=point.y, lon=point.x)


def _journey_out(journey: UserJourneyProfile) -> JourneyOut:
    start = journey.morning_routine_start_time
    return JourneyOut(
        typical_use_cases=journey.typical_use_cases,
        stated_dislikes=journey.stated_dislikes,
        home_location=_point_out(journey.home_location),
        work_location=_point_out(journey.work_location),
        known_regular_routes=journey.known_regular_routes,
        driving_persona=journey.driving_persona,
        preferred_convo_style=journey.preferred_convo_style,
        morning_routine_start_time=start.strftime("%H:%M") if start else None,
        typical_commute_duration_mins=journey.typical_commute_duration_mins,
    )


async def _load_user_bundle(
    db: AsyncSession, uid: uuid.UUID
) -> tuple[User, UserPreference, UserJourneyProfile]:
    user = await db.get(User, uid)
    if user is None:
        raise HTTPException(status_code=404, detail="user not found")
    prefs = await db.get(UserPreference, uid)
    journey = await db.get(UserJourneyProfile, uid)
    if prefs is None or journey is None:
        # Rows that register() normally creates can be missing (users from
        # before a table existed, or a half-failed insert) — heal instead of
        # 500ing.
        if prefs is None:
            prefs = UserPreference(user_id=uid)
            db.add(prefs)
        if journey is None:
            journey = UserJourneyProfile(user_id=uid)
            db.add(journey)
        await db.commit()
        await db.refresh(prefs)
        await db.refresh(journey)
    return user, prefs, journey


def _user_out(user: User, prefs: UserPreference, journey: UserJourneyProfile) -> UserOut:
    return UserOut(
        user_id=str(user.id),
        email=user.email,
        onboarding_completed=user.onboarding_completed,
        preferences=_prefs_out(prefs),
        journey=_journey_out(journey),
    )


@router.post("/register", response_model=UserOut)
async def register(request: RegisterRequest, db: AsyncSession = Depends(get_db)):
    email = request.email.strip().lower()
    user = await db.scalar(select(User).where(User.email == email))
    if user is None:
        user = User(email=email)
        db.add(user)
        await db.flush()  # assigns user.id so the child rows can reference it
        db.add(UserPreference(user_id=user.id))
        db.add(UserJourneyProfile(user_id=user.id))
        await db.commit()
        # Server-side defaults (FALSE, 'brief', NOW()) only exist in the DB
        # until refreshed into the ORM objects.
        await db.refresh(user)
    user, prefs, journey = await _load_user_bundle(db, user.id)
    return _user_out(user, prefs, journey)


@router.get("/{user_id}/profile", response_model=UserOut)
async def get_profile(user_id: str, db: AsyncSession = Depends(get_db)):
    uid = _parse_uuid(user_id)
    user, prefs, journey = await _load_user_bundle(db, uid)
    return _user_out(user, prefs, journey)


@router.patch("/{user_id}/preferences", response_model=PreferencesOut)
async def update_preferences(
    user_id: str, patch: PreferencesPatch, db: AsyncSession = Depends(get_db)
):
    uid = _parse_uuid(user_id)
    _, prefs, _ = await _load_user_bundle(db, uid)

    changes = patch.model_dump(exclude_unset=True, exclude_none=True)
    if changes:
        for field, value in changes.items():
            setattr(prefs, field, value)
        prefs.updated_at = func.now()
        await db.commit()
        await db.refresh(prefs)
    return _prefs_out(prefs)


@router.patch("/{user_id}/journey", response_model=JourneyOut)
async def update_journey(
    user_id: str, patch: JourneyPatch, db: AsyncSession = Depends(get_db)
):
    uid = _parse_uuid(user_id)
    _, _, journey = await _load_user_bundle(db, uid)

    changes = patch.model_dump(exclude_unset=True)  # keep explicit nulls: they clear
    if changes:
        for field, value in changes.items():
            if field in ("home_location", "work_location"):
                value = (
                    WKTElement(f"POINT({value['lon']} {value['lat']})", srid=4326)
                    if value is not None
                    else None
                )
            elif value is None:
                continue  # null for non-location fields means "leave untouched"
            setattr(journey, field, value)
        journey.updated_at = func.now()
        await db.commit()
        await db.refresh(journey)
    return _journey_out(journey)
