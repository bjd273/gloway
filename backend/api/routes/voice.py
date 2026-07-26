"""In-navigation voice WebSocket (Phase 2, Week 13-14).

The pre-trip conversation and post-trip debrief run over plain HTTP. This is
the missing piece: a persistent, stateful voice session held open for the whole
drive so the user can speak hands-free ("how long left?", "find gas on the
way", "take me home") and hear a spoken reply, with full command parity with
the pre-trip reply.

Transport is a real WebSocket, but STT stays clip-based (one Gemini
`transcribe` per utterance) and TTS stays browser-native on the client — there
is no streaming STT/TTS API in the current seam, and the socket's value here is
the persistent session + live nav context per utterance, not audio streaming.

Protocol (JSON frames both ways; audio is base64 inside one frame so mime and
nav context ride along atomically):

  client -> {"type": "utterance", "mime": "audio/webm", "audio_b64": "...",
             "nav": {destLabel, progress, minutesRemaining, nextManeuver},
             "routeOptions": [{index, minutes, selected}, ...]}
  server -> {"type": "transcript", "text": "..."}          # what we heard
  server -> {"type": "reply", "text": "...", "action": {...}}  # spoken + action
  server -> {"type": "error", "detail": "..."}             # recoverable; socket stays open

`action` mirrors the HTTP ReplyResponse shape exactly (snake_case), so the
frontend reuses the same reply-result parser and side-effect applier the
pre-trip conversation uses.
"""
from __future__ import annotations

import base64
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import func, select

from api.routes.conversation import StopOut, _find_stop, _latest_conversation, _now
from db.models import Trip, TripConversation, UserPreference
from db.session import get_session_factory
from ml.llm.base import LLMClient, LLMUnavailable
from ml.llm.conversation import interpret_navigation_reply
from ml.llm.factory import get_llm_client

router = APIRouter()

logger = logging.getLogger(__name__)

# One utterance's audio, base64-encoded, capped the same as the HTTP transcribe
# route (~5 MB raw ≈ 6.7 MB base64) so a bad frame can't buffer unbounded.
_MAX_AUDIO_B64 = 7 * 1024 * 1024


@router.websocket("/{trip_id}/voice")
async def voice_socket(websocket: WebSocket, trip_id: str):
    await websocket.accept()

    # One LLM client for the whole drive. If the provider is unconfigured,
    # close with the internal-error code (mirrors the HTTP 503 contract) — the
    # frontend treats a failed voice socket as "voice off", same as it treats
    # 503 conversation responses.
    try:
        llm: LLMClient = get_llm_client()
    except LLMUnavailable as exc:
        await websocket.close(code=1011, reason=str(exc)[:120])
        return

    try:
        while True:
            try:
                frame = await websocket.receive_json()
            except WebSocketDisconnect:
                break
            except ValueError:
                # Non-JSON / binary frame — ignore rather than tear down.
                continue

            if not isinstance(frame, dict) or frame.get("type") != "utterance":
                continue

            await _handle_utterance(websocket, llm, trip_id, frame)
    except WebSocketDisconnect:
        pass
    finally:
        await llm.aclose()


async def _handle_utterance(
    websocket: WebSocket, llm: LLMClient, trip_id: str, frame: dict
) -> None:
    audio_b64 = frame.get("audio_b64")
    mime = frame.get("mime") or "audio/webm"
    if not isinstance(audio_b64, str) or not audio_b64:
        await websocket.send_json({"type": "error", "detail": "no audio"})
        return
    if len(audio_b64) > _MAX_AUDIO_B64:
        await websocket.send_json({"type": "error", "detail": "audio too large"})
        return
    try:
        audio = base64.b64decode(audio_b64)
    except (ValueError, TypeError):
        await websocket.send_json({"type": "error", "detail": "audio not decodable"})
        return

    # 1. Speech -> text (reuses the same seam the HTTP /speech route uses).
    try:
        text = (await llm.transcribe(audio, str(mime).split(";")[0].strip())).strip()
    except LLMUnavailable as exc:
        await websocket.send_json({"type": "error", "detail": str(exc)})
        return

    await websocket.send_json({"type": "transcript", "text": text})
    if not text:
        return  # No speech heard — a normal outcome, nothing to interpret.

    nav = frame.get("nav") if isinstance(frame.get("nav"), dict) else {}
    route_options = frame.get("routeOptions") if isinstance(frame.get("routeOptions"), list) else []

    # 2 + 3. Load trip/convo state and interpret against live nav context.
    async with get_session_factory()() as db:
        trip = await db.get(Trip, _as_uuid(trip_id))
        if trip is None:
            await websocket.send_json({"type": "error", "detail": "trip not found"})
            return
        convo = await _latest_conversation(db, trip.id)

        try:
            result = await interpret_navigation_reply(
                llm,
                convo.messages if convo else [],
                text,
                nav_context=nav,
                route_options=route_options or None,
            )
        except LLMUnavailable as exc:
            await websocket.send_json({"type": "error", "detail": str(exc)})
            return

        # 4. Validate the switch index against what the client actually has drawn.
        switch_to_route = result.switch_to_route
        if switch_to_route is not None and not any(
            isinstance(opt, dict) and opt.get("index") == switch_to_route for opt in route_options
        ):
            switch_to_route = None

        # Resolve a requested stop to a concrete nearby place (reused helper).
        stop_out: StopOut | None = None
        ack = result.assistant_reply
        if result.add_stop is not None:
            place = await _find_stop(trip, result.add_stop)
            if place is not None:
                stop_out = StopOut(name=place.name or "a stop", lat=place.lat, lon=place.lon)
                ack = f"{ack} {stop_out.name} it is."
            else:
                ack = f"{ack} I couldn't find a good stop near here, sorry."

        # Persist durable preference updates (same as the pre-trip reply path).
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

        # 5. Append both turns, phase-tagged "navigation" (best-effort: a DB
        # error must never kill an in-progress drive).
        try:
            user_turn = {"role": "user", "content": text, "timestamp": _now(), "phase": "navigation"}
            asst_turn = {"role": "assistant", "content": ack, "timestamp": _now(), "phase": "navigation"}
            if convo is None:
                convo = TripConversation(
                    trip_id=trip.id, user_id=trip.user_id, messages=[user_turn, asst_turn]
                )
                db.add(convo)
            else:
                convo.messages = [*convo.messages, user_turn, asst_turn]
            await db.commit()
        except Exception:  # noqa: BLE001 — persistence is non-critical here
            logger.exception("failed to persist navigation voice turn for trip %s", trip_id)

    # 6. Spoken reply + the action for the client to apply live.
    action = {
        "message": ack,
        "intent": result.intent,
        "preferences": updated_prefs,
        "switch_to_route": switch_to_route,
        "stop": stop_out.model_dump() if stop_out else None,
        "stops_cleared": result.remove_stops,
        "set_destination": result.set_destination,
        "travel_mode": result.travel_mode,
    }
    await websocket.send_json({"type": "reply", "text": ack, "action": action})


def _as_uuid(trip_id: str):
    """Parse the path trip_id; a bad UUID just resolves to no trip (handled by
    the caller's None check) rather than raising inside the socket loop."""
    import uuid

    try:
        return uuid.UUID(trip_id)
    except ValueError:
        return None
