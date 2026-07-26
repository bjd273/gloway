# Gloway — Codebase Wiki

Gloway ("Adaptive Map") is a personalized, conversational turn-by-turn navigation app. A FastAPI backend brokers routing (Valhalla), place/address data (OSM + Overture), and an LLM conversation layer (Gemini) that lets a driver talk to the app before and during a trip. A React + MapLibre frontend renders the map, the route, and the conversational UI. Everything is being built toward a longer-term goal — an RL-personalized router — but today's system is Phase 1/2 of that roadmap: correct, working navigation plus a conversational layer, with the hooks for learning already wired in but not yet trained.

This wiki is hand-maintained documentation of the **current, real state of the code** (not the aspirational plan). For the full multi-phase plan, tech-stack rationale, and week-by-week build log, see [`adaptive_map_build_roadmap.md`](../adaptive_map_build_roadmap.md) at the repo root — this wiki summarizes and links back to it rather than duplicating it.

## Wiki contents

| Page | What's in it |
|---|---|
| [Architecture](architecture.md) | Core modules, cross-file relationships, the abstraction-layer design pattern used twice (map data, LLM provider), and how the three tiers (routing engine, backend, frontend) fit together. |
| [Data Flow & Sequence Diagrams](data-flow.md) | Mermaid sequence/flow diagrams for route calculation, geocoding, the pre-trip conversation, live in-drive voice, and the post-trip debrief → reward pipeline. |
| [API Specification](api.md) | Every FastAPI route: method, path, request/response models, status codes, and error semantics. |
| [Decision Records](decisions.md) | Why Valhalla over OSRM, why a `MapDataSource`/`LLMClient` seam instead of calling providers directly, why Gemini instead of Claude, why self-hosted tiles, why GPS updates are appended in SQL instead of read-modify-write, etc. — with the reasoning and what would need to be true to revisit each one. |

## What this system does

A user opens the app, drops (or speaks) an origin and destination. The frontend asks the backend for a route; the backend loads any stored preferences for that user, translates them into Valhalla costing parameters, gets back a primary route plus alternates, and persists the request as a `trips` row (the raw material for future RL training — collected today, not yet consumed). If an LLM is configured, a conversation opens: the assistant says one short, context-aware thing, and the driver can reply by typing or speaking to change the route's mood ("I'm in a hurry"), add a stop ("grab a coffee"), switch to an alternate, switch travel mode, or route home/to work. The same reply-interpretation path runs again, over a WebSocket, while the user is actually driving, so the same commands work hands-free mid-trip. After the trip, a one-question debrief turns the driver's reaction into a reward value stored on the trip — the signal a future RL policy will train on.

## Quickstart — running it locally

### Prerequisites

- Python 3.11+, [Poetry](https://python-poetry.org/)
- Node 20+
- Docker + Docker Compose (for Postgres/PostGIS, Valhalla, and the Martin tile server)
- `osmium-tool` on your PATH if you need to (re)build the OSM extract or road graph

### 1. Environment variables

Create a `.env` at the **repo root** (not inside `backend/`):

```bash
DB_USER=postgres
DB_PASSWORD=adaptivemap
DATABASE_URL=postgresql+asyncpg://postgres:adaptivemap@postgres:5432/adaptivemap
VALHALLA_URL=http://valhalla:8002
MAP_DATA_SOURCE=hybrid          # osm | overture | hybrid (default)
GEMINI_API_KEY=your_key_here    # omit to run with conversation/voice features off
LLM_PROVIDER=gemini
LLM_MODEL=gemini-3.1-flash-lite
```

`backend/config.py` (`Settings`) auto-rewrites Docker Compose service hostnames (`postgres`, `valhalla`) to `localhost` when it detects it's *not* running inside a container (no `/.dockerenv`) — so the same `.env` works whether a process runs in Compose or directly on your machine. Without a `GEMINI_API_KEY`, every conversation/voice/debrief endpoint returns `503` and the frontend simply hides that UI — the rest of the app (routing, search, prefs) works normally.

### 2. Bring up infrastructure

```bash
docker compose -f infra/docker-compose.yml --project-directory . up -d postgres valhalla martin
```

Run with `--project-directory .` from the **repo root** — the compose file lives in `infra/` and Compose resolves `.env`/volume paths against its own directory unless told otherwise (see [Decision Records](decisions.md)).

The `valhalla` service needs routing tiles built from an OSM extract the first time — see the roadmap's "Week 1–2 — OSM Data Pipeline + PostGIS Schema" section in [`adaptive_map_build_roadmap.md`](../adaptive_map_build_roadmap.md) for the extract-download and `use_tiles_ignore_pbf` build sequence. `martin` serves the self-hosted vector basemap from `data/tiles/region.pmtiles` (also built via that section, using Planetiler).

### 3. Database

```bash
cd backend
poetry install                       # fast: skips the ML dependency groups
poetry run alembic upgrade head      # creates users, user_preferences, user_journey_profiles,
                                      # trips, trip_conversations, road_segments
```

### 4. Backend

```bash
cd backend
poetry run uvicorn api.main:app --reload --port 8000
```

Health check: `curl http://localhost:8000/health` → `{"status": "ok"}`. Interactive API docs are auto-generated by FastAPI at `http://localhost:8000/docs`.

### 5. Frontend

```bash
cd frontend
npm install
npm run dev
```

Opens on `http://localhost:3000`. Vite's dev server proxies `/api/v1/*` to the backend on `:8000` (including WebSocket upgrades, for the in-drive voice socket) and `/api/tiles/*` to Martin on `:3001` — see `frontend/vite.config.ts`.

### 6. (Optional) Overture places extract

`MAP_DATA_SOURCE=hybrid` (the default) needs a local Overture Places parquet at `data/overture/places.parquet` for place-name search to return results beyond Nominatim addresses. Regenerate it with `data/download_overture.sh`. Missing file degrades gracefully — a startup warning, and place search falls back to Nominatim-only.

### Running tests

```bash
cd backend
poetry run pytest                 # unit tests always run; @pytest.mark.integration
                                   # tests skip automatically if Valhalla/DB aren't reachable
```

## Repository map

```
backend/
  api/            FastAPI app + routers (see api.md)
  config.py       pydantic-settings Settings — single source of truth for env config
  db/             SQLAlchemy models, async session factory, Alembic migrations
  mapdata/        MapDataSource abstraction (OSM / Overture / hybrid) — see architecture.md
  routing/        Valhalla client + preference→costing translation
  ml/
    llm/          LLMClient abstraction (Gemini today) + conversation prompts/extraction
    gnn/          Road-network graph builder + GATv2 encoder (future RL state input)
  scripts/        One-off data pipelines (e.g. road segment ingestion from OSM)
  tests/          pytest suite, mirrors the package layout above
frontend/
  src/
    components/   React components (MapView, PromptBar, Conversation, TripPanel, ...)
    stores/       Zustand stores — all client state and the calls into lib/api.ts
    lib/          API client, MapLibre style/layer helpers, drive simulation, region bounds
    hooks/        useSystemTheme, useSpeechRecognition
infra/
  docker-compose.yml   Postgres/PostGIS, Valhalla, Martin, (Redis/Celery/Qdrant/MLflow — planned)
data/                  OSM/Overture extracts and generated tiles (all gitignored, regenerable)
valhalla/              Valhalla config + custom_files/ (gitignored build inputs/outputs)
adaptive_map_build_roadmap.md   The full multi-phase build plan and rationale log
```
