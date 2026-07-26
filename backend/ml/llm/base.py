"""Abstract LLM client — the provider seam for the conversation layer.

Same philosophy as mapdata.base.MapDataSource: task-level logic (prompts,
extraction schemas, confidence rules — see conversation.py) is written against
this interface only, and a provider swap (Gemini today, Claude later) is one
new class in this package plus a settings flip. Providers do exactly one
thing: chat completion.
"""
from __future__ import annotations

from abc import ABC, abstractmethod


class LLMUnavailable(Exception):
    """No provider configured, or the provider errored/timed out.

    API routes map this to 503; the frontend treats 503 as "conversation
    features off" and hides the UI rather than surfacing an error.
    """


class LLMClient(ABC):
    @abstractmethod
    async def complete(
        self,
        system: str,
        messages: list[dict],
        max_tokens: int = 256,
        json_mode: bool = False,
    ) -> str:
        """One chat completion.

        ``messages`` is [{"role": "user" | "assistant", "content": str}, ...].
        With ``json_mode`` the provider must constrain output to valid JSON.
        Raises LLMUnavailable on any transport/provider failure — callers
        never see provider-specific exceptions.
        """

    async def transcribe(self, audio: bytes, mime_type: str) -> str:
        """Speech-to-text for a short audio clip; empty string when no speech.

        Non-abstract on purpose: transcription is an optional capability, and
        providers (or test fakes) that only do chat shouldn't have to stub it.
        Default raises so routes surface the usual 503.
        """
        raise LLMUnavailable("provider does not support transcription")

    async def aclose(self) -> None:
        """Release transport resources; default no-op."""
