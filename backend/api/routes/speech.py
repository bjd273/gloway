"""Speech-to-text endpoint — the server-side fallback for voice input.

The frontend prefers the browser's Web Speech API (instant, free), but that
engine can silently return nothing even on Chrome. When it does, the client
uploads the raw recorded audio here and we transcribe it through the same LLM
seam the conversation uses. Trip-agnostic: both the pre-journey conversation
and the post-trip debrief share it.

Upload is the raw request body (Content-Type carries the audio mime) — one
binary field, so multipart would only add a dependency and base64 JSON would
only add bloat. LLMUnavailable maps to 503, same as every conversation route.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from api.routes.conversation import _llm
from ml.llm.base import LLMClient, LLMUnavailable

router = APIRouter()

# ~30s of opus is roughly 120 KB; 5 MB is generous headroom for any format
# a MediaRecorder produces without letting arbitrary uploads through.
MAX_AUDIO_BYTES = 5 * 1024 * 1024


class TranscribeResponse(BaseModel):
    text: str  # empty string = the model heard no speech (a valid outcome)


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe_audio(
    request: Request,
    llm: LLMClient = Depends(_llm),
) -> TranscribeResponse:
    body = await request.body()
    if not body:
        raise HTTPException(status_code=422, detail="no audio data")
    if len(body) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="audio too large")

    # Strip codec params ("audio/webm;codecs=opus" -> "audio/webm") — the
    # provider only wants the base type.
    content_type = request.headers.get("content-type") or ""
    mime = content_type.split(";")[0].strip().lower()
    if not mime.startswith("audio/"):
        raise HTTPException(status_code=415, detail="expected an audio content type")

    try:
        text = await llm.transcribe(body, mime)
    except LLMUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return TranscribeResponse(text=text.strip())
