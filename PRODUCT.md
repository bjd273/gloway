# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

General drivers and commuters — anyone currently using Google Maps, Apple Maps, or Waze for everyday
driving who wants routes suited to their own preferences rather than a one-size-fits-all default.
Primary usage context is in-car, often phone-mounted, frequently hands-free while actually driving.

Pre-launch stage: the only real usage on file today is the team's own test drives (e.g. the Doug
Russell Park drive) in the Arlington, TX region, which the region config and place-data extract are
currently scoped to. No external users yet.

## Product Purpose

Gloway is a personalized, conversational turn-by-turn navigation app. It exists to fix two things
Google/Apple Maps don't solve: routing that reflects one driver's actual preferences (not the crowd
average), and map data that's stale because it depends on expensive fleet-vehicle surveys. Success
means routes measurably suited to each driver (time saved, fewer complaints in the post-trip debrief)
and, longer-term, map updates that propagate far faster than a 30-day fleet cycle.

## Positioning

"Google Maps, but the routing learns *you*, and the maps update from a million dashcams in real-time
instead of a fleet of cars." Two mechanisms a competitor can't casually copy:

- **RL personalization from real driving behavior**, not surveys or manual preference toggles — the
  more you drive, the more the router reflects you specifically.
- **Crowdsourced dashcam map updates** (aspirational — not yet built) intended to replace slow,
  expensive fleet-car surveys with near-real-time updates from users' own dashcams.

Conversational trip planning/refinement (talk to the app before or mid-trip) is the interaction layer
that makes both of the above usable hands-free while driving, not the core differentiator itself.

## Operating Context

- Primarily used in a moving car, often mounted, frequently hands-free — glanceability and low
  distraction are safety properties, not just polish (see `frontend.md`).
- A pre-trip conversational question, live mid-trip voice re-planning, and a one-question post-trip
  debrief are the three conversational touchpoints; the debrief's answer is the reward signal a future
  RL policy will train on.
- Current build phase (per `adaptive_map_build_roadmap.md`): Phase 1/2 — working router (Valhalla +
  OSM/Overture via a `MapDataSource` abstraction) and an LLM conversation layer (Gemini, via an
  `LLMClient` abstraction), with hooks for RL personalization (Phase 3) wired in but not yet trained
  on real reward data.
- Backend: FastAPI, PostgreSQL/PostGIS, Valhalla routing, self-hosted vector tiles. Frontend: React +
  TypeScript + MapLibre GL, Zustand for state.
- Team: two people (ML/robotics/path-planning; full-stack backend/frontend/infra) — durable context
  for what's realistic to ship and maintain.

## Capabilities and Constraints

- Working: route calculation with multiple labeled candidate strategies (fastest, no-highways, fewest
  turns, etc.), place/address search (hybrid OSM + Overture), conversational route refinement by
  typed or spoken command (typed/voice), live mid-trip re-planning over WebSocket, post-trip debrief
  capture.
- Not yet built: crowdsourced dashcam ingestion, RL-trained personalization (embeddings and training
  loop exist as scaffolding; not consuming reward signal in production yet), mobile app (planned as a
  Capacitor wrapper around the same web UI, not a native rewrite).
- Without a configured LLM API key, conversation/voice/debrief endpoints are disabled (503) and the
  frontend hides that UI; core routing/search/prefs still work.
- Undecided: how the crowdsourced dashcam pipeline will actually be validated/moderated before it
  affects other users' maps.

## Brand Commitments

Name: **Gloway**. Existing wordmark/logo (`frontend/src/components/Wordmark.tsx`,
`frontend/public/favicon.svg`) — a teal/lime paper-plane-and-star mark plus lowercase wordmark — is the
current brand asset in use; treat as a real committed asset, not a placeholder, unless the user says
otherwise.

## Evidence on Hand

- `adaptive_map_build_roadmap.md` — full multi-phase technical plan and build log.
- `frontend.md` — UI change log with reasoning, written after the team's first real GPS drive.
- `docs/` (architecture, data-flow, API spec, decision records) — current, real state of the code as
  built, kept separate from the aspirational roadmap.
- No customer testimonials, case studies, or press exist yet — do not fabricate any. The only real
  usage evidence is the team's own test drives.

## Product Principles

1. The router should get measurably better the more a specific person drives, not just apply generic
   rule-based preferences.
2. Map freshness should come from the driving population itself, not a company-run survey fleet.
3. Conversational interaction exists to make routing control usable hands-free in a car — it is a
   means to route changes, not a standalone chat product (see `frontend.md`'s "map-first, chat as
   refinement" decision).
4. Glanceability and low cognitive load are safety requirements while driving, not optional polish.
5. Ship the honest current state: don't present Phase 3 (RL personalization) or dashcam crowdsourcing
   capabilities as live when they are still roadmap items.

## Accessibility & Inclusion

Target WCAG 2.1 AA, in addition to the driving-safety glanceability/low-distraction principle already
established for in-car use.
