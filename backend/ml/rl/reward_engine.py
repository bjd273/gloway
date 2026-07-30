"""Trip reward fusion (Week 23-24).

Each completed trip yields up to two reward signals:
- implicit: behavioral, from the GPS trace (services.signal_processor) —
  always available for a driven trip, but coarse.
- explicit: the debrief's LLM-interpreted sentiment (reward_delta) — rich but
  rare, and only present when the user actually talks about the trip.

`compute_final_reward` fuses them into the single `trips.reward_value` the RL
loop replays. Fusion is numeric (confidence-weighted), NOT a second LLM call:
the debrief already ran the language model over the user's words, so asking it
again to "reason about the feedback" would just duplicate that interpretation
and spend a second token budget. An LLM-fusion variant (the roadmap's
REWARD_EXTRACTOR_PROMPT, run through the ml.llm.LLMClient seam — Gemini here,
not the sample's hardcoded Claude) could be added if we ever want the richer
per-preference signals it emits, but nothing consumes those today.
"""
from __future__ import annotations

# Implicit signals are reliable but low-information — the roadmap pins their
# standalone confidence here.
_IMPLICIT_CONFIDENCE = 0.6

# Kept for reference / a future LLM-fusion path; unused by the numeric fusion.
REWARD_EXTRACTOR_PROMPT = """You are a reward signal extractor for a routing AI system.
Given trip data and user feedback, compute a reward value from -1.0 to +1.0.
Respond ONLY with a JSON object: {"reward": float, "primary_signal": string,
"preference_signals": {"road_type_weights": {}, "time_weights": {}, "avoid_patterns": []},
"confidence": float}."""


def _clamp(value: float) -> float:
    return max(-1.0, min(1.0, value))


def compute_final_reward(implicit: dict | None, explicit: dict | None) -> dict:
    """Fuse implicit (GPS) and explicit (debrief) rewards into one value.

    ``implicit``  — a compute_implicit_signals() dict (uses ``implicit_reward``).
    ``explicit``  — ``{"reward_delta": float, "confidence": float}`` from the debrief.
    Either may be None/empty; fusion degrades to whichever exists.

    Returns ``{reward, source, confidence, components}`` where source is one of
    fused | implicit_only | explicit_only | neutral.
    """
    has_implicit = bool(implicit) and implicit.get("implicit_reward") is not None
    has_explicit = bool(explicit) and explicit.get("reward_delta") is not None

    r_i = float(implicit["implicit_reward"]) if has_implicit else None
    r_e = float(explicit["reward_delta"]) if has_explicit else None
    c_e = float(explicit.get("confidence", 0.0)) if has_explicit else 0.0

    # A zero-confidence explicit signal contributes literally nothing to the
    # weighted average, so reporting it as "fused" overstates the result — the
    # first real drive produced reward == implicit exactly while claiming to be
    # fused. Treat zero weight as absent for provenance, while keeping the raw
    # value in `components` so nothing is hidden.
    if has_explicit and c_e <= 0.0:
        has_explicit = False

    if has_implicit and has_explicit:
        w_i, w_e = _IMPLICIT_CONFIDENCE, c_e
        total = w_i + w_e
        reward = (w_i * r_i + w_e * r_e) / total
        source, confidence = "fused", max(_IMPLICIT_CONFIDENCE, c_e)
    elif has_implicit:
        reward, source, confidence = r_i, "implicit_only", _IMPLICIT_CONFIDENCE
    elif has_explicit:
        reward, source, confidence = r_e, "explicit_only", c_e
    else:
        reward, source, confidence = 0.0, "neutral", 0.0

    return {
        "reward": _clamp(reward),
        "source": source,
        "confidence": confidence,
        "components": {"implicit": r_i, "explicit": r_e},
    }
