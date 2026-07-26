"""Train the supervised route scorer from logged trips.

Usage (from repo root or backend/):
    poetry --directory backend run python scripts/train_route_scorer.py
    poetry --directory backend run python scripts/train_route_scorer.py --dry-run

Needs Postgres up. Reads every trip with a non-null `reward_value` (written by
the debrief/completion flow — see services/signal_processor.py and
ml/rl/reward_engine.py), rebuilds the feature vector for the route that was
actually recommended, and fits a ridge model onto the reward.

Writes backend/models/route_scorer.npz (gitignored), which api/main.py loads at
startup. Until this has run — and until there are MIN_TRAINING_SAMPLES trips —
/route keeps recommending Valhalla's own primary, which is the intended cold
start rather than a failure.

Only pure numpy is needed: no torch, no ML poetry groups.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


async def _load_samples() -> tuple[list, list, int]:
    """Returns (feature_vectors, rewards, trips_seen)."""
    import numpy as np
    from sqlalchemy import select

    from db.models import Trip, UserPreference
    from db.session import get_session_factory
    from ml.rl.state import build_scoring_features
    from routing.valhalla_client import UserRoutingPrefs

    features: list[np.ndarray] = []
    rewards: list[float] = []
    seen = 0

    async with get_session_factory()() as session:
        trips = (
            await session.execute(select(Trip).where(Trip.reward_value.isnot(None)))
        ).scalars().all()

        # Cache prefs per user — most users have many trips.
        prefs_cache: dict = {}

        for trip in trips:
            seen += 1
            payload = trip.suggested_route or {}
            candidates = [payload.get("trip")] + [
                alt.get("trip") for alt in payload.get("alternates") or []
            ]
            candidates = [c for c in candidates if isinstance(c, dict)]
            if not candidates:
                continue

            context = trip.context or {}
            # Score the route we actually recommended; older trips predate the
            # recommended_index field and always showed Valhalla's primary.
            index = context.get("recommended_index") or 0
            if not isinstance(index, int) or not (0 <= index < len(candidates)):
                index = 0
            route = candidates[index]

            # Reconstruct the preferences in force for this user. These are
            # current values, not the historical ones (we don't version prefs) —
            # acceptable while volume is low, and worth revisiting if preference
            # churn ever becomes common.
            if trip.user_id not in prefs_cache:
                row = await session.get(UserPreference, trip.user_id) if trip.user_id else None
                prefs_cache[trip.user_id] = (
                    UserRoutingPrefs(
                        avoid_highways=1.0 if row.avoid_highways else 0.0,
                        avoid_tolls=1.0 if row.avoid_tolls else 0.0,
                        prefer_scenic=1.0 if row.prefer_scenic else 0.0,
                        avoid_left_turns=1.0 if row.avoid_left_turns else 0.0,
                    )
                    if row is not None
                    else UserRoutingPrefs()
                )
            prefs = prefs_cache[trip.user_id]
            if context.get("declared_intent") == "hurry":
                prefs.urgency = 1.0
            elif context.get("declared_intent") == "explore":
                prefs.urgency = 0.2

            features.append(
                build_scoring_features(
                    route,
                    prefs,
                    {
                        "declared_intent": context.get("declared_intent"),
                        "mode": context.get("mode", "auto"),
                    },
                )
            )
            rewards.append(float(trip.reward_value))

    return features, rewards, seen


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=None, help="model path (.npz)")
    parser.add_argument("--alpha", type=float, default=None, help="ridge penalty")
    parser.add_argument(
        "--min-samples", type=int, default=None, help="override the safety floor (use with care)"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="fit and report, but don't write the model"
    )
    args = parser.parse_args()

    import numpy as np

    from ml.rl.route_scorer import (
        DEFAULT_ALPHA,
        DEFAULT_MODEL_PATH,
        MIN_TRAINING_SAMPLES,
        NotEnoughData,
        train_route_scorer,
    )

    features, rewards, seen = asyncio.run(_load_samples())
    print(f"trips with a reward_value: {seen}; usable samples: {len(features)}")
    if not features:
        raise SystemExit(
            "No usable trips. Complete some drives and debriefs first — reward_value is "
            "written by /trips/{id}/complete and /trips/{id}/debrief/reply."
        )

    reward_array = np.asarray(rewards)
    print(f"reward: mean {reward_array.mean():+.3f}, std {reward_array.std():.3f}, "
          f"range [{reward_array.min():+.3f}, {reward_array.max():+.3f}]")

    try:
        scorer = train_route_scorer(
            np.vstack(features),
            reward_array,
            alpha=args.alpha if args.alpha is not None else DEFAULT_ALPHA,
            min_samples=(
                args.min_samples if args.min_samples is not None else MIN_TRAINING_SAMPLES
            ),
        )
    except NotEnoughData as exc:
        raise SystemExit(f"{exc}\nNothing written; /route keeps its deterministic ranking.")

    # In-sample fit only — with this few samples a held-out split would be
    # noisier than the number it produces. Treat it as a smoke check that the
    # solve worked, NOT as evidence the model generalizes.
    predictions = scorer.predict_batch(np.vstack(features))
    residual = float(np.sqrt(np.mean((predictions - reward_array) ** 2)))
    print(f"in-sample RMSE: {residual:.3f} (not a generalization estimate)")

    # Explain the best-rewarded trip, NOT the mean one: features are
    # standardized about the mean, so at the mean every contribution is exactly
    # zero and the table says nothing.
    best = int(np.argmax(reward_array))
    print(f"strongest features on the best-rewarded trip (reward {reward_array[best]:+.2f}):")
    for name, contribution in scorer.explain(features[best]):
        print(f"  {name:<20} {contribution:+.4f}")

    if args.dry_run:
        print("--dry-run: model not written")
        return

    path = scorer.save(args.out or DEFAULT_MODEL_PATH)
    print(f"saved: {path} (restart the API to load it)")


if __name__ == "__main__":
    main()
