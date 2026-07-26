"""Ranks Valhalla's candidate routes for a specific user (Week 27-28).

Valhalla solves the hard part — generating good candidate routes. This picks
which one to recommend, using the supervised `RouteScorer` when one has been
trained and falling back to Valhalla's own ordering when it hasn't.

The fallback is the important part of the design. Personalization has a genuine
cold start: no trips means no labels means no model. Rather than gate the
feature behind "wait until there's data", the endpoint always calls the ranker
and the ranker degrades silently:

    trained model present  -> reorder by predicted reward, personalization_active=True
    no model / too little  -> Valhalla's order unchanged, personalization_active=False
    model fails to load    -> same as no model, logged once, request still served

So wiring this in is behavior-preserving until someone actually trains a model,
and no route request can ever fail because of the ML layer.

This module is numpy-only by design: `torch` lives in optional poetry groups
(`gnn`/`rl`), and the /route endpoint must keep working in an install that
doesn't have them. See `ml/rl/route_scorer.py` for why the model is ridge
regression rather than a network.

Naming note: the roadmap called this `rl_router.RLEnhancedRouter`. It is
deliberately not named that — it is supervised regression, not RL, and calling
it RL would misrepresent what runs in production. See `ml/rl/state.py`.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from ml.rl.route_scorer import DEFAULT_MODEL_PATH, RouteScorer
from ml.rl.state import build_scoring_features

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RankedRoutes:
    """The candidate list is deliberately NOT reordered — only a recommendation
    is made. Valhalla's ordering is load-bearing elsewhere: `trips.suggested_route`
    stores the engine response verbatim, and `services/signal_processor.py`
    resolves route geometry positionally from it. Shuffling the response array
    would silently misalign stored trips from the routes they describe. The
    frontend already honours `recommended_index` (`selectedIndex` in
    useTripStore), so selecting is sufficient to change what the user sees."""

    recommended_index: int          # index into the ORIGINAL candidate order
    scores: list[float] | None      # predicted rewards, in the original order
    personalization_active: bool    # False when the deterministic fallback ran


class RouteRanker:
    """Scores + orders candidate routes. Construct once per process."""

    def __init__(self, scorer: RouteScorer | None = None):
        self._scorer = scorer

    @classmethod
    def from_path(cls, path: str | Path = DEFAULT_MODEL_PATH) -> "RouteRanker":
        """Load the trained scorer if present; otherwise a fallback-only ranker.

        Never raises: a missing, unreadable, or stale-layout model file means
        "no personalization yet", which is a normal state, not an error.
        """
        path = Path(path)
        if not path.exists():
            logger.info("No route scorer at %s — ranking falls back to Valhalla order", path)
            return cls(None)
        try:
            scorer = RouteScorer.load(path)
        except Exception:
            logger.warning("Could not load route scorer at %s; using fallback", path, exc_info=True)
            return cls(None)
        logger.info("Loaded route scorer (trained on %d trips)", scorer.n_samples)
        return cls(scorer)

    @property
    def is_personalized(self) -> bool:
        return self._scorer is not None

    def rank(self, routes: list[dict], prefs, context: dict | None = None) -> RankedRoutes:
        """Pick which of `routes` to recommend. `routes[0]` is Valhalla's primary.

        Returns index 0 (Valhalla's own choice) whenever there is no trained
        model, only one candidate, or scoring fails.
        """
        if not routes or self._scorer is None or len(routes) == 1:
            return RankedRoutes(0, None, False)

        try:
            scores = [
                self._scorer.predict(build_scoring_features(route, prefs, context))
                for route in routes
            ]
        except Exception:
            # A malformed candidate must not cost the user their route.
            logger.warning("Route scoring failed; recommending Valhalla's primary", exc_info=True)
            return RankedRoutes(0, None, False)

        # max() returns the FIRST maximal element, so an exact tie keeps
        # Valhalla's preference rather than reshuffling on numerical noise.
        best = max(range(len(routes)), key=lambda i: scores[i])
        return RankedRoutes(
            recommended_index=best,
            scores=scores,
            personalization_active=True,
        )
