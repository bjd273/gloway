# Gloway

Personalised, conversational turn-by-turn navigation.

Google and Apple optimise routes for the crowd. Gloway is a bet that the route should be
optimised for *you* — that a navigator which learns you hate left turns, or always takes the
river road on a Sunday, is worth more than one that shaves ninety seconds off the average. It
gets there by talking to you: one short question before the drive, one after, and a reward
signal quietly assembled from what you actually did versus what it suggested.

A FastAPI backend brokers routing (Valhalla), place data (OpenStreetMap + Overture) and an LLM
conversation layer (Gemini). A React + MapLibre frontend renders the map, the glowing route, and
a live-navigation view. Everything is aimed at an RL-personalised router; today the learning
pipeline is wired and collecting, but not yet trained. See
[what works today](#what-works-today) before assuming anything.

**Coverage is currently Central Arlington, TX** — one OSM extract's worth of routing tiles.
Changing that is one file and one script; see [docs/setup.md](docs/setup.md#changing-the-region).

---

## Quickstart

Roughly 15 minutes, most of it the one-time tile build.

### Prerequisites

| Tool | Why |
|---|---|
| Docker + Compose v2 | Postgres/PostGIS, Valhalla, Martin tile server |
| Python 3.11+ and [Poetry](https://python-poetry.org/) | the backend |
| Node 20+ | the frontend |
| [`osmium-tool`](https://osmcode.org/osmium-tool/) | crops the OSM extract (`brew install osmium-tool`) |
| [`uv`](https://docs.astral.sh/uv/) *(optional)* | Overture places download (`brew install uv`); without it, place search falls back to OSM only |

Planetiler builds the basemap and runs via Docker, so you do **not** need a local Java install.

### 1. Configure

```bash
cp .env.example .env
```

The defaults work as-is. Add a `GEMINI_API_KEY` if you want the conversation, voice and debrief
features — without one they return `503` and the frontend hides them, which is a supported
configuration, not a broken one.

### 2. Start infrastructure

```bash
docker compose -f infra/docker-compose.yml --project-directory . up -d postgres valhalla martin
```

Both flags matter. The compose file lives in `infra/` but its volume paths and `.env` are
relative to the repo root, so `--project-directory .` is what makes them resolve.

Name the three services explicitly. The file also declares `backend`, `celery_worker`,
`frontend`, `redis`, `qdrant` and `mlflow`; a bare `docker compose up` will try to build
`backend` and fail, because **there is no `backend/Dockerfile`** — the backend is meant to run on
the host during development. See [docs/setup.md](docs/setup.md#what-each-service-is-for).

### 3. Build the region

```bash
./scripts/rebuild_region.sh
```

One command for every artifact derived from the bounding box in `data/region.json`: crops the
OSM extract, rebuilds the Valhalla routing tiles, builds the Planetiler basemap, downloads
Overture places, and syncs the frontend's copy of `region.json`. First run downloads a ~700 MB
Texas extract and ~1.3 GB of Planetiler sources, then caches both. Safe to re-run.

### 4. Database

```bash
cd backend
poetry install                    # skips the optional ML groups — fast
poetry run alembic upgrade head
```

### 5. Backend

```bash
cd backend
poetry run uvicorn api.main:app --reload --port 8000
```

`curl http://localhost:8000/health` → `{"status":"ok"}`. Interactive API docs at
`http://localhost:8000/docs`.

### 6. Frontend

```bash
cd frontend
npm install
npm run dev
```

`http://localhost:3000`. Vite proxies `/api/v1/*` to the backend (including the WebSocket
upgrade for in-drive voice) and `/api/tiles/*` to Martin.

Append `?sim=1` to simulate a drive without real GPS — useful anywhere outside Arlington, since
`watchPosition` would otherwise sit off-map forever.

---

## Repository map

```
backend/
  api/routes/      FastAPI routers: routing · users · trips · conversation · voice · speech · feedback
  config.py        pydantic-settings Settings — the only place env config is read
  db/              SQLAlchemy models, async session factory, Alembic migrations
  mapdata/         MapDataSource abstraction (OSM / Overture / hybrid) + factory
  routing/         Valhalla client, candidate generation (strategy sweep), route ranking
  services/        signal_processor.py — GPS trace vs suggested route adherence
  ml/llm/          LLMClient abstraction (Gemini today) + conversation prompts/extraction
  ml/gnn/          Road-graph ingestion and a GATv2 encoder (RL groundwork, unwired)
  ml/rl/           Gym environment, reward fusion, preference embeddings, supervised route scorer
  scripts/         Data pipelines and training entrypoints
  tests/           pytest, mirroring the package layout
frontend/
  src/components/  Sheet, TripSheet, MapView, ChatBar, NavVoice, RouteCard, ...
  src/stores/      Zustand — trip, user, conversation, debrief, voice, sheet
  src/lib/         API client, map layers, drive controller, route formatting, geolocation
  src/hooks/       useSystemTheme, useSpeechRecognition
infra/             docker-compose.yml
data/              region.json (the bbox source of truth), download scripts, generated extracts
valhalla/          Valhalla config + custom_files/ (tile build inputs/outputs)
scripts/           rebuild_region.sh, drive.sh
docs/              the wiki — start at docs/README.md
```

## Tests and checks

```bash
cd backend  && poetry run pytest
cd frontend && npm test && npx tsc -b && npx oxlint src
```

Backend integration tests self-skip when Valhalla or Postgres aren't reachable, so the suite
passes on a bare checkout.

## What works today

Honest status, because the [roadmap](adaptive_map_build_roadmap.md) is written in ambition tense
and this is not:

- **Shipped end to end** — routing with preference-driven Valhalla costing, a multi-strategy
  candidate sweep, geocoding and place search, accounts and preferences, trip persistence,
  live navigation (traveled/remaining route styling, heading-up driving camera, GPS streaming),
  the pre-trip conversation, the in-drive voice WebSocket, the post-trip debrief, and reward
  fusion writing `trips.reward_value`.
- **Built and tested but not in a request path** — the GNN road-graph encoder, per-user
  preference embeddings, the RL environment and training loop. The supervised route scorer *is*
  wired into `POST /route`, but falls back to Valhalla's own ordering until a model is trained
  (which needs ≥30 completed trips).
- **Declared in compose, absent from the code** — Celery, Redis, federated learning. `qdrant`
  and `mlflow` have code that can use them but nothing in the request path does.

The single biggest blocker to the personalisation thesis is not modelling — it is that
`watchPosition` and `getUserMedia` require a secure context, so collecting real drive data needs
an HTTPS origin. `./scripts/drive.sh` opens a tunnel for exactly that.

## Documentation

| Page | What's in it |
|---|---|
| [docs/setup.md](docs/setup.md) | Full environment setup, every service, changing the region, troubleshooting |
| [docs/architecture.md](docs/architecture.md) | The three tiers, the two abstraction seams, module maps |
| [docs/backend.md](docs/backend.md) | Backend module by module |
| [docs/frontend.md](docs/frontend.md) | Components, stores, map layer stack |
| [docs/api.md](docs/api.md) | Every endpoint: request, response, status codes |
| [docs/data-flow.md](docs/data-flow.md) | Sequence diagrams for routing, conversation, the drive loop |
| [docs/decisions.md](docs/decisions.md) | Why Valhalla, why the seams, why Gemini — and what would change each |
| [docs/contributing.md](docs/contributing.md) | How to work in this codebase |

Also at the root: [`adaptive_map_build_roadmap.md`](adaptive_map_build_roadmap.md) (the full
multi-phase plan and build log), [`DESIGN.md`](DESIGN.md) (design tokens and rules),
[`PRODUCT.md`](PRODUCT.md), [`frontend.md`](frontend.md) (why the UI changed), and
[`startup_context.md`](startup_context.md).
