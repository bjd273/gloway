"""Constructs the configured LLMClient — the only place provider names appear.

Adding Claude later: write claude_client.py implementing LLMClient, add a
branch here, set LLM_PROVIDER=claude + ANTHROPIC_API_KEY in .env. Nothing
above this layer changes.
"""
from __future__ import annotations

from ml.llm.base import LLMClient, LLMUnavailable
from ml.llm.gemini_client import GeminiLLMClient


def get_llm_client() -> LLMClient:
    from config import settings

    if settings.llm_provider == "gemini":
        if not settings.gemini_api_key:
            raise LLMUnavailable("GEMINI_API_KEY not configured")
        return GeminiLLMClient(api_key=settings.gemini_api_key, model=settings.llm_model)
    raise LLMUnavailable(f"unknown llm_provider: {settings.llm_provider}")
