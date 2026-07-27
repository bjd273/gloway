"""API-level tests for the trip lifecycle: GPS breadcrumbs, completion, feedback.

Same conventions as test_api_routing.py: real stack over in-process ASGI
transport, auto-skip when backing services are down, clean up inserted rows.
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


requires_stack = pytest.mark.skipif(
    not (_valhalla_up() and _reachable("localhost", 5432)),
    reason="requires live Valhalla + Postgres",
)

_ROUTE_BODY = {
    "origin_lat": 32.720, "origin_lon": -97.130,
    "dest_lat": 32.755, "dest_lon": -97.090,
}


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


async def _fetch_trip_row(trip_id: str) -> dict:
    from db.session import get_session_factory

    async with get_session_factory()() as session:
        row = await session.execute(
            text(
                "SELECT actual_path_taken, completed_at, implicit_signals,"
                " explicit_feedback, reward_value FROM trips WHERE id = :id"
            ),
            {"id": trip_id},
        )
        keys = (
            "actual_path_taken", "completed_at", "implicit_signals",
            "explicit_feedback", "reward_value",
        )
        return dict(zip(keys, row.one()))


async def _delete_trip(trip_id: str) -> None:
    from db.session import get_session_factory

    async with get_session_factory()() as session:
        await session.execute(text("DELETE FROM trips WHERE id = :id"), {"id": trip_id})
        await session.commit()


@pytest.mark.integration
@requires_stack
async def test_trip_lifecycle_gps_complete_feedback(client):
    trip_id = (await client.post("/api/v1/routing/route", json=_ROUTE_BODY)).json()["trip_id"]
    try:
        # GPS breadcrumbs append in order across separate atomic flushes.
        first = await client.post(
            f"/api/v1/trips/{trip_id}/gps-update",
            json={"points": [{"lat": 32.721, "lon": -97.129}]},
        )
        assert first.status_code == 200 and first.json()["points"] == 1
        # A batch of two, one carrying a client timestamp.
        second = await client.post(
            f"/api/v1/trips/{trip_id}/gps-update",
            json={
                "points": [
                    {"lat": 32.722, "lon": -97.128},
                    {"lat": 32.723, "lon": -97.127, "timestamp": "2026-07-13T10:00:00Z"},
                ]
            },
        )
        assert second.json()["points"] == 3

        # Complete stamps completed_at and stores the client summary.
        done = await client.post(
            f"/api/v1/trips/{trip_id}/complete", json={"duration_minutes": 7.5}
        )
        assert done.status_code == 200

        # Completing again is a no-op, not an overwrite.
        again = await client.post(f"/api/v1/trips/{trip_id}/complete", json={})
        assert again.json()["completed_at"] == done.json()["completed_at"]

        feedback = await client.post(
            f"/api/v1/feedback/{trip_id}", json={"text": "Nice drive, too many lights."}
        )
        assert feedback.status_code == 200

        row = await _fetch_trip_row(trip_id)
        assert [p["lat"] for p in row["actual_path_taken"]] == [32.721, 32.722, 32.723]
        assert row["actual_path_taken"][2]["timestamp"] == "2026-07-13T10:00:00Z"
        assert row["completed_at"] is not None
        assert row["implicit_signals"]["client_summary"] == {"duration_minutes": 7.5}
        assert row["explicit_feedback"] == "Nice drive, too many lights."
        # A GPS trace was streamed, so complete() computes a real implicit
        # reward from adherence instead of the neutral default.
        assert row["implicit_signals"]["reward_source"] == "implicit_only"
        assert -1.0 <= row["reward_value"] <= 1.0
        assert "implicit_reward" in row["implicit_signals"]["implicit"]
    finally:
        await _delete_trip(trip_id)


@pytest.mark.integration
@requires_stack
async def test_complete_without_gps_keeps_neutral_default(client):
    """No usable GPS trace -> the neutral default still guarantees a reward."""
    trip_id = (await client.post("/api/v1/routing/route", json=_ROUTE_BODY)).json()["trip_id"]
    try:
        done = await client.post(f"/api/v1/trips/{trip_id}/complete", json={})
        assert done.status_code == 200
        row = await _fetch_trip_row(trip_id)
        assert row["reward_value"] == 0.0
        assert row["implicit_signals"]["reward_source"] == "default_neutral"
        assert "implicit" not in row["implicit_signals"]
    finally:
        await _delete_trip(trip_id)


@pytest.mark.integration
@requires_stack
async def test_late_gps_upgrades_the_neutral_placeholder(client):
    """Completion that outran the drive's final flush heals on the next touch.

    This is the shape of the bug that left `implicit` null on every trip in the
    database: the client fired POST /complete while its last GPS batch was
    still in flight, the trace was too short to score, and the neutral 0.0 was
    frozen in place because completion was terminal. Points arriving afterwards
    must still produce a real reward.
    """
    trip_id = (await client.post("/api/v1/routing/route", json=_ROUTE_BODY)).json()["trip_id"]
    try:
        # Completion wins the race — nothing to score against yet.
        await client.post(f"/api/v1/trips/{trip_id}/complete", json={})
        stale = await _fetch_trip_row(trip_id)
        assert stale["implicit_signals"]["reward_source"] == "default_neutral"
        assert "implicit" not in stale["implicit_signals"]

        # The tail batch lands a moment later.
        await client.post(
            f"/api/v1/trips/{trip_id}/gps-update",
            json={
                "points": [
                    {"lat": 32.7205, "lon": -97.1295},
                    {"lat": 32.7220, "lon": -97.1280},
                    {"lat": 32.7240, "lon": -97.1265},
                ]
            },
        )

        # A retried completion now scores the full trace instead of no-op'ing.
        again = await client.post(f"/api/v1/trips/{trip_id}/complete", json={})
        assert again.status_code == 200
        healed = await _fetch_trip_row(trip_id)
        assert healed["implicit_signals"]["reward_source"] == "implicit_only"
        assert healed["implicit_signals"]["implicit"]["adherence_rate"] is not None
        assert healed["reward_value"] != 0.0
        # Still idempotent about the timestamp itself.
        assert str(healed["completed_at"]) == str(stale["completed_at"])
    finally:
        await _delete_trip(trip_id)


@pytest.mark.integration
@requires_stack
async def test_explicit_reward_is_never_downgraded_by_a_retried_complete(client):
    """A reward carrying the user's own words outranks a behavioral-only one."""
    trip_id = (await client.post("/api/v1/routing/route", json=_ROUTE_BODY)).json()["trip_id"]
    try:
        await client.post(f"/api/v1/trips/{trip_id}/complete", json={})

        # Stand in for a debrief having written an explicit reward.
        from db.session import get_session_factory

        async with get_session_factory()() as session:
            await session.execute(
                text(
                    "UPDATE trips SET reward_value = 0.9,"
                    " implicit_signals = implicit_signals"
                    " || '{\"reward_source\": \"explicit_only\"}'::jsonb"
                    " WHERE id = :id"
                ),
                {"id": trip_id},
            )
            await session.commit()

        await client.post(
            f"/api/v1/trips/{trip_id}/gps-update",
            json={"points": [{"lat": 32.7205, "lon": -97.1295}, {"lat": 32.724, "lon": -97.126}]},
        )
        await client.post(f"/api/v1/trips/{trip_id}/complete", json={})

        row = await _fetch_trip_row(trip_id)
        assert row["reward_value"] == 0.9
        assert row["implicit_signals"]["reward_source"] == "explicit_only"
    finally:
        await _delete_trip(trip_id)


