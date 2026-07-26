"""API-level tests for the routing endpoints.

These exercise the real stack (FastAPI app -> Valhalla -> Postgres) via an
in-process ASGI transport, and skip automatically when either backing
service is unreachable so the suite stays green without infra running.
"""
import socket
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

# Inside the Central Arlington extract.
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
        # ASGITransport doesn't run the lifespan — set up app state manually.
        from routing.valhalla_client import get_router

        app.state.valhalla_router = get_router()
        yield c
        await app.state.valhalla_router.aclose()


@pytest.mark.integration
@requires_stack
async def test_route_returns_alternatives_and_persists_trip(client):
    response = await client.post("/api/v1/routing/route", json=_ROUTE_BODY)
    assert response.status_code == 200
    data = response.json()
    assert data["recommended_index"] == 0
    assert len(data["routes"]) >= 1
    assert data["estimated_minutes"] > 0

    # The trip row must exist — it is the Phase 2/3 training data.
    from db.session import get_session_factory

    async with get_session_factory()() as session:
        row = await session.execute(
            text("SELECT ST_AsText(origin::geometry) FROM trips WHERE id = :id"),
            {"id": data["trip_id"]},
        )
        origin_wkt = row.scalar_one()
    assert origin_wkt == "POINT(-97.13 32.72)"

    # Clean up what this test inserted.
    async with get_session_factory()() as session:
        await session.execute(
            text("DELETE FROM trips WHERE id = :id"), {"id": data["trip_id"]}
        )
        await session.commit()


@pytest.mark.integration
@requires_stack
async def test_route_records_ranking_decision_in_trip_context(client):
    """The ranker's decision is persisted so training can later reconstruct
    which candidate was actually put in front of the user."""
    response = await client.post("/api/v1/routing/route", json=_ROUTE_BODY)
    data = response.json()

    from db.session import get_session_factory

    async with get_session_factory()() as session:
        context = (
            await session.execute(
                text("SELECT context FROM trips WHERE id = :id"), {"id": data["trip_id"]}
            )
        ).scalar_one()

    # No scorer is trained in CI, so this is the deterministic fallback path.
    assert context["recommended_index"] == data["recommended_index"] == 0
    assert context["personalization_active"] is False
    assert context["route_scores"] is None

    async with get_session_factory()() as session:
        await session.execute(text("DELETE FROM trips WHERE id = :id"), {"id": data["trip_id"]})
        await session.commit()


@pytest.mark.integration
@requires_stack
async def test_trained_ranker_changes_the_recommendation(client):
    """End-to-end proof the wiring is live: swapping in a scorer that prefers
    the slowest candidate moves recommended_index off Valhalla's primary."""
    import numpy as np

    from api.main import app
    from ml.rl.route_scorer import RouteScorer
    from ml.rl.state import FEATURE_NAMES, SCORING_FEATURE_DIM
    from routing.route_ranker import RouteRanker

    # A hand-built scorer: reward increases with duration, so the longest route
    # wins. No training needed — this isolates the wiring, not the learning.
    coefficients = np.zeros(SCORING_FEATURE_DIM)
    coefficients[FEATURE_NAMES.index("time_hours")] = 1.0
    scorer = RouteScorer(
        coefficients=coefficients, intercept=0.0,
        mean=np.zeros(SCORING_FEATURE_DIM), scale=np.ones(SCORING_FEATURE_DIM),
    )

    previous = getattr(app.state, "route_ranker", None)
    app.state.route_ranker = RouteRanker(scorer)
    try:
        response = await client.post("/api/v1/routing/route", json=_ROUTE_BODY)
        data = response.json()
        if len(data["routes"]) < 2:
            pytest.skip("Valhalla returned no alternates for this pair")

        slowest = max(
            range(len(data["routes"])), key=lambda i: data["routes"][i]["summary"]["time"]
        )
        assert data["recommended_index"] == slowest
        assert data["estimated_minutes"] == pytest.approx(
            data["routes"][slowest]["summary"]["time"] / 60
        )
    finally:
        app.state.route_ranker = previous
        from db.session import get_session_factory

        async with get_session_factory()() as session:
            await session.execute(
                text("DELETE FROM trips WHERE id = :id"), {"id": data["trip_id"]}
            )
            await session.commit()


@pytest.mark.integration
@requires_stack
async def test_route_outside_region_is_client_error_not_500(client):
    response = await client.post(
        "/api/v1/routing/route",
        json={"origin_lat": 30.2672, "origin_lon": -97.7431,
              "dest_lat": 30.28, "dest_lon": -97.74},
    )
    assert 400 <= response.status_code < 500


@pytest.mark.integration
@requires_stack
async def test_route_rejects_malformed_user_id(client):
    response = await client.post(
        "/api/v1/routing/route", json={**_ROUTE_BODY, "user_id": "not-a-uuid"}
    )
    assert response.status_code == 422
