"""API-level tests for user registration + preferences.

Same conventions as test_api_routing.py: real stack over in-process ASGI
transport, auto-skip when backing services are down, clean up inserted rows.
The route-difference test at the bottom is THE final Phase 1 milestone check:
"User preferences (avoid highways, avoid tolls) change the returned route."
"""
import socket
import uuid
from urllib.parse import urlparse

import httpx
import pytest
from sqlalchemy import text

from config import settings


def _reachable(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


def _valhalla_up() -> bool:
    parsed = urlparse(settings.valhalla_url)
    return _reachable(parsed.hostname or "localhost", parsed.port or 8002)


requires_db = pytest.mark.skipif(
    not _reachable("localhost", 5432), reason="requires live Postgres"
)
requires_stack = pytest.mark.skipif(
    not (_valhalla_up() and _reachable("localhost", 5432)),
    reason="requires live Valhalla + Postgres",
)


@pytest.fixture
async def client():
    from api.main import app

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as c:
        from routing.valhalla_client import get_router

        app.state.valhalla_router = get_router()
        yield c
        await app.state.valhalla_router.aclose()


async def _delete_user(user_id: str) -> None:
    """Remove a test user and everything hanging off it (trips lack a cascade)."""
    from db.session import get_session_factory

    async with get_session_factory()() as session:
        await session.execute(
            text("DELETE FROM trips WHERE user_id = :id"), {"id": user_id}
        )
        await session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
        await session.commit()


def _test_email() -> str:
    return f"pytest-{uuid.uuid4().hex[:12]}@test.gloway"


@pytest.mark.integration
@requires_db
async def test_register_is_idempotent_and_creates_default_prefs(client):
    email = _test_email()
    first = await client.post("/api/v1/users/register", json={"email": email})
    assert first.status_code == 200
    data = first.json()
    try:
        assert data["email"] == email
        assert data["preferences"] == {
            "avoid_highways": False,
            "avoid_tolls": False,
            "avoid_left_turns": False,
            "prefer_scenic": False,
            "max_acceptable_detour_minutes": 5,
        }

        # Same email again (client lost its localStorage) -> same account.
        second = await client.post("/api/v1/users/register", json={"email": email})
        assert second.status_code == 200
        assert second.json()["user_id"] == data["user_id"]
    finally:
        await _delete_user(data["user_id"])


@pytest.mark.integration
@requires_db
async def test_patch_preferences_roundtrips_through_profile(client):
    reg = await client.post("/api/v1/users/register", json={"email": _test_email()})
    user_id = reg.json()["user_id"]
    try:
        patch = await client.patch(
            f"/api/v1/users/{user_id}/preferences",
            json={"avoid_highways": True, "max_acceptable_detour_minutes": 10},
        )
        assert patch.status_code == 200
        prefs = patch.json()
        assert prefs["avoid_highways"] is True
        assert prefs["max_acceptable_detour_minutes"] == 10
        assert prefs["avoid_tolls"] is False  # untouched fields keep defaults

        profile = await client.get(f"/api/v1/users/{user_id}/profile")
        assert profile.status_code == 200
        assert profile.json()["preferences"]["avoid_highways"] is True
    finally:
        await _delete_user(user_id)


@pytest.mark.integration
@requires_db
async def test_register_creates_journey_profile_with_defaults(client):
    reg = await client.post("/api/v1/users/register", json={"email": _test_email()})
    assert reg.status_code == 200
    data = reg.json()
    try:
        assert data["journey"] == {
            "typical_use_cases": None,
            "stated_dislikes": None,
            "home_location": None,
            "work_location": None,
            "known_regular_routes": [],
            "driving_persona": {},
            "preferred_convo_style": "brief",
            "morning_routine_start_time": None,
            "typical_commute_duration_mins": None,
        }
    finally:
        await _delete_user(data["user_id"])


@pytest.mark.integration
@requires_db
async def test_missing_journey_profile_heals_on_profile_fetch(client):
    """Users registered before the journey-profile table existed must not 500."""
    reg = await client.post("/api/v1/users/register", json={"email": _test_email()})
    user_id = reg.json()["user_id"]
    try:
        from db.session import get_session_factory

        async with get_session_factory()() as session:
            await session.execute(
                text("DELETE FROM user_journey_profiles WHERE user_id = :id"),
                {"id": user_id},
            )
            await session.commit()

        profile = await client.get(f"/api/v1/users/{user_id}/profile")
        assert profile.status_code == 200
        assert profile.json()["journey"]["preferred_convo_style"] == "brief"
    finally:
        await _delete_user(user_id)


@pytest.mark.integration
@requires_db
async def test_journey_patch_sets_and_clears_home_location(client):
    reg = await client.post("/api/v1/users/register", json={"email": _test_email()})
    user_id = reg.json()["user_id"]
    try:
        patched = await client.patch(
            f"/api/v1/users/{user_id}/journey",
            json={
                "home_location": {"lat": 32.74, "lon": -97.12},
                "preferred_convo_style": "chatty",
            },
        )
        assert patched.status_code == 200
        body = patched.json()
        assert body["home_location"] == {"lat": 32.74, "lon": -97.12}
        assert body["preferred_convo_style"] == "chatty"
        assert body["work_location"] is None  # untouched

        profile = await client.get(f"/api/v1/users/{user_id}/profile")
        assert profile.json()["journey"]["home_location"] == {"lat": 32.74, "lon": -97.12}

        cleared = await client.patch(
            f"/api/v1/users/{user_id}/journey", json={"home_location": None}
        )
        assert cleared.json()["home_location"] is None
        assert cleared.json()["preferred_convo_style"] == "chatty"  # untouched

        bad = await client.patch(
            f"/api/v1/users/{user_id}/journey", json={"preferred_convo_style": "verbose"}
        )
        assert bad.status_code == 422
    finally:
        await _delete_user(user_id)


@pytest.mark.integration
@requires_db
async def test_trip_conversations_table_round_trips():
    """No endpoints yet (Week 11-12) — exercise the migrated table directly."""
    from db.session import get_session_factory

    async with get_session_factory()() as session:
        trip_id = (
            await session.execute(
                text(
                    "INSERT INTO trips (origin, destination, suggested_route) VALUES "
                    "(ST_GeogFromText('POINT(-97.13 32.72)'),"
                    " ST_GeogFromText('POINT(-97.09 32.75)'), '{}'::jsonb) RETURNING id"
                )
            )
        ).scalar_one()
        convo_id = (
            await session.execute(
                text(
                    "INSERT INTO trip_conversations (trip_id, messages) VALUES "
                    "(:trip_id, :messages) RETURNING id"
                ),
                {
                    "trip_id": trip_id,
                    "messages": '[{"role": "assistant", "content": "In a hurry today?"}]',
                },
            )
        ).scalar_one()
        await session.commit()

    try:
        async with get_session_factory()() as session:
            row = await session.execute(
                text(
                    "SELECT messages, user_id, preference_updates_extracted"
                    " FROM trip_conversations WHERE id = :id"
                ),
                {"id": convo_id},
            )
            messages, conv_user_id, extracted = row.one()
        assert messages == [{"role": "assistant", "content": "In a hurry today?"}]
        assert conv_user_id is None  # anonymous trips can converse
        assert extracted is None  # filled by Week 11-12 extraction
    finally:
        async with get_session_factory()() as session:
            await session.execute(
                text("DELETE FROM trip_conversations WHERE id = :id"), {"id": convo_id}
            )
            await session.execute(text("DELETE FROM trips WHERE id = :id"), {"id": trip_id})
            await session.commit()


@pytest.mark.integration
@requires_db
async def test_unknown_and_malformed_user_ids(client):
    missing = await client.get(f"/api/v1/users/{uuid.uuid4()}/profile")
    assert missing.status_code == 404
    malformed = await client.get("/api/v1/users/not-a-uuid/profile")
    assert malformed.status_code == 422
    bad_email = await client.post("/api/v1/users/register", json={"email": "nope"})
    assert bad_email.status_code == 422


# O/D chosen empirically against the Central Arlington extract: the default
# route hops on I-30 (~450s); with use_highways floored by avoid_highways the
# route stays on surface streets (~520s, no I-30 maneuvers). If the extract's
# bbox changes, re-verify this pair.
_HWY_ROUTE_BODY = {
    "origin_lat": 32.756, "origin_lon": -97.132,
    "dest_lat": 32.735, "dest_lon": -97.085,
}


def _instructions(route_response: dict) -> str:
    return " | ".join(
        m["instruction"]
        for route in route_response["routes"][:1]  # recommended route only
        for leg in route["legs"]
        for m in leg["maneuvers"]
    )


@pytest.mark.integration
@requires_stack
async def test_avoid_highways_preference_changes_the_route(client):
    anonymous = await client.post("/api/v1/routing/route", json=_HWY_ROUTE_BODY)
    assert anonymous.status_code == 200
    default_instructions = _instructions(anonymous.json())
    assert "I 30" in default_instructions  # premise: default route uses the interstate

    reg = await client.post("/api/v1/users/register", json={"email": _test_email()})
    user_id = reg.json()["user_id"]
    try:
        await client.patch(
            f"/api/v1/users/{user_id}/preferences", json={"avoid_highways": True}
        )
        as_user = await client.post(
            "/api/v1/routing/route", json={**_HWY_ROUTE_BODY, "user_id": user_id}
        )
        assert as_user.status_code == 200
        avoiding_instructions = _instructions(as_user.json())

        assert avoiding_instructions != default_instructions
        assert "I 30" not in avoiding_instructions

        # Clean up the anonymous trip too.
        from db.session import get_session_factory

        async with get_session_factory()() as session:
            await session.execute(
                text("DELETE FROM trips WHERE id = :id"),
                {"id": anonymous.json()["trip_id"]},
            )
            await session.commit()
    finally:
        await _delete_user(user_id)