@pytest.mark.integration
@requires_stack
async def test_on_route_trace_scores_higher_than_off_route(client):
    """Following the suggested route yields higher adherence + reward than
    veering far off it."""
    from services.signal_processor import route_coords_from_suggested

    async def _reward_for(trace_points):
        trip_id = (await client.post("/api/v1/routing/route", json=_ROUTE_BODY)).json()["trip_id"]
        await client.post(f"/api/v1/trips/{trip_id}/gps-update", json={"points": trace_points})
        await client.post(f"/api/v1/trips/{trip_id}/complete", json={})
        row = await _fetch_trip_row(trip_id)
        await _delete_trip(trip_id)
        return row["implicit_signals"]["implicit"], row["reward_value"]

    # Sample the actual suggested route geometry to build an on-route trace.
    route_row = (await client.post("/api/v1/routing/route", json=_ROUTE_BODY)).json()
    # Re-fetch the trip's suggested_route to get the encoded shape.
    from db.session import get_session_factory

    async with get_session_factory()() as session:
        suggested = (
            await session.execute(
                text("SELECT suggested_route FROM trips WHERE id = :id"),
                {"id": route_row["trip_id"]},
            )
        ).scalar_one()
    await _delete_trip(route_row["trip_id"])
    coords = route_coords_from_suggested(suggested)
    on_route = [{"lat": lat, "lon": lon} for lon, lat in coords[:: max(1, len(coords) // 12)]]

    # Off-route: shove every fix ~500 m north of the route.
    off_route = [{"lat": p["lat"] + 0.0045, "lon": p["lon"]} for p in on_route]

    on_signals, on_reward = await _reward_for(on_route)
    off_signals, off_reward = await _reward_for(off_route)

    assert on_signals["adherence_rate"] > off_signals["adherence_rate"]
    assert on_reward > off_reward


@pytest.mark.integration
@requires_stack
async def test_concurrent_gps_flushes_all_persist(client):
    """The old read-modify-write lost points when flushes overlapped; the
    atomic append must keep every point from concurrent batches."""
    import asyncio

    trip_id = (await client.post("/api/v1/routing/route", json=_ROUTE_BODY)).json()["trip_id"]
    try:
        # Fire ten 5-point batches at once. 50 points must survive.
        batches = [
            client.post(
                f"/api/v1/trips/{trip_id}/gps-update",
                json={"points": [{"lat": 32.72 + b / 1000, "lon": -97.13} for _ in range(5)]},
            )
            for b in range(10)
        ]
        responses = await asyncio.gather(*batches)
        assert all(r.status_code == 200 for r in responses)

        row = await _fetch_trip_row(trip_id)
        assert len(row["actual_path_taken"]) == 50
    finally:
        await _delete_trip(trip_id)


@pytest.mark.integration
@requires_stack
async def test_unknown_trip_ids_are_404(client):
    ghost = str(uuid.uuid4())
    assert (
        await client.post(
            f"/api/v1/trips/{ghost}/gps-update", json={"points": [{"lat": 1, "lon": 1}]}
        )
    ).status_code == 404
    assert (await client.post(f"/api/v1/trips/{ghost}/complete", json={})).status_code == 404
    assert (
        await client.post(f"/api/v1/feedback/{ghost}", json={"text": "hi"})
    ).status_code == 404
    assert (
        await client.post("/api/v1/trips/not-a-uuid/complete", json={})
    ).status_code == 422
    assert (
        await client.post(
            "/api/v1/trips/not-a-uuid/gps-update", json={"points": [{"lat": 1, "lon": 1}]}
        )
    ).status_code == 422
