"""Numeric reward-fusion tests. Pure function, no mocks."""
import pytest

from ml.rl.reward_engine import compute_final_reward


def test_explicit_only_preserves_debrief_reward():
    fused = compute_final_reward(None, {"reward_delta": 0.8, "confidence": 0.9})
    assert fused["reward"] == pytest.approx(0.8)
    assert fused["source"] == "explicit_only"


def test_implicit_only():
    fused = compute_final_reward({"implicit_reward": 0.4}, None)
    assert fused["reward"] == pytest.approx(0.4)
    assert fused["source"] == "implicit_only"
    assert fused["confidence"] == pytest.approx(0.6)


def test_neither_is_neutral():
    fused = compute_final_reward(None, None)
    assert fused["reward"] == 0.0
    assert fused["source"] == "neutral"


def test_fused_blends_between_the_two():
    fused = compute_final_reward(
        {"implicit_reward": -0.5}, {"reward_delta": 0.9, "confidence": 0.6}
    )
    assert fused["source"] == "fused"
    # Equal weights (0.6 each) -> midpoint 0.2.
    assert fused["reward"] == pytest.approx(0.2)
    assert fused["components"] == {"implicit": -0.5, "explicit": 0.9}


def test_higher_explicit_confidence_pulls_toward_explicit():
    low = compute_final_reward({"implicit_reward": -0.5}, {"reward_delta": 1.0, "confidence": 0.2})
    high = compute_final_reward({"implicit_reward": -0.5}, {"reward_delta": 1.0, "confidence": 1.0})
    assert high["reward"] > low["reward"]


def test_reward_is_clamped():
    fused = compute_final_reward({"implicit_reward": 1.0}, {"reward_delta": 1.0, "confidence": 5.0})
    assert -1.0 <= fused["reward"] <= 1.0


def test_empty_implicit_dict_treated_as_absent():
    fused = compute_final_reward({}, {"reward_delta": 0.5, "confidence": 0.8})
    assert fused["source"] == "explicit_only"


def test_zero_confidence_explicit_is_not_reported_as_fused():
    """Regression from the first real drive.

    The rider said "Good, but I came through UT Arlington" — a clear opinion
    that implied no durable preference, so the extractor's `confidence` (which
    scores preference_updates) was 0.0. That zero became the fusion weight, so
    the sentiment contributed nothing, yet the result claimed to be `fused` and
    the stored reward was the implicit value to the last decimal.
    """
    result = compute_final_reward(
        {"implicit_reward": -0.823}, {"reward_delta": 0.3, "confidence": 0.0}
    )
    assert result["source"] == "implicit_only"
    assert result["reward"] == pytest.approx(-0.823)
    # Nothing is hidden: the discarded value is still visible.
    assert result["components"]["explicit"] == 0.3


def test_zero_confidence_explicit_alone_is_neutral_not_explicit_only():
    result = compute_final_reward(None, {"reward_delta": 0.5, "confidence": 0.0})
    assert result["source"] == "neutral"
    assert result["reward"] == 0.0
    assert result["components"]["explicit"] == 0.5


def test_real_reward_confidence_lets_sentiment_move_the_reward():
    """With the confidences separated, the same drive's feedback counts."""
    discarded = compute_final_reward(
        {"implicit_reward": -0.823}, {"reward_delta": 0.3, "confidence": 0.0}
    )
    counted = compute_final_reward(
        {"implicit_reward": -0.823}, {"reward_delta": 0.3, "confidence": 0.7}
    )
    assert counted["source"] == "fused"
    assert counted["reward"] > discarded["reward"]
