"""Route scorer + ranker tests — pure numpy, no DB, no torch, no network."""
from __future__ import annotations

import numpy as np
import pytest

from ml.rl.route_scorer import (
    MIN_TRAINING_SAMPLES,
    NotEnoughData,
    RouteScorer,
    train_route_scorer,
)
from ml.rl.state import FEATURE_NAMES, SCORING_FEATURE_DIM, build_scoring_features
from routing.route_ranker import RouteRanker
from routing.valhalla_client import UserRoutingPrefs


def _route(time_s=600.0, length_mi=5.0, highway=False, toll=False, maneuvers=10) -> dict:
    return {
        "summary": {
            "time": time_s, "length": length_mi,
            "has_highway": highway, "has_toll": toll,
        },
        "legs": [{"maneuvers": [{"instruction": "go"} for _ in range(maneuvers)]}],
    }


# --- features ------------------------------------------------------------


def test_feature_vector_shape_and_names_agree():
    vector = build_scoring_features(_route(), UserRoutingPrefs(), {})
    assert vector.shape == (SCORING_FEATURE_DIM,)
    assert len(FEATURE_NAMES) == SCORING_FEATURE_DIM
    assert np.isfinite(vector).all()


def test_conflict_features_encode_preference_route_interaction():
    """The interaction terms are what let a linear model express 'this user
    dislikes highways AND this route uses one'."""
    idx = FEATURE_NAMES.index("conflict_highway")
    averse = UserRoutingPrefs(avoid_highways=1.0)

    assert build_scoring_features(_route(highway=True), averse, {})[idx] == 1.0
    # Same route, indifferent user -> no conflict.
    assert build_scoring_features(_route(highway=True), UserRoutingPrefs(), {})[idx] == 0.0
    # Highway-averse user, non-highway route -> no conflict.
    assert build_scoring_features(_route(highway=False), averse, {})[idx] == 0.0


def test_intent_and_mode_are_one_hot_with_fallbacks():
    vector = build_scoring_features(_route(), UserRoutingPrefs(), {"declared_intent": "hurry"})
    assert vector[FEATURE_NAMES.index("intent_hurry")] == 1.0
    assert vector[FEATURE_NAMES.index("intent_none")] == 0.0

    # Unknown intent and absent mode fall back to none/auto rather than an
    # all-zero block (a silently dead one-hot).
    vector = build_scoring_features(_route(), UserRoutingPrefs(), {"declared_intent": "vibes"})
    assert vector[FEATURE_NAMES.index("intent_none")] == 1.0
    assert vector[FEATURE_NAMES.index("mode_auto")] == 1.0


def test_malformed_route_degrades_to_zeros_instead_of_raising():
    vector = build_scoring_features({}, UserRoutingPrefs(), {})
    assert vector.shape == (SCORING_FEATURE_DIM,)
    assert np.isfinite(vector).all()


# --- training ------------------------------------------------------------


def _synthetic_dataset(n=60, seed=0):
    """Rewards driven by a known rule: highway-averse users dislike highways."""
    rng = np.random.default_rng(seed)
    features, rewards = [], []
    for _ in range(n):
        averse = bool(rng.integers(2))
        highway = bool(rng.integers(2))
        prefs = UserRoutingPrefs(avoid_highways=1.0 if averse else 0.0)
        features.append(build_scoring_features(_route(highway=highway), prefs, {}))
        rewards.append(-0.8 if (averse and highway) else 0.6)
    return np.vstack(features), np.asarray(rewards)


def test_training_refuses_below_the_sample_floor():
    features, rewards = _synthetic_dataset(n=MIN_TRAINING_SAMPLES - 1)
    with pytest.raises(NotEnoughData):
        train_route_scorer(features, rewards)


def test_scorer_learns_the_planted_preference_rule():
    features, rewards = _synthetic_dataset(n=120)
    scorer = train_route_scorer(features, rewards)

    averse = UserRoutingPrefs(avoid_highways=1.0)
    bad = scorer.score_route(_route(highway=True), averse)
    good = scorer.score_route(_route(highway=False), averse)
    assert good > bad, "highway-averse user should score the non-highway route higher"

    # An indifferent user shouldn't inherit that penalty.
    indifferent = UserRoutingPrefs()
    assert scorer.score_route(_route(highway=True), indifferent) > bad


def test_constant_feature_columns_do_not_produce_nan():
    """Every logged trip having mode=auto gives a zero-variance column; the
    standardizer must not divide by it."""
    features, rewards = _synthetic_dataset(n=60)
    scorer = train_route_scorer(features, rewards)
    assert np.isfinite(scorer.coefficients).all()
    assert np.isfinite(scorer.predict(features[0]))


def test_save_load_roundtrip_preserves_predictions(tmp_path):
    features, rewards = _synthetic_dataset(n=60)
    scorer = train_route_scorer(features, rewards)
    path = scorer.save(tmp_path / "scorer.npz")

    reloaded = RouteScorer.load(path)
    assert reloaded.n_samples == scorer.n_samples
    np.testing.assert_allclose(
        reloaded.predict_batch(features), scorer.predict_batch(features), rtol=1e-9
    )


def test_load_rejects_a_stale_feature_layout(tmp_path):
    """Coefficients are positional — a model trained on a different layout must
    be refused, not silently used to rank."""
    path = tmp_path / "stale.npz"
    np.savez(
        path,
        coefficients=np.zeros(SCORING_FEATURE_DIM), intercept=0.0,
        mean=np.zeros(SCORING_FEATURE_DIM), scale=np.ones(SCORING_FEATURE_DIM),
        n_samples=99, feature_dim=SCORING_FEATURE_DIM + 3,
    )
    with pytest.raises(ValueError, match="retrain"):
        RouteScorer.load(path)


# --- ranker --------------------------------------------------------------


def test_ranker_without_a_model_keeps_valhalla_order():
    ranker = RouteRanker(None)
    result = ranker.rank([_route(), _route(time_s=900)], UserRoutingPrefs(), {})
    assert result.recommended_index == 0
    assert result.personalization_active is False
    assert result.scores is None


def test_ranker_from_missing_path_falls_back_silently(tmp_path):
    ranker = RouteRanker.from_path(tmp_path / "does-not-exist.npz")
    assert ranker.is_personalized is False
    assert ranker.rank([_route(), _route()], UserRoutingPrefs(), {}).recommended_index == 0


def test_ranker_from_corrupt_model_falls_back_silently(tmp_path):
    corrupt = tmp_path / "corrupt.npz"
    corrupt.write_bytes(b"not an npz file")
    ranker = RouteRanker.from_path(corrupt)
    assert ranker.is_personalized is False


def test_trained_ranker_can_override_valhallas_primary():
    """The whole point: a highway-averse user gets recommended the alternate."""
    features, rewards = _synthetic_dataset(n=120)
    ranker = RouteRanker(train_route_scorer(features, rewards))

    # Valhalla's primary (index 0) is the highway route; the alternate isn't.
    candidates = [_route(highway=True), _route(highway=False)]
    result = ranker.rank(candidates, UserRoutingPrefs(avoid_highways=1.0), {})

    assert result.personalization_active is True
    assert result.recommended_index == 1
    assert result.scores is not None and len(result.scores) == 2


def test_single_candidate_is_never_scored():
    features, rewards = _synthetic_dataset(n=60)
    ranker = RouteRanker(train_route_scorer(features, rewards))
    result = ranker.rank([_route()], UserRoutingPrefs(), {})
    assert result.recommended_index == 0
    assert result.personalization_active is False
