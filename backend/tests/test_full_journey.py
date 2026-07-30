"""The whole loop, end to end: signup -> route -> drive -> debrief -> a second
route that is planned differently because of what the first one taught us.

This is the roadmap's Integration milestone (items 1 and 2) as executable
proof. Every piece below is covered in isolation elsewhere; what is only
testable here is that the pieces are actually wired to each other — that a
preference the LLM extracted from a post-drive conversation survives into the
costing of the *next* trip. That is the product's central claim, and until this
file existed nothing checked it.

The GPS trace is decoded from the route the API actually returned (via the
same services.signal_processor.decode_polyline the reward pipeline uses), so
the drive follows the suggested line and adherence is a real measurement
rather than a fixture.

Conventions match tests/test_api_trips.py: real stack over in-process ASGI
transport, auto-skip when Valhalla/Postgres are down, rows cleaned up in a
finally.
"""
import socket
import uuid
from urllib.parse import urlparse

import httpx
import pytest
from sqlalchemy import text

from config import settings
from services.signal_processor import decode_polyline
from tests.fakes import FakeLLMClient, override_llm


def _reachable(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


def _valhalla_up() -> bool:
    parsed = urlparse(settings.valhalla_url)
    return _reachable(parsed.hostname or "localhost", parsed.port or 8002)


requires_stack = pytest.mark.skipif(
    not (_valhalla_up() and _reachable("localhost", 5432)),
    reason="requires live Valhalla + Postgres",
)

# Inside the Central Arlington extract, far enough apart for a multi-street route.
_ROUTE_BODY = {
    "origin_lat": 32.720, "origin_lon": -97.130,
    "dest_lat": 32.755, "dest_lon": -97.090,
}


@pytest.fixture
async def client():
    from api.main import app
    from routing.valhalla_client import get_router

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as c:
        app.state.valhalla_router = get_router()
        yield c
        await app.state.valhalla_router.aclose()
        app.dependency_overrides.clear()


async def _cleanup(user_id: str) -> None:
    from db.session import get_session_factory

    async with get_session_factory()() as session:
        await session.execute(
            text(
                "DELETE FROM trip_conversations WHERE trip_id IN"
                " (SELECT id FROM trips WHERE user_id = :uid)"
            ),
            {"uid": user_id},
        )
        await session.execute(text("DELETE FROM trips WHERE user_id = :uid"), {"uid": user_id})
        await session.execute(
            text("DELETE FROM user_preferences WHERE user_id = :uid"), {"uid": user_id}
        )
        await session.execute(
            text("DELETE FROM user_journey_profiles WHERE user_id = :uid"), {"uid": user_id}
        )
        await session.execute(text("DELETE FROM users WHERE id = :uid"), {"uid": user_id})
        await session.commit()


def _trace_along(route: dict, every: int = 12) -> list[dict]:
    """GPS points sampled along the route's own geometry.

    Decoded with the reward pipeline's own decoder so the trace is in exactly
    the frame adherence is scored in — a drive that followed the directions.
    """
    coords: list[tuple[float, float]] = []
    for leg in route.get("legs") or []:
        shape = leg.get("shape")
        if shape:
            coords.extend(decode_polyline(shape))
    sampled = coords[::every] or coords
    return [{"lat": lat, "lon": lon} for lon, lat in sampled]


@pytest.mark.integration
@requires_stack
async def test_full_journey_teaches_the_next_route(client):
    from api.main import app
    from api.routes.conversation import _llm

    # The debrief hears "I'd rather stay off the highway" and extracts a
    # durable preference plus a positive reward.
    app.dependency_overrides[_llm] = override_llm(
        FakeLLMClient(
            opener="How did that drive go?",
            extraction={
                "reward_delta": 0.7,
                "preference_updates": {"avoid_highways": True},
                "assistant_reply": "Noted — I'll keep you off the highway.",
                "confidence": 0.9,
            },
        )
    )

    # Record the preference weights each routing call is actually made with.
    # This is the assertion that matters: not "the line on the map moved" (a
    # short route through a small extract may legitimately be identical), but
    # "the second trip was planned with the preference the first one taught".
    used_prefs = []
    real_get_route = app.state.valhalla_router.get_route

    async def spy_get_route(*args, **kwargs):
        # One /route request now fans out into several Valhalla calls (the
        # candidate-generation sweep), all sharing one prefs object. Record per
        # *request* by collapsing consecutive calls that carry the same object,
        # so the indices below stay "first trip" and "second trip".
        prefs = kwargs.get("prefs")
        if not used_prefs or used_prefs[-1] is not prefs:
            used_prefs.append(prefs)
        return await real_get_route(*args, **kwargs)

    app.state.valhalla_router.get_route = spy_get_route

    register = await client.post(
        "/api/v1/users/register", json={"email": f"pytest-{uuid.uuid4().hex[:12]}@test.gloway"}
    )
    assert register.status_code == 200
    user_id = register.json()["user_id"]

    try:
        # --- trip 1: plan -------------------------------------------------
        first = await client.post("/api/v1/routing/route", json={**_ROUTE_BODY, "user_id": user_id})
        assert first.status_code == 200
        first_body = first.json()
        trip_id = first_body["trip_id"]
        assert first_body["routes"], "expected at least one route"
        assert used_prefs[0].avoid_highways == 0.0, "new user starts with no highway aversion"

        # --- trip 1: drive it ---------------------------------------------
        points = _trace_along(first_body["routes"][0])
        assert len(points) >= 2, "route geometry should yield a usable trace"
        gps = await client.post(
            f"/api/v1/trips/{trip_id}/gps-update", json={"points": points}
        )
        assert gps.status_code == 200

        complete = await client.post(
            f"/api/v1/trips/{trip_id}/complete", json={"duration_minutes": 6.0}
        )
        assert complete.status_code == 200

        # --- trip 1: debrief ----------------------------------------------
        assert (await client.post(f"/api/v1/trips/{trip_id}/debrief/open")).status_code == 200
        debrief = await client.post(
            f"/api/v1/trips/{trip_id}/debrief/reply",
            json={"text": "fine, but I'd rather stay off the highway next time"},
        )
        assert debrief.status_code == 200
        assert debrief.json()["preferences"]["avoid_highways"] is True

        # The drive was followed, so the reward carries behavioural signal and
        # is fused with what the user said — not explicit-only.
        from db.session import get_session_factory

        async with get_session_factory()() as session:
            reward_value, signals = (
                await session.execute(
                    text("SELECT reward_value, implicit_signals FROM trips WHERE id = :id"),
                    {"id": trip_id},
                )
            ).one()
        assert signals["reward_source"] == "fused"
        assert signals["implicit"]["adherence_rate"] is not None
        assert -1.0 <= reward_value <= 1.0

        # --- trip 2: the payoff -------------------------------------------
        second = await client.post(
            "/api/v1/routing/route", json={**_ROUTE_BODY, "user_id": user_id}
        )
        assert second.status_code == 200
        assert second.json()["trip_id"] != trip_id

        assert used_prefs[1].avoid_highways == 1.0, (
            "the second trip should be planned with the preference the debrief "
            "extracted from the first"
        )
    finally:
        app.state.valhalla_router.get_route = real_get_route
        await _cleanup(user_id)
