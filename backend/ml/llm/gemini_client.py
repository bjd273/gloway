"""Gemini-backed LLMClient via the REST generateContent endpoint.

Plain httpx, no SDK — mirrors how mapdata/osm_source.py talks to providers.
Model id lives in settings.llm_model (verified against this key's ListModels
at integration time: gemini-3.1-flash-lite). Gemini's roles are "user"/"model"
rather than "user"/"assistant"; translation happens here so callers speak the
neutral vocabulary defined in base.py.
"""
from __future__ import annotations

import base64

import httpx

from ml.llm.base import LLMClient, LLMUnavailable

_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

_TRANSCRIBE_INSTRUCTION = (
    "Transcribe the spoken words in this audio exactly as said. "
    "Return only the verbatim transcript text, with no commentary, labels, "
    "or punctuation beyond what was spoken. If there is no speech, return "
    "an empty response."
)


class GeminiLLMClient(LLMClient):
    def __init__(
        self,
        api_key: str,
        model: str,
        client: httpx.AsyncClient | None = None,
        timeout: float = 15.0,
    ):
        self._api_key = api_key
        self._model = model
        self._client = client or httpx.AsyncClient(timeout=timeout)
        self._owns_client = client is None

    async def complete(
        self,
        system: str,
        messages: list[dict],
        max_tokens: int = 256,
        json_mode: bool = False,
    ) -> str:
        contents = [
            {
                "role": "model" if m["role"] == "assistant" else "user",
                "parts": [{"text": m["content"]}],
            }
            for m in messages
        ]
        payload: dict = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": contents,
            "generationConfig": {"maxOutputTokens": max_tokens},
        }
        if json_mode:
            payload["generationConfig"]["responseMimeType"] = "application/json"

        try:
            response = await self._client.post(
                f"{_BASE_URL}/models/{self._model}:generateContent",
                params={"key": self._api_key},
                json=payload,
            )
            response.raise_for_status()
            data = response.json()
            return data["candidates"][0]["content"]["parts"][0]["text"]
        except (httpx.HTTPError, KeyError, IndexError, ValueError) as exc:
            raise LLMUnavailable(f"gemini completion failed: {exc}") from exc

    async def transcribe(self, audio: bytes, mime_type: str) -> str:
        """STT via generateContent with inline audio.

        Gemini's documented audio types are wav/mp3/aiff/aac/ogg/flac.
        Chrome's MediaRecorder produces audio/webm (opus inside), which the
        API usually accepts anyway — but if it 400s, one retry relabeled as
        audio/ogg gets the same opus payload through under a documented type.
        """
        try:
            data = await self._transcribe_once(audio, mime_type)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 400 and mime_type == "audio/webm":
                try:
                    data = await self._transcribe_once(audio, "audio/ogg")
                except (httpx.HTTPError, ValueError) as retry_exc:
                    raise LLMUnavailable(
                        f"gemini transcription failed: {retry_exc}"
                    ) from retry_exc
            else:
                raise LLMUnavailable(f"gemini transcription failed: {exc}") from exc
        except (httpx.HTTPError, ValueError) as exc:
            raise LLMUnavailable(f"gemini transcription failed: {exc}") from exc

        # A silent clip can come back with no candidates/parts at all — that's
        # "no speech", not an error, so parse defensively instead of raising.
        candidates = data.get("candidates") or []
        if not candidates:
            return ""
        parts = (candidates[0].get("content") or {}).get("parts") or []
        return "".join(part.get("text", "") for part in parts).strip()

    async def _transcribe_once(self, audio: bytes, mime_type: str) -> dict:
        payload = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {
                            "inlineData": {
                                "mimeType": mime_type,
                                "data": base64.b64encode(audio).decode(),
                            }
                        },
                        {"text": _TRANSCRIBE_INSTRUCTION},
                    ],
                }
            ],
            "generationConfig": {"maxOutputTokens": 512, "temperature": 0},
        }
        response = await self._client.post(
            f"{_BASE_URL}/models/{self._model}:generateContent",
            params={"key": self._api_key},
            json=payload,
        )
        response.raise_for_status()
        return response.json()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()
