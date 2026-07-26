"""Supervised route scorer — predicts a trip's reward from its features.

This is the model that actually personalizes routing (Week 27-28). It learns
`features -> reward` from logged trips: every completed trip already carries a
fused implicit+explicit `trips.reward_value` (services/signal_processor.py +
ml/rl/reward_engine.py), which is precisely the label "how good was this route
for this user". Ranking Valhalla's candidates is then a one-shot supervised
prediction, not a sequential decision — see `state.py` for why the PPO policy
is the wrong tool and is deliberately not used here.

**Why ridge regression and not a neural net.** The realistic near-term dataset
is tens to low-hundreds of trips against 20 features. An MLP in that regime
memorizes rather than generalizes, and its failure is invisible — it reports a
low training loss while ranking arbitrarily. Ridge is the honest fit:

- closed-form, so there is no training loop, no learning rate, no seed, and no
  silent non-convergence;
- L2-regularized, which is what keeps n≈30 from producing wild coefficients;
- the interaction features in `state.py` (conflict_highway, ...) already encode
  the products a linear model cannot discover on its own, so linear capacity is
  genuinely sufficient here;
- coefficients are directly readable — `explain()` tells you *why* a route won,
  which matters a lot while the signal is still being validated;
- pure numpy, so **serving never needs torch**. torch lives in optional poetry
  groups (`gnn`/`rl`); the /route endpoint must keep working without them.

`fit`/`predict`/`save`/`load` is the seam: swapping in a gradient-boosted or
neural scorer later means one new class, with `RouteRanker` untouched.

Features are standardized before the ridge solve because the raw columns live
on wildly different scales (time_hours ~0.2 vs one-hot 0/1); without it a single
penalty term would regularize them unequally. Mean/scale are persisted with the
weights so serving applies the identical transform.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from ml.rl.state import FEATURE_NAMES, SCORING_FEATURE_DIM, build_scoring_features

# Below this many labelled trips the fit is noise; `train_route_scorer` refuses
# to produce a model rather than shipping one that ranks arbitrarily. The
# ranker's deterministic fallback (Valhalla's own order) is strictly better
# than a model fit on a handful of points.
MIN_TRAINING_SAMPLES = 30

# Ridge penalty. Deliberately strong: with n in the tens, shrinking hard toward
# the mean keeps predictions conservative, so early personalization nudges the
# ranking rather than overturning Valhalla's ordering on one noisy trip.
DEFAULT_ALPHA = 1.0

DEFAULT_MODEL_PATH = Path(__file__).resolve().parents[2] / "models" / "route_scorer.npz"


class NotEnoughData(RuntimeError):
    """Raised when a fit is attempted below MIN_TRAINING_SAMPLES."""


class RouteScorer:
    """Ridge model over `state.build_scoring_features` vectors.

    Predicts a scalar in roughly [-1, 1] (the reward range). Higher is better.
    """

    def __init__(
        self,
        coefficients: np.ndarray,
        intercept: float,
        mean: np.ndarray,
        scale: np.ndarray,
        n_samples: int = 0,
    ):
        self.coefficients = np.asarray(coefficients, dtype=np.float64)
        self.intercept = float(intercept)
        self.mean = np.asarray(mean, dtype=np.float64)
        self.scale = np.asarray(scale, dtype=np.float64)
        self.n_samples = int(n_samples)
        if self.coefficients.shape != (SCORING_FEATURE_DIM,):
            raise ValueError(
                f"expected {SCORING_FEATURE_DIM} coefficients, got {self.coefficients.shape}"
            )

    # --- inference -------------------------------------------------------

    def predict(self, features: np.ndarray) -> float:
        """Predicted reward for one feature vector."""
        return float(self.predict_batch(np.asarray(features, dtype=np.float64)[None, :])[0])

    def predict_batch(self, features: np.ndarray) -> np.ndarray:
        standardized = (np.asarray(features, dtype=np.float64) - self.mean) / self.scale
        predictions = standardized @ self.coefficients + self.intercept
        # Never let a malformed route propagate NaN into the ranking.
        return np.nan_to_num(predictions, nan=0.0, posinf=0.0, neginf=0.0)

    def score_route(self, route: dict, prefs, context: dict | None = None) -> float:
        return self.predict(build_scoring_features(route, prefs, context))

    def explain(self, features: np.ndarray, top_k: int = 5) -> list[tuple[str, float]]:
        """The `top_k` features contributing most to this prediction, as
        (name, signed contribution). Useful for sanity-checking that the model
        learned something sensible rather than latching onto noise."""
        standardized = (np.asarray(features, dtype=np.float64) - self.mean) / self.scale
        contributions = standardized * self.coefficients
        order = np.argsort(np.abs(contributions))[::-1][:top_k]
        return [(FEATURE_NAMES[i], float(contributions[i])) for i in order]

    # --- persistence -----------------------------------------------------

    def save(self, path: str | Path = DEFAULT_MODEL_PATH) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez(
            path,
            coefficients=self.coefficients,
            intercept=self.intercept,
            mean=self.mean,
            scale=self.scale,
            n_samples=self.n_samples,
            feature_dim=SCORING_FEATURE_DIM,
        )
        return path

    @classmethod
    def load(cls, path: str | Path = DEFAULT_MODEL_PATH) -> "RouteScorer":
        with np.load(Path(path)) as data:
            stored_dim = int(data["feature_dim"]) if "feature_dim" in data else None
            if stored_dim is not None and stored_dim != SCORING_FEATURE_DIM:
                # The feature layout is positional; a model trained against a
                # different one would score nonsense. Refuse it loudly.
                raise ValueError(
                    f"model was trained with {stored_dim} features, code expects "
                    f"{SCORING_FEATURE_DIM} — retrain with scripts/train_route_scorer.py"
                )
            return cls(
                coefficients=data["coefficients"],
                intercept=float(data["intercept"]),
                mean=data["mean"],
                scale=data["scale"],
                n_samples=int(data["n_samples"]) if "n_samples" in data else 0,
            )


def train_route_scorer(
    features: np.ndarray,
    rewards: np.ndarray,
    alpha: float = DEFAULT_ALPHA,
    min_samples: int = MIN_TRAINING_SAMPLES,
) -> RouteScorer:
    """Closed-form ridge fit of reward on standardized features.

    Raises `NotEnoughData` below `min_samples` — callers should keep the
    deterministic ranking rather than deploy an under-determined model.
    """
    features = np.asarray(features, dtype=np.float64)
    rewards = np.asarray(rewards, dtype=np.float64).ravel()

    if features.ndim != 2 or features.shape[1] != SCORING_FEATURE_DIM:
        raise ValueError(f"features must be (n, {SCORING_FEATURE_DIM}), got {features.shape}")
    if features.shape[0] != rewards.shape[0]:
        raise ValueError("features and rewards must have the same number of rows")
    if features.shape[0] < min_samples:
        raise NotEnoughData(
            f"need at least {min_samples} labelled trips to fit a scorer, got "
            f"{features.shape[0]}. Keep using the deterministic ranking until then."
        )

    mean = features.mean(axis=0)
    scale = features.std(axis=0)
    # Constant columns (e.g. every logged trip was mode=auto) have zero variance;
    # dividing would produce inf/NaN. Setting scale to 1 makes the standardized
    # column all-zero, so the feature simply contributes nothing to this fit.
    scale = np.where(scale > 1e-8, scale, 1.0)
    standardized = (features - mean) / scale

    # Center the target so the intercept is exactly the mean reward and the
    # penalty applies only to the slopes (never regularize the intercept).
    reward_mean = rewards.mean()
    centered = rewards - reward_mean

    gram = standardized.T @ standardized + alpha * np.eye(SCORING_FEATURE_DIM)
    coefficients = np.linalg.solve(gram, standardized.T @ centered)

    return RouteScorer(
        coefficients=coefficients,
        intercept=float(reward_mean),
        mean=mean,
        scale=scale,
        n_samples=int(features.shape[0]),
    )
