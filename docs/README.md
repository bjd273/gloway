# Gloway — Codebase Wiki

Gloway is a personalised, conversational turn-by-turn navigation app. A FastAPI backend brokers
routing (Valhalla), place/address data (OSM + Overture), and an LLM conversation layer (Gemini)
that lets a driver talk to the app before and during a trip. A React + MapLibre frontend renders
the map, the glowing route, and a live-navigation view. Everything is aimed at an RL-personalised
router; today the learning pipeline is wired and collecting, but not yet trained.

This wiki documents the **current, real state of the code** — not the plan. For the multi-phase
roadmap, tech-stack rationale, and week-by-week build log, see
[`adaptive_map_build_roadmap.md`](../adaptive_map_build_roadmap.md), which is written partly in
ambition tense. This wiki is not, and that distinction is the reason it exists.

New here? Start with the [README quickstart](../README.md#quickstart).

## Contents

| Page | What's in it |
|---|---|
| [Setup](setup.md) | Prerequisites, every Docker service and whether it's actually used, the region build, changing coverage, troubleshooting. |
| [Architecture](architecture.md) | The three tiers, the two abstraction seams, module maps, what's built vs. scaffolding. |
| [Backend](backend.md) | Module by module: routers, config, models, the map-data and LLM seams, routing, the ML packages. |
| [Frontend](frontend.md) | Components, the six stores, the map layer stack, the drive loop, camera modes, route naming. |
| [API Specification](api.md) | Every endpoint: method, path, request/response, status codes, error semantics. |
| [Data Flow](data-flow.md) | Sequence diagrams for routing, geocoding, conversation, the live drive loop, and the reward pipeline. |
| [Decision Records](decisions.md) | Why Valhalla over OSRM, why the abstraction seams, why Gemini, why distance-based progress — with what would have to change to revisit each. |
| [Contributing](contributing.md) | Where things go, the rules worth knowing, tests, migrations, conventions, known rough edges. |

## What this system does

A user opens the app and picks a destination. The frontend asks the backend for a route; the
backend loads any stored preferences, translates them into Valhalla costing parameters, sweeps
several deliberately different costing strategies to build a pool of genuinely distinct
candidates, ranks them, and persists the request as a `trips` row — the raw material for future
training, collected today and not yet consumed.

If an LLM is configured, a conversation opens: the assistant says one short, context-aware thing,
and the driver can reply by typing or speaking to change the trip's mood ("I'm in a hurry"), add
a stop ("grab a coffee"), switch to an alternate, change travel mode, or route home. The same
interpretation path runs over a WebSocket while actually driving, so the same commands work
hands-free.

During the drive the map switches to a heading-up driving camera, the traveled span of the route
greys out behind the car, and GPS fixes stream to the backend in batches. Afterwards a
one-question debrief turns the driver's reaction into a reward value, fused with the behavioural
signal computed from the trace.

## Repository map

```
backend/
  api/
    main.py         FastAPI app, CORS, router mounting, lifespan-pooled Valhalla client + ranker
    routes/         routing · users · trips · conversation · voice · speech · feedback
  config.py         pydantic-settings Settings — the only place env config is read
  db/               SQLAlchemy models, async session factory, Alembic migrations
  mapdata/          MapDataSource abstraction (OSM / Overture / hybrid) + factory
  routing/          valhalla_client · candidate_generator (strategy sweep) · route_ranker
  services/         signal_processor — GPS trace vs suggested route adherence
  ml/
    llm/            LLMClient abstraction (Gemini) + conversation prompts and extraction
    gnn/            road-graph ingestion + GATv2 encoder (built, unwired)
    rl/             environment · reward_engine (live) · preference_embedding · route_scorer
  scripts/          ingest_road_segments · train_route_scorer · train_rl
  tests/            pytest, mirroring the layout above
frontend/
  src/
    components/     Sheet, TripSheet, MapView, RouteCard, ChatBar, NavVoice, PrefsPanel, ...
    stores/         useTripStore · useUserStore · useConvoStore · useDebriefStore
                    · useVoiceStore · useSheetStore
    lib/            api · navigation · routeProgress · routeLayers · routeSummary
                    · geolocate · region · voice
    hooks/          useSystemTheme, useSpeechRecognition
    styles/         vendored light/dark basemap styles
infra/
  docker-compose.yml   postgres · valhalla · martin (used) · redis · qdrant · mlflow
                       · backend · celery_worker · frontend (see setup.md)
data/
  region.json          the routable bbox — single source of truth
  download_osm.sh      state extract + crop to the bbox
  download_overture.sh Overture places parquet
scripts/
  rebuild_region.sh    one command for every region-derived artifact
  drive.sh             pre-flight + HTTPS tunnel for a real GPS drive
valhalla/              Valhalla config + custom_files/ (tile build inputs/outputs)
```

## Commands

```bash
# Infrastructure (name the services — a bare `up` tries to build a backend image that
# has no Dockerfile; see setup.md)
docker compose -f infra/docker-compose.yml --project-directory . up -d postgres valhalla martin

# Region artifacts
./scripts/rebuild_region.sh

# Backend
cd backend && poetry install && poetry run alembic upgrade head
poetry run uvicorn api.main:app --reload --port 8000
poetry run pytest

# Frontend
cd frontend && npm install
npm run dev
npm test && npx tsc -b && npx oxlint src
```

## Related documents at the repo root

| File | What it is |
|---|---|
| [`adaptive_map_build_roadmap.md`](../adaptive_map_build_roadmap.md) | The full multi-phase plan and build log, with per-feature notes on how the built thing deviated from the plan and why. |
| [`DESIGN.md`](../DESIGN.md) | Design tokens — colours, type scale, spacing, radii — and the rules the UI follows. |
| [`frontend.md`](../frontend.md) | The UI changelog: what changed and why it mattered. |
| [`PRODUCT.md`](../PRODUCT.md), [`startup_context.md`](../startup_context.md) | Product framing and the original problem statement. |
| `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` | Instructions for AI coding agents. Not human documentation — see [contributing.md](contributing.md) for that. |
