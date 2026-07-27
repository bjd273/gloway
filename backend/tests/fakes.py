"""Fakes shared across test modules.

The LLM client fakes live here rather than in one test file because more than
one suite needs them (the conversation tests and the full-journey test), and
importing across test modules is worse than a small shared module. Fixtures
still belong in conftest.py — these are plain classes, deliberately not
fixtures, so a test can construct one with the exact canned payload it needs.
"""
from __future__ import annotations

import json

from ml.llm.base import LLMClient, LLMUnavailable


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


class DownLLMClient(LLMClient):
    async def complete(self, system, messages, max_tokens=256, json_mode=False):
        raise LLMUnavailable("provider down")


def override_llm(fake: LLMClient):
    """Build a FastAPI dependency override yielding `fake` as the LLM client."""

    async def _dep():
        yield fake

    return _dep
