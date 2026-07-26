"""Feature vectors for *route ranking* (Week 27-28).

This is NOT interchangeable with `RouteEnvironment`'s navigation observation,
and the two must never be fed to each other's model. They describe different
problems:

- `ml/rl/environment.py` builds a 168-dim `[graph_emb | user_emb | context]`
  observation for a *sequential* MDP: "standing at this junction, which way do
  I turn?" Its value head estimates discounted reward-to-go, which is
  essentially negative distance-to-goal.
- This module builds a `SCORING_FEATURE_DIM` vector describing *one complete
  candidate route* for a *one-shot* choice: "of the routes Valhalla returned,
  which will this user like best?" There is no trajectory and no credit
  assignment, so there is nothing for RL to contribute — it is supervised
  regression onto the trip reward we already log.

The roadmap's Week 27-28 sample tried to score routes by calling
`PPO.predict_values()` on a route-summary vector. That crashes outright (the
policy's observation space is `Box(168,)`, the sample builds 52 dims), and
padding the shapes to match would only convert a loud crash into a silent
garbage score, since route-summary features are nothing like the distribution
that network's first layer was fit on. Hence two explicitly separate contracts.

Every dimension here is populated for every call — no placeholder zeros. That
is deliberate: constant inputs receive zero gradient and stay at their initial
values forever, which is exactly the bug that left the environment's 32
user-embedding dims dead through all of base training.

**Interaction terms carry this model.** `conflict_highway` and friends encode
"this route uses a highway AND this user dislikes highways" directly, so a
*linear* model can express the rule that actually matters. That is what makes
learning from a few dozen trips feasible; without them the model would need
the capacity (and the data) to discover the products itself.

The per-user latent vector from `preference_embedding.py` is deliberately NOT
an input yet: nothing writes it during a trip, so it would be a constant-zero
block — the dead-dimension bug again. Concatenate it here once the RL loop
actually populates it.
"""
from __future__ import annotations

import numpy as np

# Layout (indices are contractual — the persisted model's coefficients are
# positional, so inserting a feature mid-vector invalidates saved models).
#  0 time_hours          route duration, hours
#  1 length_norm         route distance / _LENGTH_SCALE_MILES
#  2 has_highway         0/1 from Valhalla's summary
#  3 has_toll            0/1 from Valhalla's summary
#  4 maneuver_density    maneuver count / _MANEUVER_SCALE
#  5 avoid_highways      user preference intensity, 0..1
#  6 avoid_tolls
#  7 avoid_left_turns
#  8 prefer_scenic
#  9 urgency
# 10-13 intent one-hot   [hurry, explore, commute, none]
# 14-16 mode one-hot     [auto, bicycle, pedestrian]
# 17 conflict_highway    has_highway * avoid_highways
# 18 conflict_toll       has_toll * avoid_tolls
# 19 turn_burden         maneuver_density * avoid_left_turns
SCORING_FEATURE_DIM = 20

FEATURE_NAMES = (
    "time_hours", "length_norm", "has_highway", "has_toll", "maneuver_density",
    "avoid_highways", "avoid_tolls", "avoid_left_turns", "prefer_scenic", "urgency",
    "intent_hurry", "intent_explore", "intent_commute", "intent_none",
    "mode_auto", "mode_bicycle", "mode_pedestrian",
    "conflict_highway", "conflict_toll", "turn_burden",
)

_TIME_SCALE_SECONDS = 3600.0
_LENGTH_SCALE_MILES = 50.0
_MANEUVER_SCALE = 50.0

_INTENTS = ("hurry", "explore", "commute")
_MODES = ("auto", "bicycle", "pedestrian")


def _summary_flag(summary: dict, key: str) -> float:
    """Valhalla emits has_highway/has_toll on the trip summary, but only on some
    builds/costings — absent means "not known to use one", which is the same
    thing as 0.0 for ranking purposes."""
    return 1.0 if summary.get(key) else 0.0


def _maneuver_count(route: dict) -> int:
    return sum(len(leg.get("maneuvers") or []) for leg in route.get("legs") or [])


def build_scoring_features(route: dict, prefs, context: dict | None = None) -> np.ndarray:
    """Feature vector for one candidate route.

    ``route``    — a single Valhalla trip object (``response["trip"]`` or an
                   entry of ``response["alternates"][i]["trip"]``).
    ``prefs``    — ``routing.valhalla_client.UserRoutingPrefs`` (0..1 intensities),
                   i.e. exactly what the /route handler already computed.
    ``context``  — ``{"declared_intent": str|None, "mode": str}``; missing keys
                   fall back to "none"/"auto".

    Malformed or partial routes yield zeros for the affected features rather
    than raising — ranking degrades, it never breaks the request.
    """
    context = context or {}
    summary = route.get("summary") or {} if isinstance(route, dict) else {}

    time_hours = float(summary.get("time") or 0.0) / _TIME_SCALE_SECONDS
    length_norm = float(summary.get("length") or 0.0) / _LENGTH_SCALE_MILES
    has_highway = _summary_flag(summary, "has_highway")
    has_toll = _summary_flag(summary, "has_toll")
    maneuver_density = _maneuver_count(route) / _MANEUVER_SCALE if isinstance(route, dict) else 0.0

    avoid_highways = float(getattr(prefs, "avoid_highways", 0.0))
    avoid_tolls = float(getattr(prefs, "avoid_tolls", 0.0))
    avoid_left_turns = float(getattr(prefs, "avoid_left_turns", 0.0))
    prefer_scenic = float(getattr(prefs, "prefer_scenic", 0.0))
    urgency = float(getattr(prefs, "urgency", 0.5))

    intent = context.get("declared_intent")
    intent_onehot = [1.0 if intent == name else 0.0 for name in _INTENTS]
    intent_onehot.append(0.0 if intent in _INTENTS else 1.0)  # "none" catch-all

    mode = context.get("mode") or "auto"
    mode_onehot = [1.0 if mode == name else 0.0 for name in _MODES]
    if not any(mode_onehot):
        mode_onehot[0] = 1.0  # unknown mode behaves like auto

    features = [
        time_hours, length_norm, has_highway, has_toll, maneuver_density,
        avoid_highways, avoid_tolls, avoid_left_turns, prefer_scenic, urgency,
        *intent_onehot,
        *mode_onehot,
        has_highway * avoid_highways,
        has_toll * avoid_tolls,
        maneuver_density * avoid_left_turns,
    ]
    vector = np.asarray(features, dtype=np.float64)
    assert vector.shape == (SCORING_FEATURE_DIM,), "feature layout drifted from SCORING_FEATURE_DIM"
    # A NaN anywhere would silently poison both training and ranking.
    return np.nan_to_num(vector, nan=0.0, posinf=0.0, neginf=0.0)
