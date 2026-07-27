"""Conversation layer tests.

The FastAPI dependency for the LLM client is overridden with a fake, so these
exercise the full endpoint -> extraction -> persistence path against real
Postgres without any network or token spend. One requires_llm smoke test at
the bottom talks to the real provider (single tiny completion) and skips when
no key is configured.
"""
import json
import socket
import uuid

import httpx
import pytest
from sqlalchemy import text

from config import settings
from ml.llm.base import LLMClient, LLMUnavailable


def _reachable(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


requires_db = pytest.mark.skipif(
    not _reachable("localhost", 5432), reason="requires live Postgres"
)
requires_llm = pytest.mark.skipif(
    not settings.gemini_api_key, reason="requires GEMINI_API_KEY"
)


class FakeLLMClient(LLMClient):
    """Returns canned responses; json_mode requests get the extraction payload."""

    def __init__(self, opener: str = "In a hurry today, or shall we cruise?",
                 extraction: dict | None = None):
        self.opener = opener
        self.last_json_prompt: str | None = None
        self.extraction = extraction or {
            "intent": "hurry",
            "preference_updates": {"avoid_highways": True},
            "assistant_reply": "Fastest way it is.",
            "confidence": 0.9,
        }

    async def complete(self, system, messages, max_tokens=256, json_mode=False):
        if json_mode:
            self.last_json_prompt = messages[-1]["content"]
            return json.dumps(self.extraction)
        return self.opener


class FakeMapDataSource:
    """Stop-lookup stub: canned places for get_places, one hit for queries."""

    def __init__(self):
        from mapdata.models import Address, Place, PlaceCategory

        self.places = [
            Place(id="osm:node/1", name="Edge Cafe", category=PlaceCategory.CAFE,
                  lat=32.760, lon=-97.140, source="osm"),
            Place(id="osm:node/2", name="Midpoint Coffee", category=PlaceCategory.CAFE,
                  lat=32.735, lon=-97.110, source="osm"),
        ]
        self.addresses = [
            Address(id="osm:way/3", formatted="Panera Bread, Cooper Street, Arlington",
                    lat=32.732, lon=-97.113, source="osm"),
        ]

    async def get_places(self, category, bbox):
        return self.places

    async def search_addresses(self, query, limit=5):
        return self.addresses

    async def aclose(self):
        pass


class EmptyMapDataSource(FakeMapDataSource):
    def __init__(self):
        self.places = []
        self.addresses = []


class DownLLMClient(LLMClient):
    async def complete(self, system, messages, max_tokens=256, json_mode=False):
        raise LLMUnavailable("provider down")


def _override_llm(fake: LLMClient):
    async def _dep():
        yield fake
    return _dep


@pytest.fixture
async def client():
    from api.main import app

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c
        app.dependency_overrides.clear()


async def _make_trip(user_id: str | None = None) -> str:
    from db.session import get_session_factory

    async with get_session_factory()() as session:
        trip_id = (
            await session.execute(
                text(
                    "INSERT INTO trips (user_id, origin, destination, suggested_route, context)"
                    " VALUES (:uid, ST_GeogFromText('POINT(-97.13 32.72)'),"
                    " ST_GeogFromText('POINT(-97.09 32.75)'), '{}'::jsonb,"
                    " '{\"dest_label\": \"Globe Life Field\"}'::jsonb) RETURNING id"
                ),
                {"uid": user_id},
            )
        ).scalar_one()
        await session.commit()
    return str(trip_id)


async def _cleanup(trip_ids: list[str] = (), user_ids: list[str] = ()):
    from db.session import get_session_factory

    async with get_session_factory()() as session:
        for tid in trip_ids:
            await session.execute(
                text("DELETE FROM trip_conversations WHERE trip_id = :id"), {"id": tid}
            )
            await session.execute(text("DELETE FROM trips WHERE id = :id"), {"id": tid})
        for uid in user_ids:
            await session.execute(text("DELETE FROM users WHERE id = :id"), {"id": uid})
        await session.commit()


@pytest.mark.integration
@requires_db
async def test_open_persists_opener_and_is_idempotent(client):
    from api.main import app
    from api.routes.conversation import _llm

    app.dependency_overrides[_llm] = _override_llm(FakeLLMClient())
    trip_id = await _make_trip()
    try:
        first = await client.post(f"/api/v1/trips/{trip_id}/conversation/open")
        assert first.status_code == 200
        data = first.json()
        assert data["messages"][0]["role"] == "assistant"
        assert "hurry" in data["messages"][0]["content"]

        again = await client.post(f"/api/v1/trips/{trip_id}/conversation/open")
        assert again.json()["conversation_id"] == data["conversation_id"]
    finally:
        await _cleanup(trip_ids=[trip_id])


@pytest.mark.integration
@requires_db
async def test_reply_applies_intent_and_preferences(client):
    from api.main import app
    from api.routes.conversation import _llm

    app.dependency_overrides[_llm] = _override_llm(FakeLLMClient())

    reg = await client.post(
        "/api/v1/users/register", json={"email": f"pytest-{uuid.uuid4().hex[:12]}@test.gloway"}
    )
    user_id = reg.json()["user_id"]
    trip_id = await _make_trip(user_id)
    try:
        await client.post(f"/api/v1/trips/{trip_id}/conversation/open")
        reply = await client.post(
            f"/api/v1/trips/{trip_id}/conversation/reply",
            json={"text": "Running late, and I really hate highways"},
        )
        assert reply.status_code == 200
        body = reply.json()
        assert body["intent"] == "hurry"
        assert body["preferences"]["avoid_highways"] is True

        profile = await client.get(f"/api/v1/users/{user_id}/profile")
        assert profile.json()["preferences"]["avoid_highways"] is True

        from db.session import get_session_factory

        async with get_session_factory()() as session:
            row = await session.execute(
                text(
                    "SELECT messages, preference_updates_extracted"
                    " FROM trip_conversations WHERE trip_id = :id"
                ),
                {"id": trip_id},
            )
            messages, extracted = row.one()
        assert [m["role"] for m in messages] == ["assistant", "user", "assistant"]
        # A list of per-turn extractions — the newest turn is last.
        assert len(extracted) == 1
        assert extracted[-1]["intent"] == "hurry"
        assert extracted[-1]["preference_updates"] == {"avoid_highways": True}
    finally:
        await _cleanup(trip_ids=[trip_id], user_ids=[user_id])


@pytest.mark.integration
@requires_db
async def test_every_reply_appends_an_extraction(client):
    """Each turn's extraction must survive — this field used to be overwritten,
    silently dropping every turn but the last (and with it the switch_to_route
    pairwise labels the route scorer trains on)."""
    from api.main import app
    from api.routes.conversation import _llm

    fake = FakeLLMClient(extraction={
        "intent": None, "preference_updates": {},
        "switch_to_route": 1, "assistant_reply": "Switched.", "confidence": 0.9,
    })
    app.dependency_overrides[_llm] = _override_llm(fake)

    trip_id = await _make_trip()
    try:
        await client.post(f"/api/v1/trips/{trip_id}/conversation/open")
        options = [{"index": 0, "minutes": 12.0, "selected": True},
                   {"index": 1, "minutes": 15.0, "selected": False}]
        for text_in in ("take the scenic one", "actually keep it"):
            reply = await client.post(
                f"/api/v1/trips/{trip_id}/conversation/reply",
                json={"text": text_in, "route_options": options},
            )
            assert reply.status_code == 200

        from db.session import get_session_factory

        async with get_session_factory()() as session:
            extracted = (
                await session.execute(
                    text("SELECT preference_updates_extracted FROM trip_conversations"
                         " WHERE trip_id = :id"),
                    {"id": trip_id},
                )
            ).scalar_one()

        assert len(extracted) == 2, "second reply overwrote the first"
        # The chosen index is only interpretable alongside what was offered.
        assert extracted[0]["switch_to_route"] == 1
        assert extracted[0]["route_options"] == options
        assert all(e["phase"] == "pre_journey" and e["timestamp"] for e in extracted)
    finally:
        await _cleanup(trip_ids=[trip_id])


@pytest.mark.integration
@requires_db
async def test_low_confidence_updates_are_dropped(client):
    from api.main import app
    from api.routes.conversation import _llm

    fake = FakeLLMClient(extraction={
        "intent": None,
        "preference_updates": {"avoid_tolls": True},
        "assistant_reply": "Noted.",
        "confidence": 0.2,
    })
    app.dependency_overrides[_llm] = _override_llm(fake)

    reg = await client.post(
        "/api/v1/users/register", json={"email": f"pytest-{uuid.uuid4().hex[:12]}@test.gloway"}
    )
    user_id = reg.json()["user_id"]
    trip_id = await _make_trip(user_id)
    try:
        await client.post(f"/api/v1/trips/{trip_id}/conversation/open")
        reply = await client.post(
            f"/api/v1/trips/{trip_id}/conversation/reply", json={"text": "hmm maybe"}
        )
        assert reply.json()["preferences"] is None
        profile = await client.get(f"/api/v1/users/{user_id}/profile")
        assert profile.json()["preferences"]["avoid_tolls"] is False
    finally:
        await _cleanup(trip_ids=[trip_id], user_ids=[user_id])


@pytest.mark.integration
@requires_db
async def test_stop_by_category_picks_nearest_to_midpoint(client, monkeypatch):
    from api.main import app
    from api.routes.conversation import _llm

    fake = FakeLLMClient(extraction={
        "intent": None, "preference_updates": {},
        "add_stop": {"category": "cafe", "query": None},
        "assistant_reply": "Coffee coming up.", "confidence": 0.9,
    })
    app.dependency_overrides[_llm] = _override_llm(fake)
    monkeypatch.setattr("api.routes.conversation.get_map_data_source", FakeMapDataSource)

    trip_id = await _make_trip()
    try:
        await client.post(f"/api/v1/trips/{trip_id}/conversation/open")
        reply = await client.post(
            f"/api/v1/trips/{trip_id}/conversation/reply",
            json={"text": "can we grab a coffee on the way?"},
        )
        body = reply.json()
        # Trip runs (32.72,-97.13)->(32.75,-97.09); Midpoint Coffee sits at the
        # midpoint and must beat Edge Cafe.
        assert body["stop"] == {"name": "Midpoint Coffee", "lat": 32.735, "lon": -97.11}
        assert body["message"] == "Coffee coming up. I found Midpoint Coffee on the way."

        from db.session import get_session_factory

        async with get_session_factory()() as session:
            extracted = (
                await session.execute(
                    text("SELECT preference_updates_extracted FROM trip_conversations"
                         " WHERE trip_id = :id"),
                    {"id": trip_id},
                )
            ).scalar_one()
        assert extracted[-1]["stop"]["name"] == "Midpoint Coffee"
    finally:
        await _cleanup(trip_ids=[trip_id])


@pytest.mark.integration
@requires_db
async def test_stop_by_named_query_uses_address_search(client, monkeypatch):
    from api.main import app
    from api.routes.conversation import _llm

    fake = FakeLLMClient(extraction={
        "intent": None, "preference_updates": {},
        "add_stop": {"category": "restaurant", "query": "Panera"},
        "assistant_reply": "Sure.", "confidence": 0.9,
    })
    app.dependency_overrides[_llm] = _override_llm(fake)
    monkeypatch.setattr("api.routes.conversation.get_map_data_source", FakeMapDataSource)

    trip_id = await _make_trip()
    try:
        await client.post(f"/api/v1/trips/{trip_id}/conversation/open")
        reply = await client.post(
            f"/api/v1/trips/{trip_id}/conversation/reply", json={"text": "stop at Panera"}
        )
        assert reply.json()["stop"]["name"] == "Panera Bread"
    finally:
        await _cleanup(trip_ids=[trip_id])


@pytest.mark.integration
@requires_db
async def test_stop_not_found_degrades_gracefully(client, monkeypatch):
    from api.main import app
    from api.routes.conversation import _llm

    fake = FakeLLMClient(extraction={
        "intent": None, "preference_updates": {},
        "add_stop": {"category": "cafe", "query": None},
        "assistant_reply": "Let me look.", "confidence": 0.9,
    })
    app.dependency_overrides[_llm] = _override_llm(fake)
    monkeypatch.setattr("api.routes.conversation.get_map_data_source", EmptyMapDataSource)

    trip_id = await _make_trip()
    try:
        await client.post(f"/api/v1/trips/{trip_id}/conversation/open")
        reply = await client.post(
            f"/api/v1/trips/{trip_id}/conversation/reply", json={"text": "coffee please"}
        )
        body = reply.json()
        assert body["stop"] is None
        assert "couldn't find" in body["message"]
    finally:
        await _cleanup(trip_ids=[trip_id])


@pytest.mark.integration
@requires_db
async def test_switch_to_route_validated_against_options(client):
    from api.main import app
    from api.routes.conversation import _llm

    fake = FakeLLMClient(extraction={
        "intent": None, "preference_updates": {}, "switch_to_route": 2,
        "assistant_reply": "Scenic it is.", "confidence": 0.9,
    })
    app.dependency_overrides[_llm] = _override_llm(fake)

    trip_id = await _make_trip()
    try:
        await client.post(f"/api/v1/trips/{trip_id}/conversation/open")
        options = [
            {"index": 0, "minutes": 6, "selected": True},
            {"index": 1, "minutes": 7, "selected": False},
            {"index": 2, "minutes": 10, "selected": False},
        ]
        good = await client.post(
            f"/api/v1/trips/{trip_id}/conversation/reply",
            json={"text": "take the slow one", "route_options": options},
        )
        assert good.json()["switch_to_route"] == 2
        # ROUTE OPTIONS block reached the extractor prompt.
        assert "10 min" in fake.last_json_prompt

        # Same extraction, but the client only has 2 options -> index invalid.
        short = await client.post(
            f"/api/v1/trips/{trip_id}/conversation/reply",
            json={"text": "take the slow one", "route_options": options[:2]},
        )
        assert short.json()["switch_to_route"] is None
    finally:
        await _cleanup(trip_ids=[trip_id])


@pytest.mark.integration
@requires_db
async def test_remove_stops_flag_passes_through(client):
    from api.main import app
    from api.routes.conversation import _llm

    fake = FakeLLMClient(extraction={
        "intent": None, "preference_updates": {}, "remove_stops": True,
        "assistant_reply": "Dropped the stop.", "confidence": 0.9,
    })
    app.dependency_overrides[_llm] = _override_llm(fake)

    trip_id = await _make_trip()
    try:
        await client.post(f"/api/v1/trips/{trip_id}/conversation/open")
        reply = await client.post(
            f"/api/v1/trips/{trip_id}/conversation/reply", json={"text": "skip the coffee"}
        )
        assert reply.json()["stops_cleared"] is True
        assert reply.json()["stop"] is None
    finally:
        await _cleanup(trip_ids=[trip_id])


@pytest.mark.integration
@requires_db
async def test_llm_down_is_503_and_writes_nothing(client):
    from api.main import app
    from api.routes.conversation import _llm

    app.dependency_overrides[_llm] = _override_llm(DownLLMClient())
    trip_id = await _make_trip()
    try:
        response = await client.post(f"/api/v1/trips/{trip_id}/conversation/open")
        assert response.status_code == 503

        from db.session import get_session_factory

        async with get_session_factory()() as session:
            count = (
                await session.execute(
                    text("SELECT COUNT(*) FROM trip_conversations WHERE trip_id = :id"),
                    {"id": trip_id},
                )
            ).scalar_one()
        assert count == 0
    finally:
        await _cleanup(trip_ids=[trip_id])


@pytest.mark.integration
@requires_db
async def test_set_destination_and_travel_mode_pass_through(client):
    from api.main import app
    from api.routes.conversation import _llm

    fake = FakeLLMClient(extraction={
        "intent": None, "preference_updates": {},
        "set_destination": "home", "travel_mode": "bicycle",
        "assistant_reply": "Heading home on the bike.", "confidence": 0.9,
    })
    app.dependency_overrides[_llm] = _override_llm(fake)

    trip_id = await _make_trip()
    try:
        await client.post(f"/api/v1/trips/{trip_id}/conversation/open")
        reply = await client.post(
            f"/api/v1/trips/{trip_id}/conversation/reply", json={"text": "take me home, I'm cycling"}
        )
        body = reply.json()
        assert body["set_destination"] == "home"
        assert body["travel_mode"] == "bicycle"
    finally:
        await _cleanup(trip_ids=[trip_id])


@pytest.mark.integration
@requires_db
async def test_debrief_open_persists_question(client):
    from api.main import app
    from api.routes.conversation import _llm

    fake = FakeLLMClient(opener="How was the drive to the stadium?")
    app.dependency_overrides[_llm] = _override_llm(fake)

    trip_id = await _make_trip()
    try:
        opened = await client.post(f"/api/v1/trips/{trip_id}/debrief/open")
        assert opened.status_code == 200
        assert opened.json()["message"] == "How was the drive to the stadium?"

        from db.session import get_session_factory

        async with get_session_factory()() as session:
            messages = (
                await session.execute(
                    text("SELECT messages FROM trip_conversations WHERE trip_id = :id"),
                    {"id": trip_id},
                )
            ).scalar_one()
        assert messages[-1]["phase"] == "debrief"
        assert messages[-1]["role"] == "assistant"
    finally:
        await _cleanup(trip_ids=[trip_id])


@pytest.mark.integration
@requires_db
async def test_debrief_reply_writes_reward_and_applies_prefs(client):
    from api.main import app
    from api.routes.conversation import _llm

    fake = FakeLLMClient(
        opener="How did it go?",
        extraction={
            "reward_delta": 0.8,
            "preference_updates": {"prefer_scenic": True},
            "assistant_reply": "Glad it was pleasant!",
            "confidence": 0.9,
        },
    )
    app.dependency_overrides[_llm] = _override_llm(fake)

    reg = await client.post(
        "/api/v1/users/register", json={"email": f"pytest-{uuid.uuid4().hex[:12]}@test.gloway"}
    )
    user_id = reg.json()["user_id"]
    trip_id = await _make_trip(user_id)
    try:
        # Match the real frontend order: complete() always runs before the
        # debrief flow, which stamps a neutral default reward_value first —
        # the debrief reply below must overwrite it, not coincidentally be
        # the only writer.
        await client.post(f"/api/v1/trips/{trip_id}/complete", json={})
        await client.post(f"/api/v1/trips/{trip_id}/debrief/open")
        reply = await client.post(
            f"/api/v1/trips/{trip_id}/debrief/reply",
            json={"text": "the scenic route was lovely, no rush next time"},
        )
        body = reply.json()
        assert body["reward"] == 0.8
        assert body["preferences"]["prefer_scenic"] is True

        profile = await client.get(f"/api/v1/users/{user_id}/profile")
        assert profile.json()["preferences"]["prefer_scenic"] is True

        from db.session import get_session_factory

        async with get_session_factory()() as session:
            row = (
                await session.execute(
                    text("SELECT reward_value, completed_at, implicit_signals FROM trips"
                         " WHERE id = :id"),
                    {"id": trip_id},
                )
            ).one()
        reward_value, completed_at, signals = row
        assert reward_value == 0.8
        assert completed_at is not None
        assert signals["debrief"]["reward_delta"] == 0.8
        # No GPS trace on this trip, so fusion degrades to explicit-only —
        # the reward value is unchanged, provenance is now fusion-aware.
        assert signals["reward_source"] == "explicit_only"
    finally:
        await _cleanup(trip_ids=[trip_id], user_ids=[user_id])


@pytest.mark.integration
@requires_db
async def test_debrief_recomputes_implicit_signals_that_completion_missed(client):
    """The debrief heals a trip completed before its GPS trace landed.

    Production sequence, not a hypothetical: the client fired POST /complete
    while the drive's last GPS batch was still in flight, so completion saw no
    usable trace and wrote the neutral placeholder with no `implicit` block.
    By debrief time the trace is whole, so the reward must fuse behavioral and
    explicit signal rather than degrading to explicit-only.
    """
    from api.main import app
    from api.routes.conversation import _llm

    fake = FakeLLMClient(
        opener="How did it go?",
        extraction={
            "reward_delta": 0.8,
            "preference_updates": {},
            "assistant_reply": "Good to hear.",
            "confidence": 0.9,
        },
    )
    app.dependency_overrides[_llm] = _override_llm(fake)

    trip_id = await _make_trip()
    try:
        # 1. Completion wins the race against the final flush.
        await client.post(f"/api/v1/trips/{trip_id}/complete", json={})
        from db.session import get_session_factory

        async with get_session_factory()() as session:
            stale = (
                await session.execute(
                    text("SELECT implicit_signals FROM trips WHERE id = :id"), {"id": trip_id}
                )
            ).scalar_one()
        assert stale["reward_source"] == "default_neutral"
        assert "implicit" not in stale

        # 2. The tail batch arrives afterwards.
        await client.post(
            f"/api/v1/trips/{trip_id}/gps-update",
            json={
                "points": [
                    {"lat": 32.7205, "lon": -97.1295},
                    {"lat": 32.7220, "lon": -97.1280},
                ]
            },
        )

        # 3. The debrief recomputes rather than trusting the stale block.
        await client.post(f"/api/v1/trips/{trip_id}/debrief/open")
        await client.post(
            f"/api/v1/trips/{trip_id}/debrief/reply", json={"text": "that was great"}
        )

        async with get_session_factory()() as session:
            reward_value, signals = (
                await session.execute(
                    text("SELECT reward_value, implicit_signals FROM trips WHERE id = :id"),
                    {"id": trip_id},
                )
            ).one()
        assert "implicit" in signals, "debrief should have recomputed the missing block"
        assert signals["reward_source"] == "fused"
        # Confidence-weighted: implicit 0.0 @0.6 fused with explicit 0.8 @0.9.
        assert reward_value == pytest.approx((0.6 * 0.0 + 0.9 * 0.8) / 1.5)
    finally:
        await _cleanup(trip_ids=[trip_id])


@pytest.mark.integration
@requires_db
async def test_debrief_low_confidence_drops_prefs(client):
    from api.main import app
    from api.routes.conversation import _llm

    fake = FakeLLMClient(
        opener="How did it go?",
        extraction={
            "reward_delta": -0.3,
            "preference_updates": {"avoid_tolls": True},
            "assistant_reply": "Noted.",
            "confidence": 0.2,
        },
    )
    app.dependency_overrides[_llm] = _override_llm(fake)

    reg = await client.post(
        "/api/v1/users/register", json={"email": f"pytest-{uuid.uuid4().hex[:12]}@test.gloway"}
    )
    user_id = reg.json()["user_id"]
    trip_id = await _make_trip(user_id)
    try:
        await client.post(f"/api/v1/trips/{trip_id}/debrief/open")
        reply = await client.post(
            f"/api/v1/trips/{trip_id}/debrief/reply", json={"text": "meh, fine"}
        )
        assert reply.json()["preferences"] is None
        assert reply.json()["reward"] == -0.3  # reward still recorded
    finally:
        await _cleanup(trip_ids=[trip_id], user_ids=[user_id])


@pytest.mark.integration
@requires_db
async def test_debrief_llm_down_is_503(client):
    from api.main import app
    from api.routes.conversation import _llm

    app.dependency_overrides[_llm] = _override_llm(DownLLMClient())
    trip_id = await _make_trip()
    try:
        response = await client.post(f"/api/v1/trips/{trip_id}/debrief/open")
        assert response.status_code == 503
    finally:
        await _cleanup(trip_ids=[trip_id])


async def test_navigation_reply_answers_from_context():
    """In-drive informational query: the answer rides in assistant_reply and no
    actions fire, and the live nav context reaches the extractor prompt."""
    from ml.llm.conversation import interpret_navigation_reply

    fake = FakeLLMClient(extraction={
        "intent": None, "preference_updates": {},
        "assistant_reply": "About 4 minutes to Globe Life Field.", "confidence": 0.0,
    })
    result = await interpret_navigation_reply(
        fake, [], "how long until I arrive?",
        nav_context={
            "destLabel": "Globe Life Field", "progress": 0.6,
            "minutesRemaining": 4, "nextManeuver": "Turn left onto Collins St",
        },
    )
    assert result.assistant_reply == "About 4 minutes to Globe Life Field."
    assert result.add_stop is None and result.switch_to_route is None
    # Nav context was rendered into the prompt the model saw.
    assert "4 min" in fake.last_json_prompt
    assert "Globe Life Field" in fake.last_json_prompt
    assert "Collins St" in fake.last_json_prompt


async def test_navigation_reply_extracts_command():
    """In-drive command parity: "find gas" parses into an add_stop request."""
    from ml.llm.conversation import interpret_navigation_reply

    fake = FakeLLMClient(extraction={
        "intent": None, "preference_updates": {},
        "add_stop": {"category": "fuel", "query": None},
        "assistant_reply": "Looking for fuel.", "confidence": 0.9,
    })
    result = await interpret_navigation_reply(fake, [], "I need gas", nav_context={})
    assert result.add_stop is not None
    assert result.add_stop.category == "fuel"


@pytest.mark.integration
@requires_llm
async def test_real_provider_smoke():
    """One tiny real completion — proves the key, model id, and REST shape."""
    from ml.llm.factory import get_llm_client

    client = get_llm_client()
    try:
        text_out = await client.complete(
            system="Reply in under 8 words.",
            messages=[{"role": "user", "content": "Say ready."}],
            max_tokens=20,
        )
        assert text_out.strip()
    finally:
        await client.aclose()
