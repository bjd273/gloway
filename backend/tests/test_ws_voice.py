"""In-navigation voice WebSocket tests.

Rather than stand up a Starlette TestClient (sync, its own portal loop — awkward
inside this async DB suite), these drive the socket handler directly with a fake
WebSocket that feeds frames and captures replies, against real Postgres. That
exercises the whole path: transcribe -> interpret_navigation_reply -> stop
resolution -> persistence -> reply frame.
"""
import base64
import socket
import uuid

import pytest
from sqlalchemy import text

from fastapi import WebSocketDisconnect

from ml.llm.base import LLMClient


def _reachable(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


requires_db = pytest.mark.skipif(
    not _reachable("localhost", 5432), reason="requires live Postgres"
)


class NavFakeLLM(LLMClient):
    """Canned STT + extraction for the voice socket."""

    def __init__(self, transcript: str, extraction: dict):
        self._transcript = transcript
        self._extraction = extraction
        self.last_json_prompt: str | None = None

    async def complete(self, system, messages, max_tokens=256, json_mode=False):
        import json

        if json_mode:
            self.last_json_prompt = messages[-1]["content"]
            return json.dumps(self._extraction)
        return ""

    async def transcribe(self, audio: bytes, mime_type: str) -> str:
        return self._transcript


class FakeMapDataSource:
    """One nearby fuel stop for the corridor lookup."""

    def __init__(self):
        from mapdata.models import Place, PlaceCategory

        self.places = [
            Place(id="osm:node/9", name="QuikTrip", category=PlaceCategory.FUEL,
                  lat=32.735, lon=-97.11, source="osm"),
        ]

    async def get_places(self, category, bbox):
        return self.places

    async def search_addresses(self, query, limit=5):
        return []

    async def aclose(self):
        pass


class FakeWebSocket:
    """Feeds `incoming` frames to receive_json, then raises WebSocketDisconnect;
    records everything send_json/close emit."""

    def __init__(self, incoming: list):
        self._incoming = list(incoming)
        self.sent: list[dict] = []
        self.accepted = False
        self.closed: tuple[int, str] | None = None

    async def accept(self):
        self.accepted = True

    async def receive_json(self):
        if not self._incoming:
            raise WebSocketDisconnect(1000)
        return self._incoming.pop(0)

    async def send_json(self, data):
        self.sent.append(data)

    async def close(self, code=1000, reason=""):
        self.closed = (code, reason)


def _utterance_frame(nav: dict | None = None, route_options: list | None = None) -> dict:
    return {
        "type": "utterance",
        "mime": "audio/webm",
        "audio_b64": base64.b64encode(b"fake-audio-bytes").decode(),
        "nav": nav or {},
        "routeOptions": route_options or [],
    }


async def _make_trip() -> str:
    from db.session import get_session_factory

    async with get_session_factory()() as session:
        trip_id = (
            await session.execute(
                text(
                    "INSERT INTO trips (user_id, origin, destination, suggested_route, context)"
                    " VALUES (NULL, ST_GeogFromText('POINT(-97.13 32.72)'),"
                    " ST_GeogFromText('POINT(-97.09 32.75)'), '{}'::jsonb,"
                    " '{\"dest_label\": \"Globe Life Field\"}'::jsonb) RETURNING id"
                )
            )
        ).scalar_one()
        await session.commit()
    return str(trip_id)


async def _cleanup(trip_id: str):
    from db.session import get_session_factory

    async with get_session_factory()() as session:
        await session.execute(
            text("DELETE FROM trip_conversations WHERE trip_id = :id"), {"id": trip_id}
        )
        await session.execute(text("DELETE FROM trips WHERE id = :id"), {"id": trip_id})
        await session.commit()


@requires_db
async def test_voice_socket_answers_and_persists(monkeypatch):
    from api.routes import voice

    fake_llm = NavFakeLLM(
        transcript="how long until I arrive?",
        extraction={
            "intent": None, "preference_updates": {},
            "assistant_reply": "About 4 minutes to Globe Life Field.", "confidence": 0.0,
        },
    )
    monkeypatch.setattr(voice, "get_llm_client", lambda: fake_llm)

    trip_id = await _make_trip()
    ws = FakeWebSocket([
        _utterance_frame(nav={
            "destLabel": "Globe Life Field", "progress": 0.6,
            "minutesRemaining": 4, "nextManeuver": "Turn left",
        }),
    ])
    try:
        await voice.voice_socket(ws, trip_id)

        assert ws.accepted
        # transcript frame, then reply frame.
        assert ws.sent[0] == {"type": "transcript", "text": "how long until I arrive?"}
        reply = ws.sent[1]
        assert reply["type"] == "reply"
        assert reply["text"] == "About 4 minutes to Globe Life Field."
        action = reply["action"]
        assert action["stop"] is None and action["switch_to_route"] is None
        assert action["set_destination"] is None and action["travel_mode"] is None

        # Both turns persisted, phase-tagged "navigation".
        from db.session import get_session_factory

        async with get_session_factory()() as session:
            messages = (
                await session.execute(
                    text("SELECT messages FROM trip_conversations WHERE trip_id = :id"),
                    {"id": trip_id},
                )
            ).scalar_one()
        assert [m["role"] for m in messages] == ["user", "assistant"]
        assert all(m["phase"] == "navigation" for m in messages)
    finally:
        await _cleanup(trip_id)


@requires_db
async def test_voice_socket_resolves_stop_command(monkeypatch):
    from api.routes import conversation, voice

    fake_llm = NavFakeLLM(
        transcript="find me some gas",
        extraction={
            "intent": None, "preference_updates": {},
            "add_stop": {"category": "fuel", "query": None},
            "assistant_reply": "On it.", "confidence": 0.9,
        },
    )
    monkeypatch.setattr(voice, "get_llm_client", lambda: fake_llm)
    monkeypatch.setattr(conversation, "get_map_data_source", FakeMapDataSource)

    trip_id = await _make_trip()
    ws = FakeWebSocket([_utterance_frame()])
    try:
        await voice.voice_socket(ws, trip_id)
        reply = ws.sent[1]
        assert reply["action"]["stop"] == {"name": "QuikTrip", "lat": 32.735, "lon": -97.11}
        assert "QuikTrip" in reply["text"]
    finally:
        await _cleanup(trip_id)


@requires_db
async def test_voice_socket_empty_transcript_sends_no_reply(monkeypatch):
    from api.routes import voice

    fake_llm = NavFakeLLM(transcript="", extraction={})
    monkeypatch.setattr(voice, "get_llm_client", lambda: fake_llm)

    trip_id = await _make_trip()
    ws = FakeWebSocket([_utterance_frame()])
    try:
        await voice.voice_socket(ws, trip_id)
        # Silence: a transcript frame (empty) and nothing else.
        assert ws.sent == [{"type": "transcript", "text": ""}]
    finally:
        await _cleanup(trip_id)
