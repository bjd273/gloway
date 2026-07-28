"""Valhalla routing client + custom costing translation.

This module is the single bridge between *user preferences* and the routing
engine's cost model. In Phase 1 the preferences are produced by rule-based
logic (declared dislikes, the pre-trip "are you in a hurry?" question). In
Phase 3 the exact same ``UserRoutingPrefs`` struct will instead be produced by
the RL policy — a small per-user preference vector decoded into these weights.
Keeping that seam clean and stable now is what lets the learned model plug in
later without touching the routing plumbing.

The costing translation below is grounded in the behaviour of Valhalla's
``auto`` costing as verified against a live instance, not just the docs:

* ``shortest`` is a *boolean* (distance-vs-time), NOT a graduated float. It
  produces routes that are shorter in distance but *slower* in time, so it is
  deliberately not tied to "urgency".
* Out-of-range / wrong-typed costing values are *silently ignored* by Valhalla
  (a route is still returned, just without the intended effect). Every value we
  emit is therefore clamped to its valid range so a preference can never
  silently no-op.
* ``auto`` costing exposes no left-turn-specific penalty; ``maneuver_penalty``
  penalises *all* turns. ``avoid_left_turns`` is therefore only *approximated*
  in Phase 1 (see ``_build_costing_options``); precise left-turn avoidance needs
  a custom C++ costing model, tracked as later work.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Optional

import httpx

# Valhalla auto-costing defaults we build on top of. Ranges are what the engine
# actually accepts; anything outside is ignored by the engine, so we clamp.
_DEFAULT_MANEUVER_PENALTY = 5.0   # seconds, Valhalla default
_MAX_MANEUVER_PENALTY = 300.0     # empirically enough to reshape local routes
_DEFAULT_LIVING_STREETS = 0.1     # Valhalla default use_living_streets


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


@dataclass
class UserRoutingPrefs:
    """User preference weights injected into Valhalla's cost model.

    Every field is a 0.0–1.0 intensity (except ``urgency``, also 0.0–1.0). 0.0
    means "no opinion / don't apply", 1.0 means "apply as strongly as the engine
    allows". This is the struct the RL policy will emit in Phase 3.
    """

    avoid_highways: float = 0.0    # 1.0 => avoid highways as much as possible
    avoid_tolls: float = 0.0       # 1.0 => avoid toll roads
    prefer_scenic: float = 0.0     # 1.0 => favour local/living streets over arterials
    avoid_left_turns: float = 0.0  # 1.0 => penalise turns (coarse proxy, see module docstring)
    urgency: float = 0.5           # 0.0 leisurely ... 1.0 fastest-possible


class ValhallaRouter:
    """Async client for a Valhalla routing service.

    Owns an ``httpx.AsyncClient`` by default, or accepts a shared one (preferred
    inside a long-lived FastAPI app so connections are pooled). Call
    :meth:`aclose` on shutdown, or use it as an async context manager.
    """

    def __init__(
        self,
        base_url: str,
        client: Optional[httpx.AsyncClient] = None,
        timeout: float = 30.0,
    ):
        self.base_url = base_url.rstrip("/")
        self._client = client or httpx.AsyncClient(timeout=timeout)
        self._owns_client = client is None

    async def __aenter__(self) -> "ValhallaRouter":
        return self

    async def __aexit__(self, *exc) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    def _build_costing_options(self, prefs: UserRoutingPrefs) -> dict:
        """Translate user preferences into Valhalla ``auto`` costing parameters.

        This is the RL injection point. All outputs are clamped to ranges the
        engine honours (out-of-range values are silently dropped by Valhalla).
        """
        avoid_highways = _clamp(prefs.avoid_highways)
        avoid_tolls = _clamp(prefs.avoid_tolls)
        prefer_scenic = _clamp(prefs.prefer_scenic)
        avoid_left_turns = _clamp(prefs.avoid_left_turns)
        urgency = _clamp(prefs.urgency)

        # use_highways: 0.0 avoids, 1.0 prefers. Start from the explicit
        # highway aversion, then let a scenic preference push it further down
        # (scenic == arterials feel less local), and let high urgency pull it
        # back up (a rushed driver tolerates a highway even if mildly disliked).
        use_highways = 1.0 - 0.9 * avoid_highways
        use_highways -= 0.5 * prefer_scenic
        use_highways += 0.3 * (urgency - 0.5)  # +/-0.15 nudge around neutral
        use_highways = _clamp(use_highways)

        use_tolls = _clamp(1.0 - 0.9 * avoid_tolls)

        # Scenic routing leans on local/living streets, which Valhalla otherwise
        # keeps rare (default 0.1).
        use_living_streets = _clamp(_DEFAULT_LIVING_STREETS + 0.6 * prefer_scenic)

        # Coarse left-turn proxy: penalise ALL maneuvers. Reduces turn count,
        # which correlates weakly with fewer left turns. Precise avoidance is
        # future custom-costing work.
        maneuver_penalty = _DEFAULT_MANEUVER_PENALTY + (
            _MAX_MANEUVER_PENALTY - _DEFAULT_MANEUVER_PENALTY
        ) * avoid_left_turns

        return {
            "auto": {
                "use_highways": use_highways,
                "use_tolls": use_tolls,
                "use_living_streets": use_living_streets,
                "maneuver_penalty": maneuver_penalty,
                # shortest is boolean (distance-optimised, slower in time); we
                # never enable it from these prefs — kept explicit for clarity.
                "shortest": False,
            }
        }

    async def get_route(
        self,
        origin: tuple[float, float],           # (lat, lon)
        destination: tuple[float, float],      # (lat, lon)
        waypoints: Optional[list[tuple[float, float]]] = None,
        prefs: Optional[UserRoutingPrefs] = None,
        alternatives: int = 3,                 # always request alternates for RL training data
        costing: str = "auto",                 # "auto" | "bicycle" | "pedestrian"
        costing_overrides: Optional[dict] = None,
    ) -> dict:
        """`costing_overrides` are merged over the preference-derived options.

        This is how routing.candidate_generator asks for a deliberately
        different route ("no highways", "fewest turns") without discarding the
        user's own preferences — a strategy leans the result, it does not
        replace the person. Applies to any costing, since bike and pedestrian
        have their own useful knobs (use_roads, use_lit) even though the
        preference translation below is auto-only.
        """
        if prefs is None:
            prefs = UserRoutingPrefs()

        locations = [{"lat": origin[0], "lon": origin[1]}]
        if waypoints:
            locations.extend({"lat": wp[0], "lon": wp[1]} for wp in waypoints)
        locations.append({"lat": destination[0], "lon": destination[1]})

        payload = {
            "locations": locations,
            "costing": costing,
            "alternates": alternatives,
            "directions_options": {
                "units": "miles",
                "language": "en-US",
                "narrative": True,
            },
        }
        # The preference->cost translation is auto-specific (use_highways,
        # use_tolls, ...); bike/walk use Valhalla's defaults. This keeps the RL
        # injection seam intact for the primary mode without inventing
        # bike/pedestrian costing mappings that don't exist yet.
        if costing == "auto":
            payload["costing_options"] = self._build_costing_options(prefs)
        if costing_overrides:
            options = payload.setdefault("costing_options", {}).setdefault(costing, {})
            options.update(costing_overrides)

        response = await self._client.post(
            f"{self.base_url}/route",
            content=json.dumps(payload),
            headers={"Content-Type": "application/json"},
        )
        response.raise_for_status()
        return response.json()

    async def get_isochrone(
        self,
        location: tuple[float, float],
        minutes: Optional[list[int]] = None,
    ) -> dict:
        """Reachability polygon — 'what can I reach in X minutes'."""
        if minutes is None:
            minutes = [5, 10, 15]
        payload = {
            "locations": [{"lat": location[0], "lon": location[1]}],
            "costing": "auto",
            "contours": [{"time": m} for m in minutes],
            "polygons": True,
        }
        response = await self._client.post(
            f"{self.base_url}/isochrone",
            content=json.dumps(payload),
            headers={"Content-Type": "application/json"},
        )
        response.raise_for_status()
        return response.json()


def get_router(client: Optional[httpx.AsyncClient] = None) -> ValhallaRouter:
    """Construct a router pointed at the configured Valhalla service."""
    from config import settings

    return ValhallaRouter(settings.valhalla_url, client=client)
