"""Speech transcription endpoint tests.

The LLM dependency is overridden with a fake, so these exercise the full
request-validation -> transcribe path with no DB, network, or token spend.
"""
import httpx
import pytest

from api.routes.conversation import _llm
from api.routes.speech import MAX_AUDIO_BYTES
from ml.llm.base import LLMClient, LLMUnavailable


class FakeTranscribingLLMClient(LLMClient):
    """Returns a canned transcript and records what mime type it was given."""

    def __init__(self, text: str = "hello world"):
        self.text = text
        self.last_mime: str | None = None

    async def complete(self, system, messages, max_tokens=256, json_mode=False):
        raise AssertionError("transcribe endpoint must not call complete()")

    async def transcribe(self, audio: bytes, mime_type: str) -> str:
        self.last_mime = mime_type
        return self.text


class ChatOnlyLLMClient(LLMClient):
    """Inherits the base transcribe(), which raises LLMUnavailable."""

    async def complete(self, system, messages, max_tokens=256, json_mode=False):
        return "chat works"


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


async def test_transcribe_returns_text(client):
    from api.main import app

    fake = FakeTranscribingLLMClient()
    app.dependency_overrides[_llm] = _override_llm(fake)
    response = await client.post(
        "/api/v1/speech/transcribe",
        content=b"\x1aE\xdf\xa3fake-webm-bytes",
        headers={"Content-Type": "audio/webm;codecs=opus"},
    )
    assert response.status_code == 200
    assert response.json() == {"text": "hello world"}
    # Codec params must be stripped before reaching the provider.
    assert fake.last_mime == "audio/webm"


async def test_provider_without_transcription_is_503(client):
    from api.main import app

    app.dependency_overrides[_llm] = _override_llm(ChatOnlyLLMClient())
    response = await client.post(
        "/api/v1/speech/transcribe",
        content=b"audio-bytes",
        headers={"Content-Type": "audio/wav"},
    )
    assert response.status_code == 503


async def test_empty_body_is_422(client):
    from api.main import app

    app.dependency_overrides[_llm] = _override_llm(FakeTranscribingLLMClient())
    response = await client.post(
        "/api/v1/speech/transcribe",
        headers={"Content-Type": "audio/webm"},
    )
    assert response.status_code == 422


async def test_oversized_body_is_413(client):
    from api.main import app

    app.dependency_overrides[_llm] = _override_llm(FakeTranscribingLLMClient())
    response = await client.post(
        "/api/v1/speech/transcribe",
        content=b"0" * (MAX_AUDIO_BYTES + 1),
        headers={"Content-Type": "audio/webm"},
    )
    assert response.status_code == 413


async def test_non_audio_content_type_is_415(client):
    from api.main import app

    app.dependency_overrides[_llm] = _override_llm(FakeTranscribingLLMClient())
    response = await client.post(
        "/api/v1/speech/transcribe",
        content=b"not audio",
        headers={"Content-Type": "text/plain"},
    )
    assert response.status_code == 415
