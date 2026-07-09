# Adaptive Map Platform — Full Build Roadmap
### From Zero to Magical Mapping Experience

**Team:** You (ML / Robotics / Path Planning) + Jonathan (CS / Backend / Infrastructure)  
**Execution order:** Phase 1 → Base Router → Phase 2 → LLM Layer → Phase 3 → RL Personalization  
**Total estimated timeline:** 28–32 weeks to a working, differentiated product

---

## Table of Contents

1. [Tech Stack Master Reference](#tech-stack-master-reference)
2. [Team Split & Ownership](#team-split--ownership)
3. [Repository & Environment Setup](#repository--environment-setup)
4. [Map Data Abstraction Layer](#map-data-abstraction-layer) — build this in Week 1–2, before any enrichment/use-case code
5. [Phase 1 — Base Route Planner](#phase-1--base-route-planner-weeks-1-8)
6. [Phase 2 — LLM Conversation Layer](#phase-2--llm-conversation-layer-weeks-9-16)
7. [Phase 3 — RL Personalization Engine](#phase-3--rl-personalization-engine-weeks-17-28)
8. [Integration & End-to-End Testing](#integration--end-to-end-testing)
9. [Deployment & Infrastructure](#deployment--infrastructure)
10. [Milestone Checklist](#milestone-checklist)

---

## Tech Stack Master Reference

### Backend
| Component | Technology | Why |
|---|---|---|
| API framework | FastAPI (Python) | Async, fast, auto-generates OpenAPI docs. Python keeps ML and API in the same language. |
| Database | PostgreSQL + PostGIS | PostGIS extension makes Postgres a full spatial database — required for road network queries. |
| Cache / fast store | Redis | Sub-millisecond reads for user profiles, active sessions, real-time route state. |
| Message queue | Celery + Redis | Async task processing for post-trip signal analysis, LLM reward extraction, RL updates. |
| Basemap vector tiles | Planetiler → PMTiles → Martin | Planetiler (BSD-3) generates OpenMapTiles-schema PMTiles directly from our own OSM extract — fully self-hosted, unambiguously free for commercial/startup use (unlike CARTO's hosted tiles or MapTiler Cloud's free tier, which is explicitly non-commercial-only). Martin serves the `.pmtiles` file; it can *also* serve directly from PostGIS later once crowdsourced dashcam updates need a live/dynamic tile layer (`road_segments`) alongside the static basemap. See "Self-hosted basemap tiles" under Week 1–2. |

### Routing Engine
| Component | Technology | Why |
|---|---|---|
| Base routing engine | Valhalla (open source) | More flexible than OSRM — supports custom cost functions, which you NEED for RL weight injection. Runs as a local service. Never modify Valhalla's C++ core — see [Map Data Abstraction Layer](#map-data-abstraction-layer) for why differentiation happens above it, not inside it. |
| Routing graph data | OpenStreetMap (OSM) | Free, global, updated by community, and the only data source with a mature offline tile-build pipeline into Valhalla. This does not change even if the places/geocoding layer below becomes hybrid. |
| Graph representation | NetworkX → PyTorch Geometric | NetworkX for initial prototyping, PyTorch Geometric for production GNN. |

### Map Data Layer (Places, Addresses, Enrichment)
| Component | Technology | Why |
|---|---|---|
| Data abstraction | `backend/mapdata/` — a `MapDataSource` interface | Every enrichment feature (EV charging, delivery, cycling, scenic scoring, geocoding) is written against this interface, never against a specific provider. See [Map Data Abstraction Layer](#map-data-abstraction-layer). |
| Places/POI source (v1) | OpenStreetMap via Overpass API or self-hosted extract | Free, matches the routing graph data, richest tagging for routing-relevant attributes (access rules, conditional restrictions). |
| Places/POI source (future, optional) | [Overture Maps](https://overturemaps.org) | Cleaner, more consistent schema and better deduped buildings/places/addresses. Bolted on later as a second `MapDataSource` implementation, or blended via a `HybridMapDataSource` — zero rework to callers because they only ever see the interface. Do not adopt until OSM place-data quality is an actual measured bottleneck. |
| Contract tests | pytest, parametrized over implementations | One shared test suite every `MapDataSource` implementation must pass (`backend/tests/mapdata/test_contract.py`), so swapping/adding a provider can't silently break enrichment logic. |

### ML / AI
| Component | Technology | Why |
|---|---|---|
| LLM | Claude API (claude-sonnet-4-6) | Best reasoning for preference extraction and conversation. Use Haiku for lower-latency in-session calls. |
| STT (voice input) | faster-whisper | Optimized Whisper — runs on-device or server, real-time transcription. |
| TTS (voice output) | Coqui TTS (local) or ElevenLabs API | Coqui is free and runs locally. ElevenLabs sounds better but costs per character. Start with Coqui. |
| GNN (map encoder) | PyTorch Geometric | Best library for graph neural networks. Encodes road network into vectors the RL model can consume. |
| RL framework | Stable Baselines 3 → Ray RLlib | Start with SB3 (simpler API), migrate to RLlib when you need distributed training. |
| Federated learning | Flower (flwr) | Purpose-built federated learning framework — well-documented and actively maintained. |
| Vector database | Qdrant (self-hosted) | Stores preference embeddings, trip history vectors. Fast similarity search. |
| Experiment tracking | MLflow | Track model versions, training runs, hyperparameters. Free, self-hosted. |

### Frontend
| Component | Technology | Why |
|---|---|---|
| Web app | React + TypeScript | Jonathan's domain. TypeScript catches bugs early in a complex app. |
| Map rendering | MapLibre GL JS | Open-source Mapbox fork. Renders vector tiles in the browser with full styling control. |
| Mobile app | React Native + MapLibre | Share business logic with web. Add later — focus web first. |
| UI component library | shadcn/ui | Unstyled, accessible components — you own the styling, no fighting a design system. |
| State management | Zustand | Lightweight and simple. Not overkill like Redux. |
| Voice UI | Web Speech API + custom hook | Browser-native for web. Backed by faster-whisper on mobile. |

### Infrastructure
| Component | Technology | Why |
|---|---|---|
| Containerization | Docker + Docker Compose | Everyone runs the same environment. Compose brings up all services with one command. |
| Cloud | AWS (recommended) | EC2 for compute, RDS for managed Postgres, S3 for OSM data and model storage, EKS later. |
| CI/CD | GitHub Actions | Free for public/private repos. Runs tests and deploys on push. |
| Secrets management | AWS Secrets Manager | Never hardcode API keys. Jonathan sets this up. |
| Monitoring | Prometheus + Grafana | Real-time dashboards for API latency, routing performance, model inference time. |

---

## Team Split & Ownership

Clear ownership prevents stepping on each other. These are defaults — you'll overlap as needed.

**You own:**
- Valhalla routing engine configuration and custom cost functions
- All ML code: GNN, RL training pipeline, reward function, preference embeddings
- faster-whisper integration and voice pipeline backend
- Federated learning architecture (Flower)
- MLflow experiment tracking

**Jonathan owns:**
- FastAPI backend architecture, all API endpoints
- PostgreSQL + PostGIS schema design and migrations
- Redis caching layer and Celery task queue
- Docker Compose and infrastructure setup
- MapLibre GL JS integration (frontend map rendering)
- React app architecture, routing, state management
- GitHub Actions CI/CD pipeline
- AWS setup and secrets management

**Both work together on:**
- User profile data schema (it touches ML and backend equally)
- API contracts between ML services and the main backend
- End-to-end testing of the full journey flow
- The `MapDataSource` interface in `backend/mapdata/` (see [Map Data Abstraction Layer](#map-data-abstraction-layer)) — You own `osm_source.py` and its routing-relevant tag mapping; Jonathan owns wiring `get_map_data_source()` into API route handlers (geocoding, places lookups) instead of calling providers directly. Neither of you should ever import `httpx` to hit Overpass/Nominatim/Overture from inside `api/` or `ml/` — always go through the interface.

---

## Repository & Environment Setup

**Do this in Week 1 before anything else.**

### Step 1 — Repository structure

Create one monorepo. Jonathan sets this up and invites you.

```
adaptive-map/
├── backend/                  # FastAPI + all Python services
│   ├── config.py             # pydantic-settings Settings — single source of truth for env-derived
│   │                         #   config (valhalla_url, etc). Import `from config import settings`.
│   ├── api/                  # Route handlers, request/response models
│   ├── routing/              # Valhalla client, cost function injection
│   ├── mapdata/              # Data abstraction layer — see "Map Data Abstraction Layer"
│   │   ├── models.py         # Place, Address, BBox, PlaceCategory, RoutingGraphRef — the only
│   │   │                     #   vocabulary enrichment code is allowed to speak
│   │   ├── base.py           # MapDataSource ABC — the interface everything else is written against
│   │   ├── osm_source.py     # OSMMapDataSource — v1 implementation, Overpass or self-hosted extract
│   │   ├── overture_source.py  # OvertureMapDataSource — stub now, real once OSM places are a bottleneck
│   │   ├── hybrid_source.py    # Combines sources per-method (e.g. OSM routing + Overture places)
│   │   └── factory.py        # get_map_data_source() — reads settings.map_data_source, returns impl
│   ├── ml/                   # GNN, RL, preference embedding code
│   │   ├── gnn/
│   │   ├── rl/
│   │   ├── llm/              # Claude API wrappers, prompt templates
│   │   └── federated/        # Flower server code
│   ├── services/             # Celery tasks, background workers
│   ├── db/                   # SQLAlchemy models, Alembic migrations
│   └── tests/
│       └── mapdata/
│           └── test_contract.py   # Shared test suite every MapDataSource impl must pass
├── frontend/                 # React + TypeScript
│   ├── src/
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── stores/           # Zustand state
│   │   └── services/         # API client code
│   └── tests/
├── valhalla/                 # Valhalla config + custom_files/ (gitignored build output — the
│                             #   region .osm.pbf and generated valhalla_tiles.tar live here)
├── data/                     # OSM data download scripts, pipeline scripts
│   ├── osm/                  # Downloaded .pbf extracts (gitignored — regenerate via download_osm.sh)
│   ├── tiles/                # Planetiler PMTiles output, e.g. region.pmtiles (gitignored — regenerate)
│   └── sources/              # Planetiler's auxiliary downloads: water polygons, Natural Earth,
│                             #   lake centerlines (gitignored, ~1.3GB, fetched via --download once)
├── infra/                    # Docker Compose, Terraform (later), Nginx config
│   └── docker-compose.yml    # Run with `--project-directory .` from the repo root — the compose
│                             #   file lives in infra/, and Compose resolves relative volume paths
│                             #   and .env against its OWN directory by default, not the repo root.
│                             #   Without this flag, `.env` and bind-mount paths silently fail to
│                             #   resolve. Full command:
│                             #   docker compose -f infra/docker-compose.yml --project-directory . up -d <service>
├── mlflow/                   # MLflow tracking server config
├── notebooks/                # Jupyter notebooks for ML experimentation
└── docs/                     # Architecture decisions, API docs
```

### Step 2 — Environment setup (both of you)

```bash
# Install pyenv for Python version management
curl https://pyenv.run | bash

# Install Python 3.11 (stable, well-supported by all libraries)
pyenv install 3.11.9
pyenv global 3.11.9

# Install Poetry for Python dependency management
curl -sSL https://install.python-poetry.org | python3 -

# Install Node 20 (LTS) via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
nvm use 20

# Install Docker Desktop (handles Docker + Docker Compose)
# https://www.docker.com/products/docker-desktop/
```

### Step 3 — Python dependencies (backend/pyproject.toml)

**Two things the original plan got wrong, fixed here:**

1. **`poetry install` will fail outright without `package-mode = false`.** A PEP 621 `[project]` table with no matching installable package directory (no `backend/adaptive_map_backend/`) makes Poetry 2.x try to build/install the project as its own package and error out. Add to `pyproject.toml`:
   ```toml
   [tool.poetry]
   package-mode = false
   ```
2. **Don't install the full ML stack (torch, ray[rllib], flwr, mlflow, faster-whisper, qdrant-client) in one flat `poetry add`.** They're multi-GB and irrelevant until Phase 2/3, so a `poetry install` for a Phase 1 DB/routing task would burn 10+ minutes and several GB for nothing. Put them in an **optional** Poetry group instead, so `poetry install` stays fast through Phase 1, and `poetry install --with ml` pulls them in whenever Phase 2/3 work actually starts:

```toml
[project]
dependencies = [
  "fastapi>=0.110.0", "uvicorn[standard]>=0.29.0", "sqlalchemy>=2.0.29",
  "alembic>=1.13.1", "asyncpg>=0.29.0", "psycopg2-binary>=2.9.9",
  "geoalchemy2>=0.14.0",   # PostGIS Geography/Geometry columns in SQLAlchemy — the
                           # original plan's dependency list omitted this; the DB schema
                           # step below needs it for GEOGRAPHY(Point,4326) etc.
  "redis>=5.0.3", "celery>=5.3.6", "aioredis>=2.0.1", "httpx>=0.27.0",
  "python-dotenv>=1.0.1", "pydantic-settings>=2.2.1",
  "geopandas>=0.14.3", "shapely>=2.0.3", "anthropic>=0.21.3", "openai>=1.14.2",
]

[tool.poetry]
package-mode = false

[tool.poetry.group.dev.dependencies]
pytest = "^8.1.1"
pytest-asyncio = "^0.23.6"
httpx = "^0.27.0"
black = "^24.3.0"
ruff = "^0.3.4"
mypy = "^1.9.0"

[tool.poetry.group.ml]
optional = true

[tool.poetry.group.ml.dependencies]
torch = ">=2.2.1"
torchvision = ">=0.17.1"
torch-geometric = ">=2.5.2"
stable-baselines3 = ">=2.2.1"
gymnasium = ">=0.29.1"
ray = {version = ">=2.10.0", extras = ["rllib"]}
flwr = ">=1.8.0"
faster-whisper = ">=1.0.1"
mlflow = ">=2.11.1"
qdrant-client = ">=1.8.2"
```

```bash
cd backend
poetry lock
poetry install              # main + dev only — fast, no ML stack
# poetry install --with ml  # run this instead once Phase 2/3 ML work starts
```

### Step 4 — Docker Compose base

```yaml
# infra/docker-compose.yml
version: "3.9"
services:
  postgres:
    image: postgis/postgis:16-3.4
    environment:
      POSTGRES_DB: adaptivemap
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  valhalla:
    image: ghcr.io/gis-ops/docker-valhalla/valhalla:latest
    volumes:
      - ./valhalla/custom_files:/custom_files
      - valhalla_tiles:/tiles
    ports:
      - "8002:8002"
    environment:
      # False for the FIRST build so the image's entrypoint actually processes
      # the .osm.pbf in custom_files/ and writes tiles; True afterwards so
      # restarts skip rebuilding and just load the cached valhalla_tiles.tar.
      - use_tiles_ignore_pbf=True

  # Serves the self-hosted basemap (see "Self-hosted basemap tiles" under
  # Week 1-2) from a Planetiler-built PMTiles file — not from PostGIS, at
  # least not yet. Martin can serve PostGIS directly too, which is the planned
  # path once crowdsourced dashcam updates need a live/dynamic tile layer.
  martin:
    image: ghcr.io/maplibre/martin:latest
    volumes:
      - ./data/tiles:/tiles
    ports:
      - "3001:3000"
    command: --listen-addresses 0.0.0.0:3000 /tiles

  qdrant:
    image: qdrant/qdrant:latest
    ports:
      - "6333:6333"
    volumes:
      - qdrant_data:/qdrant/storage

  mlflow:
    image: ghcr.io/mlflow/mlflow:v2.11.1
    ports:
      - "5000:5000"
    command: mlflow server --host 0.0.0.0 --backend-store-uri sqlite:///mlflow.db

  backend:
    build: ./backend
    depends_on: [postgres, redis, valhalla, qdrant]
    ports:
      - "8000:8000"
    env_file: .env

  celery_worker:
    build: ./backend
    command: celery -A services.celery_app worker --loglevel=info
    depends_on: [postgres, redis]
    env_file: .env

  frontend:
    build: ./frontend
    ports:
      - "3000:3000"

volumes:
  postgres_data:
  valhalla_tiles:
  qdrant_data:
```

### Step 5 — Environment variables (.env file, never commit this)

```bash
# .env
DATABASE_URL=postgresql+asyncpg://user:password@postgres:5432/adaptivemap
REDIS_URL=redis://redis:6379/0
ANTHROPIC_API_KEY=your_key_here
VALHALLA_URL=http://valhalla:8002
QDRANT_URL=http://qdrant:6333
MLFLOW_TRACKING_URI=http://mlflow:5000
SECRET_KEY=generate_a_long_random_string_here
```

**Hostnames like `postgres`, `valhalla`, `martin` only resolve inside the Docker Compose network.** Any tool you run directly on your laptop (Alembic migrations, a one-off `psql`, `backend/config.py`'s `valhalla_url` default when running FastAPI outside Docker) needs `localhost` instead, using the same port each service publishes to the host (`localhost:5432`, `localhost:8002`, `localhost:3001`). `backend/db/migrations/env.py` handles this automatically for Alembic — it reads `DATABASE_URL`, swaps `postgresql+asyncpg://` for `postgresql+psycopg2://` (Alembic runs synchronously), and rewrites `@postgres:5432` to `@localhost:5432` — with an `ALEMBIC_DATABASE_URL` env var available to override entirely if needed. `backend/config.py` similarly defaults `valhalla_url` to `http://localhost:8002` rather than hardcoding the container hostname.

---

## Phase 1 — Base Route Planner (Weeks 1–8)

**Goal by end of Phase 1:** A working web app where a user can type an origin and destination, get a route drawn on a map, and drive it with basic turn-by-turn navigation. No ML yet — clean, fast, correct.

---

### Week 1–2 — OSM Data Pipeline + PostGIS Schema

**Who:** Jonathan on PostGIS, You on Valhalla config

#### Get OSM data

Download a regional extract to start (your city or state, not the whole world yet), then crop further to a small bounding box for fast local dev iteration — a tiny extract (~1MB) means Valhalla/Planetiler builds finish in seconds instead of the 15–45 minutes a full-state extract takes. Use Geofabrik for the state download, `osmium extract` for the crop.

```bash
#!/bin/bash
# data/download_osm.sh
set -e

mkdir -p data/osm

echo "Downloading Texas OSM extract..."
# macOS doesn't ship wget by default — curl is the portable choice here.
curl -L "https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf" -o data/osm/texas.osm.pbf || true

echo "Cropping to Central Arlington bounding box..."
# Bounding box: I-30, W Park Row Dr, Fielder Rd, Collins St
# BBox format: min_lon,min_lat,max_lon,max_lat
osmium extract -b -97.140,32.715,-97.080,32.760 data/osm/texas.osm.pbf -o data/osm/region.osm.pbf --overwrite

echo "Verifying the cropped extract..."
osmium fileinfo data/osm/region.osm.pbf
```

This produces two files, both gitignored (regenerate via this script, never commit — `texas.osm.pbf` is ~700MB):
- `data/osm/texas.osm.pbf` — the full state extract, kept around so re-cropping to a different/larger bbox later doesn't require re-downloading.
- `data/osm/region.osm.pbf` — the actual ~1MB extract everything else in Week 1–2 (Valhalla tiles, Planetiler basemap tiles) builds from. Swap the bounding box and re-run once you're ready to cover more than one small area — everything downstream (Valhalla, Planetiler) rebuilds from this file unchanged.

#### Build Valhalla tiles from OSM data

**Do not use `valhalla_build_config`/`valhalla_build_tiles` directly — that's for the generic Valhalla image.** The `ghcr.io/gis-ops/docker-valhalla/valhalla` image used in `docker-compose.yml` ships its own entrypoint that builds tiles automatically from whatever `.osm.pbf` it finds in the mounted `/custom_files` directory — running the raw commands against this image either does nothing useful or duplicates what the entrypoint already does.

```bash
# 1. Put the extract where the container's entrypoint looks for it
cp data/osm/region.osm.pbf valhalla/custom_files/region.osm.pbf

# 2. First build: set use_tiles_ignore_pbf=False in docker-compose.yml's valhalla
#    service (see Step 4) so the entrypoint actually processes the .pbf instead
#    of looking for a tile.tar that doesn't exist yet.

# 3. Build + start — the entrypoint builds tiles, tars them, THEN starts
#    valhalla_service on 8002. Watch the logs for "Successfully built files"
#    and "Starting valhalla service!"
docker compose -f infra/docker-compose.yml --project-directory . up -d valhalla
docker logs -f gloway-valhalla-1

# 4. Once built, flip use_tiles_ignore_pbf back to True and restart — this
#    skips the pbf hash-check/rebuild and just loads the cached
#    valhalla_tiles.tar, so subsequent starts are near-instant.
docker compose -f infra/docker-compose.yml --project-directory . up -d valhalla
```

For our ~1MB Central Arlington extract this whole build takes seconds, not the 15–45 minutes a full-state build would (which is exactly why Week 1–2's OSM step crops to a small bbox first — see above). Verify with a real route request, not just "the container started":

```bash
curl -s http://localhost:8002/route --data \
  '{"locations":[{"lat":32.720,"lon":-97.130},{"lat":32.755,"lon":-97.090}],"costing":"auto"}'
```

A response with real street names in `maneuvers[].instruction` confirms the tiles are actually routable, not just that the service is up.

#### Self-hosted basemap tiles (not in the original plan — needed for the frontend map, and for startup-safe licensing)

The routing tiles above make Valhalla answer "what's the route" — a separate thing entirely is the **visual basemap** MapLibre renders in the browser (roads, buildings, labels, water). The original plan didn't cover this at all. Whatever you reach for here has real licensing implications for a commercial product — worth getting right before it's load-bearing:

| Option | Free for a startup? | Why / why not |
|---|---|---|
| CARTO hosted tiles (`basemaps.cartocdn.com`) | Free tier exists, but a third-party service you don't control — no SLA, rate limits, terms can change | Fine for throwaway prototyping, not for anything load-bearing |
| MapTiler Cloud hosted tiles | **No** — free tier is explicitly "non-commercial use" only; commercial use requires a paid plan | A startup using this "for free" is violating their ToS |
| Protomaps hosted API | **No** — free up to 1M requests/mo, but commercial use past that requires a paid GitHub Sponsorship | Same "free tier ≠ free for startups" pattern as MapTiler |
| **Self-hosted: Planetiler → PMTiles → Martin** | **Yes, unambiguously** | Planetiler (BSD-3) generates OpenMapTiles-schema tiles from data *you already downloaded* (`region.osm.pbf`); Martin (already in the tech stack table) serves the result. No third party, no rate limit, no ToS to violate. |

The OpenMapTiles schema itself is BSD-3 (code) + CC-BY 4.0 (cartography design) — free for commercial use, **with a visible attribution requirement**: `© OpenMapTiles © OpenStreetMap contributors`. Martin's `/catalog` endpoint embeds this attribution automatically once you generate a tileset via Planetiler's default profile.

```bash
# Generate self-hosted vector tiles from the same extract used for Valhalla.
# Default Planetiler output IS the OpenMapTiles schema — no extra flag needed.
# --download fetches small one-time public-domain auxiliary layers (water
# polygons, Natural Earth, lake centerlines) into data/sources/ (~1.3GB,
# gitignored, cached after first run).
mkdir -p data/tiles
docker run --rm -e JAVA_TOOL_OPTIONS="-Xmx2g" -v "$(pwd)/data:/data" \
  ghcr.io/onthegomap/planetiler:latest \
  --osm-path=/data/osm/region.osm.pbf \
  --output=/data/tiles/region.pmtiles \
  --download
```

This produces a single `.pmtiles` file (a few hundred KB for our small extract). Martin serves it directly — see the `martin` service in Step 4's `docker-compose.yml` above — exposing normal `{z}/{x}/{y}` tile endpoints at `http://localhost:3001/region/...` plus a TileJSON at `http://localhost:3001/region`.

**Frontend wiring gotcha, whenever the frontend is wired to this tile source:** MapLibre's tile fetches run inside a Blob-URL Web Worker, which cannot resolve *relative* tile URL templates (`new Request()` throws `Failed to parse URL from /api/tiles/...` — silently breaks every tile request, no visible error unless you check the console). Don't bake a relative or absolute-with-hardcoded-host path into a committed style JSON; resolve the tile source's `tiles` array against `window.location.origin` at map-construction time instead, right before constructing `new maplibregl.Map(...)` — this also keeps the style file itself environment-agnostic across dev/staging/prod.

**Vector tile style:** don't write a MapLibre style from scratch. [OpenFreeMap](https://openfreemap.org)'s published styles (`liberty`, etc.) are free, open-source (same BSD/CC0 license family), built for exactly this schema, and already include a `building-3d` fill-extrusion layer. Vendor one into the frontend and repoint its `sources.openmaptiles` at your own Martin instance instead of OpenFreeMap's — fonts/sprites can stay pointed at OpenFreeMap's free CDN since they're generic cartographic assets, not map data.

**Future production path (not needed yet):** the `.pmtiles` format (stewarded by Protomaps, public domain) can be served with *no* backend process at all — MapLibre can fetch byte ranges directly from a static file on S3/Cloudflare R2/GitHub Pages via the `pmtiles` JS protocol plugin. That's the cheapest option for a basemap that rebuilds occasionally. Martin stays relevant specifically because it can *also* serve tiles directly from PostGIS — the path for once crowdsourced dashcam updates need to render as a live/dynamic tile layer (`road_segments`), which a frozen static file fundamentally can't do. Don't switch to serverless PMTiles until there's actual cost/scale pressure; Martin already unifies tooling with the Postgres/PostGIS stack Week 1–2 sets up.

Add to `.gitignore` (all regenerable, all potentially large — never commit):
```
data/osm/*.pbf
data/tiles/
data/sources/
valhalla/custom_files/*
!valhalla/custom_files/.gitkeep
```

#### PostGIS schema

**Don't hand-write this SQL and run it directly — define it as SQLAlchemy models and let Alembic autogenerate the migration.** The shape below is still the target schema (kept for reference), but the actual source of truth is `backend/db/models.py`; there is no `db/migrations/001_initial_schema.sql` file on disk. Two changes from a literal reading of this SQL:

- **`gen_random_uuid()` instead of `uuid_generate_v4()`/`uuid-ossp`.** Postgres 16 (what `docker-compose.yml` runs) has `gen_random_uuid()` built into core — one less extension to install and manage. Functionally identical output (random v4 UUIDs).
- **`postgis` extension only** — drop the `uuid-ossp` `CREATE EXTENSION` line.

```sql
-- Target schema shape (reference only — source of truth is db/models.py)
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  onboarding_completed BOOLEAN DEFAULT FALSE
);

CREATE TABLE user_preferences (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  avoid_highways BOOLEAN DEFAULT FALSE,
  avoid_tolls BOOLEAN DEFAULT FALSE,
  avoid_left_turns BOOLEAN DEFAULT FALSE,
  prefer_scenic BOOLEAN DEFAULT FALSE,
  max_acceptable_detour_minutes INT DEFAULT 5,
  preference_vector FLOAT[] DEFAULT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id)
);

CREATE TABLE trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  origin GEOGRAPHY(POINT, 4326) NOT NULL,
  destination GEOGRAPHY(POINT, 4326) NOT NULL,
  suggested_route JSONB NOT NULL,
  actual_path_taken JSONB DEFAULT NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ DEFAULT NULL,
  context JSONB DEFAULT '{}',
  implicit_signals JSONB DEFAULT '{}',
  explicit_feedback TEXT DEFAULT NULL,
  reward_value FLOAT DEFAULT NULL
);

CREATE INDEX idx_trips_origin ON trips USING GIST(origin);
CREATE INDEX idx_trips_destination ON trips USING GIST(destination);
CREATE INDEX idx_trips_user_id ON trips(user_id);

CREATE TABLE road_segments (
  id BIGSERIAL PRIMARY KEY,
  osm_way_id BIGINT,
  geom GEOGRAPHY(LINESTRING, 4326) NOT NULL,
  name VARCHAR(255),
  highway_type VARCHAR(50),
  speed_limit_kph INT,
  lanes INT,
  one_way BOOLEAN DEFAULT FALSE,
  last_verified_at TIMESTAMPTZ DEFAULT NOW(),
  confidence_score FLOAT DEFAULT 1.0
);

CREATE INDEX idx_road_segments_geom ON road_segments USING GIST(geom);
```

**Actual steps, in order:**

1. Add `geoalchemy2>=0.14.0` to `pyproject.toml` (already covered in Step 3 above) — needed for `Geography`/`Geometry` column types in SQLAlchemy.
2. Bring up Postgres: `docker compose -f infra/docker-compose.yml --project-directory . up -d postgres`.
3. Write `backend/db/base.py` (`Base = DeclarativeBase` subclass) and `backend/db/models.py` (the 4 tables above as SQLAlchemy 2.0 ORM models — `UUID(as_uuid=True)` + `server_default=text("gen_random_uuid()")` for PKs, `geoalchemy2.Geography(geometry_type=..., srid=4326, spatial_index=True)` for spatial columns, `sqlalchemy.dialects.postgresql.JSONB` for JSON columns, an explicit `Index("idx_trips_user_id", "user_id")` since `spatial_index=True` only auto-creates the *spatial* GIST indexes).
4. `cd backend && poetry run alembic init db/migrations`, then edit `db/migrations/env.py`:
   - `target_metadata = Base.metadata` (import `db.base.Base` and `db.models` so every model registers).
   - **Required, not optional:** wire a custom `include_object` into `context.configure(...)`. The `postgis/postgis` Docker image auto-creates `postgis_tiger_geocoder`/`postgis_topology` extension tables (`county`, `state`, `edges`, `topology`, `layer`, ~30 more) directly in `public` on database init. Without filtering these out, the *first* `alembic revision --autogenerate` proposes `DROP TABLE` for all of them. Fix: skip any reflected table with no corresponding SQLAlchemy model (`type_ == "table" and reflected and compare_to is None`), combined with `geoalchemy2.alembic_helpers.include_object` (which only filters `spatial_ref_sys`, not the tiger/topology tables — insufficient alone).
   - Use `geoalchemy2.alembic_helpers.render_item` (renders `Geography`/`Geometry` types correctly instead of falling back to plain `String`) and `.writer` for `process_revision_directives`.
   - A `get_url()` helper implementing the `localhost`-vs-container-hostname + async-vs-sync-driver rewrite described in Step 5 above.
5. `poetry run alembic revision --autogenerate -m "initial schema"`, then **manually add `op.execute("CREATE EXTENSION IF NOT EXISTS postgis")`** at the top of `upgrade()` — autogenerate never emits `CREATE EXTENSION` statements — and verify the diff only touches the 4 tables above (no stray tiger/topology drops) before applying.
6. `poetry run alembic upgrade head`.

```bash
cd backend
poetry run alembic init db/migrations
# edit env.py per the steps above — this is NOT optional, autogenerate breaks without it
poetry run alembic revision --autogenerate -m "initial schema"
# manually add CREATE EXTENSION postgis + review the diff
poetry run alembic upgrade head
```

---

## Map Data Abstraction Layer

**Build this in Week 1–2, alongside the OSM pipeline above, before writing any enrichment or use-case code (EV charging, delivery, cycling, scenic scoring, etc.).**

### Why this exists

We are not modifying Valhalla's C++ core, and we are not choosing between OSM and Overture Maps as a one-time decision. The differentiation for this product (personalization, use-case-specific routing, richer place data) lives in layers *above* the routing engine, and those layers must not be hardwired to one map data provider. OSM is what we build on first — it's free, mature, and has the only production-ready pipeline into Valhalla tiles. Overture Maps may get added later purely for cleaner places/addresses/buildings data (see the Tech Stack table above), but that is an implementation swap, not an architecture change, **if and only if** every enrichment feature is written against a stable interface from day one instead of calling OSM directly.

Two data paths exist in this system and they are **not** the same thing:

1. **Routing graph data** — the OSM `.pbf` extract that gets built into Valhalla tiles offline (Week 1–2, above). This stays OSM-only for the foreseeable future; there is no mature Overture-to-routing-graph pipeline yet. Nothing in this section changes that.
2. **Places / addresses / enrichment data** — POIs (EV chargers, parks, restaurants, parking), geocoding, and any per-use-case metadata (bike lane tags, safety scores, etc.). **This** is the path that gets abstracted, because this is where a provider swap or blend is plausible.

### The hard rule for the coding agent

> **No code outside `backend/mapdata/` may import `httpx`/`requests` and call Overpass, Nominatim, or Overture directly.** Every place lookup, every geocode call, every POI query goes through `mapdata.factory.get_map_data_source()`. If you are writing an enrichment feature (EV charging waypoints, delivery stop geocoding, cycling POI overlays, anything in Phase 2/3 that needs "find me X near Y") and you catch yourself constructing an Overpass query or a Nominatim URL inline — stop, and add the method to `MapDataSource` instead. This is the one architectural rule in this document with zero exceptions.

### `backend/mapdata/models.py` — the shared vocabulary

Every implementation of `MapDataSource` translates its provider's schema into these types. Business logic never sees an OSM tag or an Overture schema field — it sees a `Place` with a `PlaceCategory`.

```python
# backend/mapdata/models.py
"""Normalized data models shared by every MapDataSource implementation.

Enrichment code (EV charging, delivery, cycling, geocoding, ...) is written
against these types only. Translation from a provider's native schema (OSM
tags, Overture's GERS schema, a future custom feed) happens exactly once,
inside that provider's MapDataSource implementation. This is what makes
adding or blending a second provider a same-day change instead of a rewrite.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class PlaceCategory(str, Enum):
    """Common category taxonomy across all providers.

    Add new members here as new use cases need them (e.g. a ``PLAYGROUND``
    category for a "parent mode"). Never invent a provider-specific string in
    calling code — every MapDataSource implementation is responsible for
    mapping its own vocabulary onto this enum, including an ``OTHER`` fallback
    for anything unmapped.
    """

    EV_CHARGING = "ev_charging"
    FUEL = "fuel"
    PARKING = "parking"
    PARK = "park"
    RESTAURANT = "restaurant"
    GROCERY = "grocery"
    LODGING = "lodging"
    BIKE_PARKING = "bike_parking"
    TRANSIT_STOP = "transit_stop"
    OTHER = "other"


@dataclass(frozen=True)
class BBox:
    min_lat: float
    min_lon: float
    max_lat: float
    max_lon: float


@dataclass(frozen=True)
class Place:
    """A single point of interest, normalized across providers."""

    id: str                        # provider-prefixed, e.g. "osm:node/12345", "overture:place/abc"
    name: str | None
    category: PlaceCategory
    lat: float
    lon: float
    source: str                    # "osm" | "overture" | "custom:<provider>"
    # Raw provider tags/fields, kept for enrichment logic that needs specifics
    # a normalized field can't capture yet (e.g. EV connector type, plug count).
    # Reach for a new typed field on Place before reaching into metadata by hand
    # in more than one call site — that's the signal it should be promoted.
    metadata: dict = field(default_factory=dict)


@dataclass(frozen=True)
class Address:
    id: str
    formatted: str
    lat: float
    lon: float
    source: str
    metadata: dict = field(default_factory=dict)


@dataclass(frozen=True)
class RoutingGraphRef:
    """Pointer to a built routing graph (Valhalla tileset), not the graph itself.

    The routing graph is built offline from OSM only (see Week 1-2) regardless
    of which provider backs get_places/search_addresses. This type exists so
    the interface is complete and callers have one place to ask "which
    tileset/region am I routing against" without reaching into valhalla/
    config directly. ``source`` is expected to always be "osm" today.
    """

    region_id: str
    built_at: str
    source: str
```

### `backend/mapdata/base.py` — the interface

```python
# backend/mapdata/base.py
"""Abstract interface every map data source must implement.

Adding Overture, or blending it with OSM, means writing one new class in this
package and flipping `settings.map_data_source` in config.py — nothing above
this layer (API routes, enrichment logic, ML feature extraction) changes.
Every implementation must pass `backend/tests/mapdata/test_contract.py`
before it is wired into `factory.get_map_data_source()`.
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from mapdata.models import Address, BBox, Place, PlaceCategory, RoutingGraphRef


class MapDataSource(ABC):
    @abstractmethod
    async def get_places(self, category: PlaceCategory, bbox: BBox) -> list[Place]:
        """All places of one category inside bbox.

        Must return an empty list, never None or raise, when nothing matches —
        callers (e.g. EV charging waypoint insertion) treat "no results" as a
        normal case, not an error path.
        """

    @abstractmethod
    async def get_place_by_id(self, place_id: str) -> Place | None:
        ...

    @abstractmethod
    async def search_addresses(self, query: str, limit: int = 5) -> list[Address]:
        """Free-text geocoding. Replaces calling Nominatim/Overture geocoding
        directly from route handlers — see the Week 5-6 geocoding note below."""

    @abstractmethod
    async def get_routing_graph_ref(self, bbox: BBox) -> RoutingGraphRef:
        """Which built routing tileset covers this bbox. Metadata only —
        actual routing still goes through routing.valhalla_client."""
```

### `backend/mapdata/osm_source.py` — the v1 implementation

```python
# backend/mapdata/osm_source.py
"""OSM-backed MapDataSource — the only implementation needed through Phase 2.

Uses the public Overpass API for get_places/search_addresses (fine for
development and low query volume). Once query volume matters, replace
_query_raw_places'/`_query_raw_addresses`'s internals with reads against a
PostGIS table bulk-loaded from the same .pbf via osmium/imposm — the public
interface below does not change, so nothing calling this class needs to know
which one is happening.

get_routing_graph_ref always reports source="osm": the routing graph build
in valhalla/ is OSM-only regardless of what this class (or a future
OvertureMapDataSource/HybridMapDataSource) backs places/addresses with.
"""
from __future__ import annotations

import httpx

from mapdata.base import MapDataSource
from mapdata.models import Address, BBox, Place, PlaceCategory, RoutingGraphRef

_OVERPASS_URL = "https://overpass-api.de/api/interpreter"
_NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
_USER_AGENT = "AdaptiveMapApp/0.1 contact@yourapp.com"

# OSM (key, value) tag -> normalized category. Extend this as new use cases
# need new categories — this table is the ONLY place OSM tag vocabulary
# should appear outside of osm_source.py itself.
_OSM_TAG_TO_CATEGORY: dict[tuple[str, str], PlaceCategory] = {
    ("amenity", "charging_station"): PlaceCategory.EV_CHARGING,
    ("amenity", "fuel"): PlaceCategory.FUEL,
    ("amenity", "parking"): PlaceCategory.PARKING,
    ("leisure", "park"): PlaceCategory.PARK,
    ("amenity", "restaurant"): PlaceCategory.RESTAURANT,
    ("shop", "supermarket"): PlaceCategory.GROCERY,
    ("tourism", "hotel"): PlaceCategory.LODGING,
    ("amenity", "bicycle_parking"): PlaceCategory.BIKE_PARKING,
    ("highway", "bus_stop"): PlaceCategory.TRANSIT_STOP,
}
_CATEGORY_TO_OSM_TAG = {v: k for k, v in _OSM_TAG_TO_CATEGORY.items()}


class OSMMapDataSource(MapDataSource):
    def __init__(self, client: httpx.AsyncClient | None = None):
        self._client = client or httpx.AsyncClient(timeout=30.0)

    async def get_places(self, category: PlaceCategory, bbox: BBox) -> list[Place]:
        tag = _CATEGORY_TO_OSM_TAG.get(category)
        if tag is None:
            return []  # No OSM tag mapped for this category yet — not an error.
        key, value = tag

        query = f"""
        [out:json][timeout:25];
        node["{key}"="{value}"]
          ({bbox.min_lat},{bbox.min_lon},{bbox.max_lat},{bbox.max_lon});
        out body;
        """
        response = await self._client.post(_OVERPASS_URL, data={"data": query})
        response.raise_for_status()
        elements = response.json().get("elements", [])

        return [
            Place(
                id=f"osm:node/{el['id']}",
                name=el.get("tags", {}).get("name"),
                category=category,
                lat=el["lat"],
                lon=el["lon"],
                source="osm",
                metadata=el.get("tags", {}),
            )
            for el in elements
        ]

    async def get_place_by_id(self, place_id: str) -> Place | None:
        if not place_id.startswith("osm:node/"):
            return None
        node_id = place_id.removeprefix("osm:node/")
        query = f"[out:json][timeout:25]; node({node_id}); out body;"
        response = await self._client.post(_OVERPASS_URL, data={"data": query})
        response.raise_for_status()
        elements = response.json().get("elements", [])
        if not elements:
            return None
        el = elements[0]
        tags = el.get("tags", {})
        category = next(
            (cat for (k, v), cat in _OSM_TAG_TO_CATEGORY.items() if tags.get(k) == v),
            PlaceCategory.OTHER,
        )
        return Place(
            id=place_id, name=tags.get("name"), category=category,
            lat=el["lat"], lon=el["lon"], source="osm", metadata=tags,
        )

    async def search_addresses(self, query: str, limit: int = 5) -> list[Address]:
        response = await self._client.get(
            _NOMINATIM_URL,
            params={"q": query, "format": "json", "limit": limit},
            headers={"User-Agent": _USER_AGENT},
        )
        response.raise_for_status()
        return [
            Address(
                id=f"osm:{r['osm_type']}/{r['osm_id']}",
                formatted=r["display_name"],
                lat=float(r["lat"]),
                lon=float(r["lon"]),
                source="osm",
                metadata=r,
            )
            for r in response.json()
        ]

    async def get_routing_graph_ref(self, bbox: BBox) -> RoutingGraphRef:
        # Static for now — one region, one build. Once multiple regions exist,
        # look this up from the tileset manifest written by the Week 1-2 build.
        from config import settings

        return RoutingGraphRef(
            region_id=settings.routing_region_id, built_at=settings.routing_tiles_built_at,
            source="osm",
        )

    async def aclose(self) -> None:
        await self._client.aclose()
```

### `backend/mapdata/overture_source.py` — the future implementation (stub, not needed until OSM places are a measured bottleneck)

Written now, unimplemented on purpose, so the interface's completeness is proven today rather than assumed. Do not fill this in speculatively — build it only when a specific enrichment feature is blocked on OSM place-data quality (e.g. inconsistent/duplicate EV charger entries in a region).

```python
# backend/mapdata/overture_source.py
"""Overture Maps-backed MapDataSource.

Not implemented until OSM place data quality is a measured bottleneck for a
specific enrichment feature — see the Tech Stack table's note on Overture.
Kept here, unimplemented, so `MapDataSource` is proven complete against a
second provider's shape rather than assumed complete.

Expected implementation approach when this is built: query Overture's
released Parquet files (places/addresses/buildings themes) via `duckdb` with
the spatial extension, filtered by bbox — no live API to call, unlike OSM's
Overpass. `_OVERTURE_CATEGORY_TO_CATEGORY` below mirrors the structure of
`_OSM_TAG_TO_CATEGORY` in osm_source.py; Overture's category taxonomy
(https://docs.overturemaps.org/schema/concepts/by-theme/places/overture_categories/)
maps far more cleanly onto PlaceCategory than OSM's free-form tags do.
"""
from __future__ import annotations

from mapdata.base import MapDataSource
from mapdata.models import Address, BBox, Place, PlaceCategory, RoutingGraphRef

_OVERTURE_CATEGORY_TO_CATEGORY: dict[str, PlaceCategory] = {
    "electric_vehicle_charging_station": PlaceCategory.EV_CHARGING,
    "gas_station": PlaceCategory.FUEL,
    "parking_lot": PlaceCategory.PARKING,
    "park": PlaceCategory.PARK,
    "restaurant": PlaceCategory.RESTAURANT,
    "grocery_store": PlaceCategory.GROCERY,
    "hotel": PlaceCategory.LODGING,
    "bicycle_parking_station": PlaceCategory.BIKE_PARKING,
    "bus_stop": PlaceCategory.TRANSIT_STOP,
}


class OvertureMapDataSource(MapDataSource):
    async def get_places(self, category: PlaceCategory, bbox: BBox) -> list[Place]:
        raise NotImplementedError(
            "Build this when a specific feature is blocked on OSM place quality. "
            "See module docstring for the intended duckdb/Parquet approach."
        )

    async def get_place_by_id(self, place_id: str) -> Place | None:
        raise NotImplementedError

    async def search_addresses(self, query: str, limit: int = 5) -> list[Address]:
        raise NotImplementedError

    async def get_routing_graph_ref(self, bbox: BBox) -> RoutingGraphRef:
        # Overture has no mature routing-graph pipeline — this should never
        # actually be reached; routing graphs stay OSM-only (see osm_source.py).
        raise NotImplementedError("Routing graphs are OSM-only; use OSMMapDataSource for this.")
```

### `backend/mapdata/hybrid_source.py` — blending providers per-method

This is the payoff: when Overture is worth adding, it is *composed with* OSM per-method, not swapped in wholesale. Routing graph lookups keep going to OSM; places/addresses move to whichever provider is actually better once measured.

```python
# backend/mapdata/hybrid_source.py
"""Composes multiple MapDataSource implementations, one method at a time.

Example shape for when Overture lands: keep OSM for routing (the only mature
option) and move places/addresses to Overture (cleaner, deduped). Adjust which
source backs which method based on what you actually measure — this class is
a template, not a fixed policy.
"""
from __future__ import annotations

from mapdata.base import MapDataSource
from mapdata.models import Address, BBox, Place, PlaceCategory, RoutingGraphRef


class HybridMapDataSource(MapDataSource):
    def __init__(self, routing_source: MapDataSource, places_source: MapDataSource):
        self._routing_source = routing_source   # e.g. OSMMapDataSource
        self._places_source = places_source      # e.g. OvertureMapDataSource

    async def get_places(self, category: PlaceCategory, bbox: BBox) -> list[Place]:
        return await self._places_source.get_places(category, bbox)

    async def get_place_by_id(self, place_id: str) -> Place | None:
        return await self._places_source.get_place_by_id(place_id)

    async def search_addresses(self, query: str, limit: int = 5) -> list[Address]:
        return await self._places_source.search_addresses(query, limit)

    async def get_routing_graph_ref(self, bbox: BBox) -> RoutingGraphRef:
        return await self._routing_source.get_routing_graph_ref(bbox)
```

### `backend/mapdata/factory.py` — the single construction point

```python
# backend/mapdata/factory.py
"""Constructs the configured MapDataSource. This is the ONLY place in the
codebase that decides which provider(s) are active — everywhere else imports
the interface and calls this factory, never a concrete class directly.
"""
from __future__ import annotations

from mapdata.base import MapDataSource
from mapdata.osm_source import OSMMapDataSource
from mapdata.overture_source import OvertureMapDataSource
from mapdata.hybrid_source import HybridMapDataSource


def get_map_data_source() -> MapDataSource:
    from config import settings

    if settings.map_data_source == "osm":
        return OSMMapDataSource()
    if settings.map_data_source == "overture":
        return OvertureMapDataSource()
    if settings.map_data_source == "hybrid":
        return HybridMapDataSource(
            routing_source=OSMMapDataSource(), places_source=OvertureMapDataSource()
        )
    raise ValueError(f"Unknown map_data_source: {settings.map_data_source!r}")
```

Add to `backend/config.py`, following the existing `Settings` pattern:

```python
# backend/config.py — add alongside valhalla_url
map_data_source: str = "osm"        # "osm" | "overture" | "hybrid" — see mapdata/factory.py
routing_region_id: str = "dev-region"
routing_tiles_built_at: str = ""    # populated by the Week 1-2 tile build step
```

### `backend/tests/mapdata/test_contract.py` — the suite every implementation must pass

```python
# backend/tests/mapdata/test_contract.py
"""Shared behavioral contract for every MapDataSource implementation.

Parametrize over every concrete class as it's built (OSMMapDataSource now,
OvertureMapDataSource / HybridMapDataSource later). A new implementation is
not safe to wire into factory.get_map_data_source() until it passes this file.
"""
import pytest

from mapdata.models import BBox, PlaceCategory
from mapdata.osm_source import OSMMapDataSource

# Extend this list as new implementations are built:
IMPLEMENTATIONS = [OSMMapDataSource]

_EMPTY_OCEAN_BBOX = BBox(min_lat=0.0, min_lon=-30.0, max_lat=0.5, max_lon=-29.5)


@pytest.fixture(params=IMPLEMENTATIONS)
async def source(request):
    impl = request.param()
    yield impl
    if hasattr(impl, "aclose"):
        await impl.aclose()


@pytest.mark.integration
async def test_get_places_returns_empty_list_not_none(source):
    result = await source.get_places(PlaceCategory.EV_CHARGING, _EMPTY_OCEAN_BBOX)
    assert result == []


@pytest.mark.integration
async def test_search_addresses_returns_normalized_type(source):
    results = await source.search_addresses("Arlington, TX", limit=1)
    assert results
    assert results[0].lat and results[0].lon
    assert results[0].source


@pytest.mark.integration
async def test_get_routing_graph_ref_reports_osm_source(source):
    ref = await source.get_routing_graph_ref(_EMPTY_OCEAN_BBOX)
    assert ref.source == "osm"  # true regardless of implementation — see module docstrings
```

### What changes in Phase 1 Week 5–6 because of this

The `geocode()` helper shown later in this document under Week 5–6 is superseded by this layer. `backend/routing/geocoder.py` should not be written as a standalone Nominatim call — route handlers call `(await get_map_data_source().search_addresses(query))` instead. Keep this in mind when you reach that section below; the code shown there is kept for reference on the API shape being replaced, not something to implement as-is.

### How this plugs into later phases

- **Phase 2/3 enrichment features** (EV charging waypoint insertion, delivery stop geocoding, cycling POI overlays, scenic scoring) call `get_map_data_source().get_places(...)` for POIs and never touch a provider SDK directly.
- **The RL feature extraction** (`routing/rl_router.py`, Week 27–28) can enrich its route feature vector with place density/category counts from the same interface without knowing or caring which provider is behind it.
- **Switching or blending providers later costs one new file + one config value**, as promised — not a rewrite of enrichment logic, API routes, or ML feature extraction.

---

### Week 3–4 — Routing Engine + Custom Cost Functions

**Who:** You. This is your path planning background applied directly.

Valhalla uses a costing model to decide route quality. You need to build a custom costing layer that accepts user preference weights — this is the hook where RL weights will plug in later.

#### Valhalla custom costing (Python client)

**The costing translation below differs from a naive first pass in three ways, each found by probing a live Valhalla instance rather than trusting the docs alone — verify these against your own Valhalla version before relying on them:**

1. **`shortest` is a boolean, not a graduated float.** Wiring "urgency" to `shortest` with values like `0.0`/`0.2`/`0.5` is broken: `0.0` is falsy (no effect), any nonzero value flips it fully on, and turning it on produces a route that's *shorter in distance but slower in time* — the opposite of what an urgent driver wants. Urgency is not tied to `shortest` here.
2. **Out-of-range or wrong-typed costing values are silently ignored by Valhalla** — the route request still succeeds, just without the intended effect (e.g. `use_highways=5.0` behaves identically to not setting it at all, no error). Every value emitted below is therefore clamped to its valid range, so a preference can never silently no-op.
3. **`auto` costing has no left-turn-specific penalty.** `maneuver_penalty` penalizes *all* turns, not just left ones. `avoid_left_turns` is therefore only a coarse approximation in Phase 1 (fewer total turns correlates weakly with fewer left turns); precise left-turn avoidance needs a custom C++ costing model — later work, not a Phase 1 gap to "fix" by digging further into `costing_options`.

```python
# backend/routing/valhalla_client.py
"""Valhalla routing client + custom costing translation.

This module is the single bridge between *user preferences* and the routing
engine's cost model. In Phase 1 the preferences are produced by rule-based
logic (declared dislikes, the pre-trip "are you in a hurry?" question). In
Phase 3 the exact same UserRoutingPrefs struct will instead be produced by
the RL policy — a small per-user preference vector decoded into these weights.
Keeping that seam clean and stable now is what lets the learned model plug in
later without touching the routing plumbing.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Optional

import httpx

_DEFAULT_MANEUVER_PENALTY = 5.0   # seconds, Valhalla default
_MAX_MANEUVER_PENALTY = 300.0     # empirically enough to reshape local routes
_DEFAULT_LIVING_STREETS = 0.1     # Valhalla default use_living_streets


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


@dataclass
class UserRoutingPrefs:
    """User preference weights injected into Valhalla's cost model.

    Every field is a 0.0-1.0 intensity. 0.0 means "no opinion / don't apply",
    1.0 means "apply as strongly as the engine allows". This is the struct
    the RL policy will emit in Phase 3.
    """
    avoid_highways: float = 0.0    # 1.0 => avoid highways as much as possible
    avoid_tolls: float = 0.0       # 1.0 => avoid toll roads
    prefer_scenic: float = 0.0     # 1.0 => favour local/living streets over arterials
    avoid_left_turns: float = 0.0  # 1.0 => penalise turns (coarse proxy, see above)
    urgency: float = 0.5           # 0.0 leisurely ... 1.0 fastest-possible


class ValhallaRouter:
    """Async client for a Valhalla routing service.

    Owns an httpx.AsyncClient by default, or accepts a shared one (preferred
    inside a long-lived FastAPI app so connections are pooled). Use as an
    async context manager, or call aclose() on shutdown.
    """

    def __init__(self, base_url: str, client: Optional[httpx.AsyncClient] = None, timeout: float = 30.0):
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
        """Translate user preferences into Valhalla `auto` costing parameters.

        This is the RL injection point. All outputs are clamped to ranges the
        engine honours (see point 2 above).
        """
        avoid_highways = _clamp(prefs.avoid_highways)
        avoid_tolls = _clamp(prefs.avoid_tolls)
        prefer_scenic = _clamp(prefs.prefer_scenic)
        avoid_left_turns = _clamp(prefs.avoid_left_turns)
        urgency = _clamp(prefs.urgency)

        # use_highways: 0.0 avoids, 1.0 prefers. Start from the explicit
        # highway aversion, let a scenic preference push it further down, and
        # let high urgency pull it back up (a rushed driver tolerates a
        # highway even if mildly disliked).
        use_highways = 1.0 - 0.9 * avoid_highways
        use_highways -= 0.5 * prefer_scenic
        use_highways += 0.3 * (urgency - 0.5)  # +/-0.15 nudge around neutral
        use_highways = _clamp(use_highways)

        use_tolls = _clamp(1.0 - 0.9 * avoid_tolls)

        # Scenic routing leans on local/living streets, which Valhalla
        # otherwise keeps rare (default 0.1).
        use_living_streets = _clamp(_DEFAULT_LIVING_STREETS + 0.6 * prefer_scenic)

        maneuver_penalty = _DEFAULT_MANEUVER_PENALTY + (
            _MAX_MANEUVER_PENALTY - _DEFAULT_MANEUVER_PENALTY
        ) * avoid_left_turns

        return {
            "auto": {
                "use_highways": use_highways,
                "use_tolls": use_tolls,
                "use_living_streets": use_living_streets,
                "maneuver_penalty": maneuver_penalty,
                "shortest": False,  # see point 1 above — never derived from prefs
            }
        }

    async def get_route(
        self,
        origin: tuple[float, float],           # (lat, lon)
        destination: tuple[float, float],      # (lat, lon)
        waypoints: Optional[list[tuple[float, float]]] = None,
        prefs: Optional[UserRoutingPrefs] = None,
        alternatives: int = 3,                 # always request alternates for RL training data
    ) -> dict:
        if prefs is None:
            prefs = UserRoutingPrefs()

        locations = [{"lat": origin[0], "lon": origin[1]}]
        if waypoints:
            locations.extend({"lat": wp[0], "lon": wp[1]} for wp in waypoints)
        locations.append({"lat": destination[0], "lon": destination[1]})

        payload = {
            "locations": locations,
            "costing": "auto",
            "costing_options": self._build_costing_options(prefs),
            "alternates": alternatives,
            "directions_options": {"units": "miles", "language": "en-US", "narrative": True},
        }

        response = await self._client.post(
            f"{self.base_url}/route", content=json.dumps(payload),
            headers={"Content-Type": "application/json"},
        )
        response.raise_for_status()
        return response.json()

    async def get_isochrone(self, location: tuple[float, float], minutes: Optional[list[int]] = None) -> dict:
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
            f"{self.base_url}/isochrone", content=json.dumps(payload),
            headers={"Content-Type": "application/json"},
        )
        response.raise_for_status()
        return response.json()


def get_router(client: Optional[httpx.AsyncClient] = None) -> ValhallaRouter:
    """Construct a router pointed at the configured Valhalla service."""
    from config import settings
    return ValhallaRouter(settings.valhalla_url, client=client)
```

Add `valhalla_url` to `backend/config.py`'s `Settings` (see Step 5's note on `localhost` vs. container hostnames — the default should be `http://localhost:8002`, not the Docker service name, so this works when FastAPI runs directly on the host during development).

**Verification:** unit-test `_build_costing_options` directly (pure function, no network) — assert `avoid_highways=1.0` drives `use_highways` down, `prefer_scenic=1.0` raises `use_living_streets`, out-of-range inputs stay clamped to `[0, 1]`. Then one live integration test against a running Valhalla instance confirming `avoid_highways=1.0` actually changes the returned route's time/length — skip it automatically if Valhalla isn't reachable so the suite stays green without the routing engine running.

---

### Week 5–6 — FastAPI Backend

**Who:** Jonathan, with you reviewing the routing endpoints

#### Core API structure

```python
# backend/api/main.py

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from api.routes import routing, users, trips, feedback

app = FastAPI(title="Adaptive Map API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(routing.router, prefix="/api/v1/routing", tags=["routing"])
app.include_router(users.router, prefix="/api/v1/users", tags=["users"])
app.include_router(trips.router, prefix="/api/v1/trips", tags=["trips"])
app.include_router(feedback.router, prefix="/api/v1/feedback", tags=["feedback"])
```

```python
# backend/api/routes/routing.py

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from routing.valhalla_client import ValhallaRouter, UserRoutingPrefs
from db.session import get_db

router = APIRouter()

class RouteRequest(BaseModel):
    origin_lat: float
    origin_lon: float
    dest_lat: float
    dest_lon: float
    user_id: str | None = None
    declared_intent: str | None = None   # "hurry", "explore", "commute"
    waypoints: list[dict] = []

class RouteResponse(BaseModel):
    trip_id: str
    routes: list[dict]                    # Multiple route options
    recommended_index: int                # Which one we suggest (RL picks this later)
    estimated_minutes: float
    context_summary: str                  # Brief text: "Avoids your usual highway"

@router.post("/route", response_model=RouteResponse)
async def get_route(request: RouteRequest, db=Depends(get_db)):
    router_client = ValhallaRouter(settings.VALHALLA_URL)
    
    # Load user preferences if logged in
    prefs = UserRoutingPrefs()
    if request.user_id:
        user_prefs = await db.get_user_preferences(request.user_id)
        if user_prefs:
            prefs = UserRoutingPrefs(
                avoid_highways=user_prefs.avoid_highways,
                avoid_tolls=user_prefs.avoid_tolls,
                urgency=1.0 if request.declared_intent == "hurry" else 0.5
            )

    routes = await router_client.get_route(
        origin=(request.origin_lat, request.origin_lon),
        destination=(request.dest_lat, request.dest_lon),
        prefs=prefs
    )

    # Store trip in database (for RL training data)
    trip_id = await db.create_trip(
        user_id=request.user_id,
        origin=(request.origin_lat, request.origin_lon),
        destination=(request.dest_lat, request.dest_lon),
        suggested_route=routes,
        context={"declared_intent": request.declared_intent}
    )

    return RouteResponse(
        trip_id=str(trip_id),
        routes=routes.get("trip", {}).get("legs", []),
        recommended_index=0,
        estimated_minutes=routes["trip"]["summary"]["time"] / 60,
        context_summary="Route calculated based on your preferences."
    )
```

#### Key additional endpoints Jonathan needs to build

```
POST   /api/v1/users/register          — Create account + run onboarding
POST   /api/v1/users/login             — JWT auth
GET    /api/v1/users/{id}/profile      — Get full profile + preferences
PATCH  /api/v1/users/{id}/preferences  — Update preferences
POST   /api/v1/trips/{id}/gps-update   — Stream GPS position during trip
POST   /api/v1/trips/{id}/complete     — Mark trip done, trigger signal processing
POST   /api/v1/feedback/{trip_id}      — Submit post-trip text feedback
GET    /api/v1/routing/search          — Geocoding (place name → lat/lon)
```

For geocoding (turning "Austin, TX" into coordinates), do **not** call Nominatim directly from this route handler. Use the `MapDataSource` interface built in [Map Data Abstraction Layer](#map-data-abstraction-layer) — `OSMMapDataSource.search_addresses()` already wraps Nominatim, and going through the interface here is what makes a later Overture/hybrid swap free.

```python
# backend/api/routes/routing.py (search endpoint)

from mapdata.factory import get_map_data_source

@router.get("/search")
async def search_place(q: str):
    source = get_map_data_source()
    results = await source.search_addresses(q, limit=5)
    if not results:
        return {"results": []}
    return {"results": [{"lat": r.lat, "lon": r.lon, "display_name": r.formatted} for r in results]}
```

There is no separate `backend/routing/geocoder.py` — geocoding is a `MapDataSource` method, not a standalone routing concern.

---

### Week 7–8 — React Map Frontend

**Who:** Jonathan primarily, with you reviewing UX flow

#### MapLibre GL setup

```bash
cd frontend
npx create-react-app . --template typescript
npm install maplibre-gl @maplibre/maplibre-react-components zustand axios
npm install -D @types/maplibre-gl
```

#### Core map component

```tsx
// frontend/src/components/Map/MapView.tsx

import React, { useRef, useEffect, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

interface MapViewProps {
  onMapReady: (map: maplibregl.Map) => void;
}

export const MapView: React.FC<MapViewProps> = ({ onMapReady }) => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      // Use OSM-based free tiles from openfreemap.org for development
      // Switch to your own hosted tiles in production
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [-97.7431, 30.2672], // Austin, TX — change to your target area
      zoom: 13,
    });

    map.current.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.current.addControl(
      new maplibregl.GeolocateControl({ trackUserLocation: true }),
      'top-right'
    );

    map.current.on('load', () => {
      onMapReady(map.current!);
    });

    return () => map.current?.remove();
  }, [onMapReady]);

  return <div ref={mapContainer} style={{ width: '100%', height: '100vh' }} />;
};
```

```tsx
// frontend/src/components/Route/RouteLayer.tsx
// Draws the route polyline on the map

import { useEffect } from 'react';
import maplibregl from 'maplibre-gl';

interface RouteLayerProps {
  map: maplibregl.Map;
  geometry: GeoJSON.LineString;
  isRecommended?: boolean;
}

export const RouteLayer: React.FC<RouteLayerProps> = ({ map, geometry, isRecommended }) => {
  const layerId = `route-${Math.random().toString(36).substr(2, 9)}`;

  useEffect(() => {
    if (!map.isStyleLoaded()) return;

    map.addSource(layerId, { type: 'geojson', data: { type: 'Feature', geometry, properties: {} } });

    map.addLayer({
      id: layerId,
      type: 'line',
      source: layerId,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': isRecommended ? '#378ADD' : '#B4B2A9',
        'line-width': isRecommended ? 5 : 3,
        'line-opacity': isRecommended ? 1.0 : 0.5,
      },
    });

    // Fit map to route bounds
    if (isRecommended) {
      const coordinates = geometry.coordinates as [number, number][];
      const bounds = coordinates.reduce(
        (b, c) => b.extend(c as maplibregl.LngLatLike),
        new maplibregl.LngLatBounds(coordinates[0], coordinates[0])
      );
      map.fitBounds(bounds, { padding: 60 });
    }

    return () => {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(layerId)) map.removeSource(layerId);
    };
  }, [map, geometry]);

  return null;
};
```

#### Phase 1 milestone: what you should be able to demo

By end of Week 8, a user should be able to:

1. Open the web app
2. Type "Austin airport" in a search box
3. See 3 route options drawn on the map in different colors
4. Click one to see turn-by-turn directions in a sidebar
5. Have their route saved to the database automatically

---

## Phase 2 — LLM Conversation Layer (Weeks 9–16)

**Goal by end of Phase 2:** The app asks the user a smart, contextual question before every trip. After the trip it asks how it went. It uses those conversations to build a user profile and start generating structured preference signals.

---

### Week 9–10 — User Profile System + Claude API Integration

**Who:** Both. Jonathan builds the profile storage, You build the Claude integration.

#### User profile schema extension

Add this to your database migration:

```sql
-- db/migrations/002_user_profile_extended.sql

CREATE TABLE user_journey_profiles (
  user_id UUID REFERENCES users(id) PRIMARY KEY,
  
  -- From onboarding
  typical_use_cases TEXT[],         -- ['commute', 'errands', 'road_trips']
  stated_dislikes TEXT[],           -- ['highways', 'left_turns', 'toll_roads']
  home_location GEOGRAPHY(POINT, 4326),
  work_location GEOGRAPHY(POINT, 4326),
  
  -- Learned over time
  known_regular_routes JSONB DEFAULT '[]',   -- Detected recurring trips
  driving_persona JSONB DEFAULT '{}',        -- LLM-synthesized personality summary
  preferred_convo_style VARCHAR(20) DEFAULT 'brief',  -- 'brief', 'chatty', 'silent'
  
  -- Context patterns (learned)
  morning_routine_start_time TIME,
  typical_commute_duration_mins INT,
  
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Conversation history per trip (for LLM context)
CREATE TABLE trip_conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trip_id UUID REFERENCES trips(id),
  user_id UUID REFERENCES users(id),
  messages JSONB NOT NULL DEFAULT '[]',    -- [{role, content, timestamp}]
  preference_updates_extracted JSONB DEFAULT NULL,   -- What LLM parsed from this chat
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### Claude API wrapper

```python
# backend/ml/llm/claude_client.py

import anthropic
from typing import AsyncGenerator

client = anthropic.Anthropic()  # Reads ANTHROPIC_API_KEY from env

SYSTEM_PROMPT_CONVERSATION = """You are a personal driving assistant embedded in a navigation app.
Your job is to have brief, warm, context-aware conversations with the user about their upcoming trip.

Rules you must always follow:
1. Ask at most ONE question. If you need to say something, say it — do not ask.
2. Keep every message under 30 words. The user is about to start driving.
3. Use the user profile and context provided. Never ask something already in the profile.
4. After the trip, ask ONE brief question about their experience — 15 words max.
5. Never use jargon. Sound like a helpful friend, not a navigation app.

When extracting preferences from conversation, always output structured JSON."""

SYSTEM_PROMPT_EXTRACTOR = """You are a preference extraction system for a routing AI.
Your job is to read a conversation between a user and their navigation app, 
then extract structured driving preference signals.

Always respond in valid JSON only. Never include markdown, preamble, or explanation.

Output schema:
{
  "preference_updates": {
    "avoid_highways": null | true | false,
    "avoid_tolls": null | true | false,
    "prefers_scenic": null | true | false,
    "stress_aversion": null | float (0.0-1.0),
    "urgency_level": null | float (0.0-1.0)
  },
  "reward_delta": float,   // -1.0 (bad) to +1.0 (good) based on feedback sentiment
  "new_learned_facts": [],  // Any new facts to add to profile
  "confidence": float       // 0.0-1.0: how confident you are in these extractions
}"""

async def generate_pre_journey_message(
    user_profile: dict,
    trip_context: dict,
    traffic_summary: str,
    conversation_history: list = []
) -> str:
    """Generate the single smart question/statement before a trip."""
    
    context_block = f"""
USER PROFILE:
{user_profile}

CURRENT TRIP CONTEXT:
- Origin: {trip_context.get('origin_name', 'current location')}
- Destination: {trip_context.get('destination_name', 'destination')}
- Time: {trip_context.get('time_of_day')}
- Day: {trip_context.get('day_of_week')}
- Traffic: {traffic_summary}
- User is typically {trip_context.get('typical_behavior_at_this_time', 'unknown')}

Generate a single, brief, helpful opening message or question for this trip.
"""
    
    messages = conversation_history + [{"role": "user", "content": context_block}]
    
    response = client.messages.create(
        model="claude-haiku-4-5-20251001",   # Haiku for speed — low latency matters here
        max_tokens=100,
        system=SYSTEM_PROMPT_CONVERSATION,
        messages=messages
    )
    return response.content[0].text

async def extract_preferences_from_conversation(
    conversation: list[dict],
    trip_outcome: dict
) -> dict:
    """Parse a full trip conversation into structured preference signals for RL."""
    
    conversation_text = "\n".join(
        f"{m['role'].upper()}: {m['content']}" for m in conversation
    )
    
    prompt = f"""CONVERSATION:
{conversation_text}

TRIP OUTCOME:
- Duration: {trip_outcome.get('duration_minutes')} minutes
- Estimated duration was: {trip_outcome.get('estimated_minutes')} minutes  
- User deviated from suggested route: {trip_outcome.get('deviated', False)}
- Deviation count: {trip_outcome.get('deviation_count', 0)}

Extract driving preferences and compute reward delta from this conversation and outcome."""

    response = client.messages.create(
        model="claude-sonnet-4-6",    # Sonnet for deeper reasoning in extraction
        max_tokens=500,
        system=SYSTEM_PROMPT_EXTRACTOR,
        messages=[{"role": "user", "content": prompt}]
    )
    
    import json
    return json.loads(response.content[0].text)
```

---

### Week 11–12 — Pre-Journey Conversation Flow

**Who:** You (logic), Jonathan (API endpoint + frontend integration)

#### The conversation state machine

```python
# backend/ml/llm/conversation_engine.py

from enum import Enum
from dataclasses import dataclass, field
import redis.asyncio as aioredis
import json

class ConversationPhase(str, Enum):
    PRE_JOURNEY = "pre_journey"
    ACTIVE_NAVIGATION = "active_navigation"
    POST_JOURNEY = "post_journey"
    IDLE = "idle"

@dataclass
class ConversationState:
    trip_id: str
    user_id: str
    phase: ConversationPhase
    messages: list = field(default_factory=list)
    pre_journey_complete: bool = False
    llm_has_spoken: bool = False    # Enforce one-statement limit before departure

class ConversationEngine:
    def __init__(self, redis_client: aioredis.Redis):
        self.redis = redis_client
        self.STATE_TTL = 3600 * 6   # 6 hours

    async def save_state(self, state: ConversationState):
        await self.redis.setex(
            f"conv:{state.trip_id}",
            self.STATE_TTL,
            json.dumps(state.__dict__)
        )

    async def load_state(self, trip_id: str) -> ConversationState | None:
        data = await self.redis.get(f"conv:{trip_id}")
        if not data:
            return None
        d = json.loads(data)
        return ConversationState(**d)

    async def handle_user_message(
        self,
        trip_id: str,
        user_message: str,
        user_profile: dict,
        trip_context: dict
    ) -> dict:
        state = await self.load_state(trip_id)
        if not state:
            return {"error": "Trip conversation not found"}

        state.messages.append({
            "role": "user",
            "content": user_message,
            "timestamp": datetime.utcnow().isoformat()
        })

        if state.phase == ConversationPhase.PRE_JOURNEY:
            # Pre-journey: extract intent from user reply
            intent = await self._extract_intent_from_reply(user_message)
            
            # Mark pre-journey as done — do not ask more questions
            state.pre_journey_complete = True
            
            # Confirm and close the conversation
            confirmation = await self._generate_departure_confirmation(
                user_profile, trip_context, intent
            )
            
            state.messages.append({
                "role": "assistant",
                "content": confirmation,
                "timestamp": datetime.utcnow().isoformat()
            })
            
            await self.save_state(state)
            
            return {
                "response": confirmation,
                "extracted_intent": intent,
                "ready_to_navigate": True
            }

        elif state.phase == ConversationPhase.POST_JOURNEY:
            # Post-journey: extract feedback, update preference signals
            # This triggers async background processing
            from services.celery_tasks import process_trip_feedback
            process_trip_feedback.delay(trip_id, state.messages, user_message)
            
            ack = "Got it, I'll remember that for next time."
            state.messages.append({
                "role": "assistant",
                "content": ack,
                "timestamp": datetime.utcnow().isoformat()
            })
            await self.save_state(state)
            return {"response": ack, "feedback_processing": True}

    async def _extract_intent_from_reply(self, reply: str) -> dict:
        """Quick intent extraction from user's reply to the opening question."""
        urgency_keywords = ["late", "hurry", "rush", "fast", "quick"]
        scenic_keywords = ["slow", "easy", "explore", "no rush", "scenic"]
        
        reply_lower = reply.lower()
        return {
            "urgency": 0.9 if any(k in reply_lower for k in urgency_keywords) else
                      0.1 if any(k in reply_lower for k in scenic_keywords) else 0.5,
            "avoid_highways": "highway" in reply_lower and "avoid" in reply_lower
        }
```

#### Frontend: conversation UI component

```tsx
// frontend/src/components/Conversation/JourneyChat.tsx

import React, { useState } from 'react';

interface JourneyChatProps {
  tripId: string;
  onIntentConfirmed: (intent: Record<string, unknown>) => void;
}

export const JourneyChat: React.FC<JourneyChatProps> = ({ tripId, onIntentConfirmed }) => {
  const [messages, setMessages] = useState<{role: string; content: string}[]>([]);
  const [input, setInput] = useState('');
  const [isListening, setIsListening] = useState(false);

  const sendMessage = async (text: string) => {
    const userMsg = { role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);

    const response = await fetch(`/api/v1/trips/${tripId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    });

    const data = await response.json();
    setMessages(prev => [...prev, { role: 'assistant', content: data.response }]);

    if (data.ready_to_navigate) {
      setTimeout(() => onIntentConfirmed(data.extracted_intent), 1500);
    }
  };

  return (
    <div style={{ 
      position: 'absolute', bottom: 80, left: '50%', 
      transform: 'translateX(-50%)',
      width: '90%', maxWidth: 400,
      background: 'white', borderRadius: 16, padding: 16, boxShadow: '0 4px 20px rgba(0,0,0,0.15)'
    }}>
      {messages.map((m, i) => (
        <div key={i} style={{
          padding: '8px 12px', marginBottom: 8,
          background: m.role === 'assistant' ? '#EEF2FF' : '#F3F4F6',
          borderRadius: 10, fontSize: 14, lineHeight: 1.4,
          alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start'
        }}>
          {m.content}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && sendMessage(input)}
          placeholder="Reply..."
          style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid #E5E7EB' }}
        />
        <button onClick={() => sendMessage(input)} style={{ padding: '8px 16px' }}>
          Send
        </button>
      </div>
    </div>
  );
};
```

---

### Week 13–14 — Voice Pipeline

**Who:** You (faster-whisper + Coqui TTS server), Jonathan (frontend WebSocket)

#### Voice backend service

```python
# backend/ml/llm/voice_service.py

from faster_whisper import WhisperModel
import io, asyncio

# Load once at startup — keep in memory
_whisper_model = None

def get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        # "base" model: 74M params, runs on CPU in ~200ms on modern hardware
        # Upgrade to "small" or "medium" if accuracy isn't good enough
        _whisper_model = WhisperModel("base", device="cpu", compute_type="int8")
    return _whisper_model

async def transcribe_audio(audio_bytes: bytes) -> str:
    """Transcribe an audio chunk. Runs in thread pool to avoid blocking async event loop."""
    def _transcribe():
        model = get_whisper_model()
        audio_buffer = io.BytesIO(audio_bytes)
        segments, _ = model.transcribe(audio_buffer, beam_size=5, language="en")
        return " ".join(s.text.strip() for s in segments)
    
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _transcribe)

# Coqui TTS runs as a separate service (see docker-compose)
# Call it via HTTP:
async def synthesize_speech(text: str) -> bytes:
    """Convert text to speech via Coqui TTS server."""
    async with httpx.AsyncClient() as client:
        response = await client.post(
            "http://tts-service:5002/api/tts",
            params={"text": text, "speaker_id": "0", "style_wav": ""}
        )
        return response.content   # Returns WAV bytes
```

Add Coqui TTS to docker-compose.yml:

```yaml
  tts-service:
    image: synesthesiam/coqui-tts:latest
    ports:
      - "5002:5002"
    command: python -m TTS.server.server --model_name tts_models/en/ljspeech/glow-tts
```

#### WebSocket endpoint for real-time voice during navigation

```python
# backend/api/routes/voice.py

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from ml.llm.voice_service import transcribe_audio, synthesize_speech
from ml.llm.claude_client import generate_navigation_response

router = APIRouter()

@router.websocket("/ws/voice/{trip_id}")
async def voice_websocket(websocket: WebSocket, trip_id: str):
    """Real-time voice pipeline for active navigation.
    
    Flow: User speaks → audio bytes → Whisper → text → 
          Claude (Haiku, ~200ms) → text → Coqui TTS → audio bytes → user
    """
    await websocket.accept()
    
    try:
        while True:
            # Receive audio chunk from client (VAD-gated on frontend)
            audio_data = await websocket.receive_bytes()
            
            # Transcribe
            transcript = await transcribe_audio(audio_data)
            if not transcript.strip():
                continue
            
            # Only process safety-critical queries during navigation
            # Full LLM is reserved for pre/post journey
            response_text = await generate_navigation_response(
                trip_id=trip_id,
                user_query=transcript
            )
            
            # Synthesize and send back
            audio_response = await synthesize_speech(response_text)
            await websocket.send_bytes(audio_response)
            
    except WebSocketDisconnect:
        pass   # User ended session — normal
```

---

### Week 15–16 — Post-Journey Signal Collection

**Who:** You (Celery tasks, signal logic), Jonathan (trip completion endpoint)

#### GPS deviation detection

```python
# backend/services/signal_processor.py

from shapely.geometry import LineString, Point
import numpy as np

def compute_route_adherence(
    suggested_route_coords: list[tuple[float, float]],
    actual_gps_trace: list[tuple[float, float]],
    deviation_threshold_meters: float = 50.0
) -> dict:
    """Measure how closely user followed the suggested route.
    
    Returns signals that feed directly into the RL reward function.
    """
    if not actual_gps_trace or len(actual_gps_trace) < 2:
        return {"adherence_rate": None, "deviation_count": 0}

    route_line = LineString(suggested_route_coords)
    
    deviations = []
    for lat, lon in actual_gps_trace:
        point = Point(lon, lat)
        # Distance in degrees — convert to meters (~111,000m per degree)
        dist_degrees = route_line.distance(point)
        dist_meters = dist_degrees * 111_000
        deviations.append(dist_meters)
    
    deviations_array = np.array(deviations)
    off_route_mask = deviations_array > deviation_threshold_meters
    
    deviation_events = 0
    in_deviation = False
    for is_off in off_route_mask:
        if is_off and not in_deviation:
            deviation_events += 1
            in_deviation = True
        elif not is_off:
            in_deviation = False
    
    adherence_rate = 1.0 - (off_route_mask.sum() / len(off_route_mask))

    return {
        "adherence_rate": float(adherence_rate),
        "deviation_count": deviation_events,
        "max_deviation_meters": float(deviations_array.max()),
        "mean_deviation_meters": float(deviations_array.mean()),
    }

def compute_implicit_reward(
    route_adherence: dict,
    time_delta_minutes: float,       # Actual - estimated. Negative = arrived early.
    app_switch_count: int,           # How many times user switched away from the app
    trip_completed: bool
) -> float:
    """Compute a reward signal from implicit signals alone.
    
    This reward feeds the RL model when no explicit feedback is given.
    Range: -1.0 (very bad) to +1.0 (excellent)
    """
    if not trip_completed:
        return -0.5   # User abandoned the trip — penalize the route

    reward = 0.0
    
    # Route following is the strongest signal
    adherence = route_adherence.get("adherence_rate", 0.5)
    reward += (adherence - 0.5) * 1.2   # Centered at 0.5, scaled
    
    # Arriving faster than estimated is positive
    time_bonus = np.clip(-time_delta_minutes / 10.0, -0.3, 0.3)
    reward += time_bonus
    
    # App switches suggest frustration
    reward -= min(app_switch_count * 0.1, 0.3)
    
    return float(np.clip(reward, -1.0, 1.0))
```

```python
# backend/services/celery_tasks.py

from celery import Celery
from services.signal_processor import compute_route_adherence, compute_implicit_reward
from ml.llm.claude_client import extract_preferences_from_conversation
from db.session import sync_db_session

celery_app = Celery('adaptive_map', broker='redis://redis:6379/0')

@celery_app.task
def process_trip_completion(trip_id: str, gps_trace: list):
    """Called when user arrives. Computes implicit signals."""
    with sync_db_session() as db:
        trip = db.get_trip(trip_id)
        
        adherence = compute_route_adherence(
            trip.suggested_route_coords,
            gps_trace
        )
        
        implicit_reward = compute_implicit_reward(
            route_adherence=adherence,
            time_delta_minutes=trip.actual_duration - trip.estimated_duration,
            app_switch_count=trip.app_switch_count,
            trip_completed=True
        )
        
        db.update_trip_signals(trip_id, adherence, implicit_reward)

@celery_app.task
def process_trip_feedback(trip_id: str, conversation: list, final_feedback: str):
    """Called after post-trip chat. Extracts preference updates via Claude."""
    with sync_db_session() as db:
        trip = db.get_trip(trip_id)
        
        all_messages = conversation + [{"role": "user", "content": final_feedback}]
        trip_outcome = {
            "duration_minutes": trip.actual_duration,
            "estimated_minutes": trip.estimated_duration,
            "deviated": trip.deviation_count > 0,
            "deviation_count": trip.deviation_count
        }
        
        # Claude extracts structured preference updates
        extraction = extract_preferences_from_conversation(all_messages, trip_outcome)
        
        # Combine with implicit reward
        explicit_reward = extraction.get("reward_delta", 0.0)
        combined_reward = 0.6 * trip.implicit_reward + 0.4 * explicit_reward
        
        # Update user preferences + final reward value
        db.update_user_preferences(trip.user_id, extraction["preference_updates"])
        db.update_trip_reward(trip_id, combined_reward)
        
        # Trigger RL update (next phase)
        # update_rl_model.delay(trip.user_id, trip_id)
```

---

## Phase 3 — RL Personalization Engine (Weeks 17–28)

**Goal by end of Phase 3:** The routing model learns each user's preferences through driving. The more trips taken, the better and more personal the route suggestions become. The system also improves the base model for everyone using federated learning.

---

### Week 17–18 — GNN Map Encoder

**Who:** You. This is pure ML.

The road network is a graph. Graph Neural Networks learn node and edge representations by aggregating information from neighbors — perfect for learning which road segments are "good" in a routing context.

#### Graph construction from PostGIS

```python
# backend/ml/gnn/graph_builder.py

import torch
from torch_geometric.data import Data
import geopandas as gpd
from sqlalchemy import text

def build_road_graph_from_db(db_session, bbox: tuple) -> Data:
    """
    Construct a PyTorch Geometric graph from road segments in the database.
    
    Nodes = road junctions (intersections)
    Edges = road segments connecting those junctions
    
    Node features: [lat, lon, junction_type_onehot (4), traffic_signal (bool)]
    Edge features: [length_km, speed_limit_normalized, highway_type_onehot (8), 
                   lanes, is_one_way, avg_speed_ratio (actual/limit)]
    """
    min_lat, min_lon, max_lat, max_lon = bbox
    
    # Query road segments in bounding box
    segments_query = text("""
        SELECT osm_way_id, name, highway_type, speed_limit_kph, lanes, one_way,
               ST_AsGeoJSON(geom)::json as geom,
               ST_StartPoint(geom::geometry) as start_pt,
               ST_EndPoint(geom::geometry) as end_pt
        FROM road_segments
        WHERE ST_Intersects(
            geom::geometry,
            ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat, 4326)
        )
    """)
    
    segments = db_session.execute(segments_query, {
        "min_lat": min_lat, "min_lon": min_lon,
        "max_lat": max_lat, "max_lon": max_lon
    }).fetchall()

    # Build node index (junction coordinates → node id)
    node_coords = {}
    node_id = 0
    edges = []
    edge_features = []

    for seg in segments:
        start = (round(seg.start_pt.x, 5), round(seg.start_pt.y, 5))
        end = (round(seg.end_pt.x, 5), round(seg.end_pt.y, 5))

        for coord in [start, end]:
            if coord not in node_coords:
                node_coords[coord] = node_id
                node_id += 1

        src = node_coords[start]
        dst = node_coords[end]
        edges.append([src, dst])
        if not seg.one_way:
            edges.append([dst, src])

        speed_normalized = (seg.speed_limit_kph or 50) / 130.0
        highway_types = ['motorway','primary','secondary','tertiary',
                        'residential','unclassified','service','track']
        highway_onehot = [1.0 if h == seg.highway_type else 0.0 for h in highway_types]
        
        feat = [speed_normalized, seg.lanes or 1, float(seg.one_way)] + highway_onehot
        edge_features.append(feat)
        if not seg.one_way:
            edge_features.append(feat)

    node_list = sorted(node_coords.items(), key=lambda x: x[1])
    x = torch.tensor([[coord[0], coord[1]] for coord, _ in node_list], dtype=torch.float)
    edge_index = torch.tensor(edges, dtype=torch.long).t().contiguous()
    edge_attr = torch.tensor(edge_features, dtype=torch.float)

    return Data(x=x, edge_index=edge_index, edge_attr=edge_attr)
```

#### GNN model definition

```python
# backend/ml/gnn/model.py

import torch
import torch.nn as nn
from torch_geometric.nn import GATv2Conv, global_mean_pool

class RoadNetworkEncoder(nn.Module):
    """
    Graph Attention Network that encodes a road network subgraph 
    into a fixed-size vector. This vector is the 'state' for the RL agent.
    
    GATv2 (Graph Attention v2) learns which neighboring road segments 
    are most relevant for each junction — crucial for understanding 
    route quality from both a local and global perspective.
    """
    def __init__(
        self,
        node_features: int = 2,         # lat, lon
        edge_features: int = 11,         # speed, lanes, one_way + highway onehot
        hidden_dim: int = 64,
        output_dim: int = 128,           # The state vector the RL agent receives
        num_heads: int = 4,
        num_layers: int = 3
    ):
        super().__init__()
        
        self.node_encoder = nn.Linear(node_features, hidden_dim)
        self.edge_encoder = nn.Linear(edge_features, hidden_dim)
        
        self.conv_layers = nn.ModuleList([
            GATv2Conv(
                hidden_dim,
                hidden_dim // num_heads,
                heads=num_heads,
                edge_dim=hidden_dim,
                concat=True
            )
            for _ in range(num_layers)
        ])
        
        self.layer_norms = nn.ModuleList([
            nn.LayerNorm(hidden_dim) for _ in range(num_layers)
        ])
        
        self.output_proj = nn.Linear(hidden_dim, output_dim)
        self.dropout = nn.Dropout(0.1)

    def forward(self, data):
        x = self.node_encoder(data.x)
        edge_attr = self.edge_encoder(data.edge_attr)
        
        for conv, norm in zip(self.conv_layers, self.layer_norms):
            x_new = conv(x, data.edge_index, edge_attr)
            x = norm(x + x_new)      # Residual connection
            x = torch.relu(x)
            x = self.dropout(x)
        
        # Aggregate all node embeddings to a single graph-level vector
        graph_embedding = global_mean_pool(x, data.batch)
        return self.output_proj(graph_embedding)
```

---

### Week 19–20 — User Preference Embeddings

**Who:** You

Instead of a separate model per user (which doesn't scale), use a shared base model steered by a small per-user preference vector. This vector lives in Qdrant and is updated after every trip.

```python
# backend/ml/rl/preference_embedding.py

import torch
import torch.nn as nn
import numpy as np
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct

EMBEDDING_DIM = 32     # Small — one per user, updated often

class PreferenceEmbedding(nn.Module):
    """Per-user preference vector.
    
    Captures the dimensions of routing preference that matter to an individual.
    Not a route recommendation model itself — a steering vector that biases
    the base RL policy toward the user's personal style.
    """
    def __init__(self, embedding_dim: int = EMBEDDING_DIM):
        super().__init__()
        # Initialize at neutral — no strong preferences
        self.embedding = nn.Parameter(torch.zeros(embedding_dim))
        
    def forward(self) -> torch.Tensor:
        return torch.tanh(self.embedding)   # Bound to [-1, 1]

class PreferenceStore:
    def __init__(self, qdrant_url: str):
        self.client = QdrantClient(url=qdrant_url)
        self._ensure_collection()

    def _ensure_collection(self):
        collections = [c.name for c in self.client.get_collections().collections]
        if "user_preferences" not in collections:
            self.client.create_collection(
                "user_preferences",
                vectors_config=VectorParams(size=EMBEDDING_DIM, distance=Distance.COSINE)
            )

    def save_embedding(self, user_id: str, embedding: np.ndarray, metadata: dict = {}):
        self.client.upsert(
            collection_name="user_preferences",
            points=[PointStruct(
                id=user_id,     # User UUID as point ID
                vector=embedding.tolist(),
                payload={**metadata, "user_id": user_id}
            )]
        )

    def load_embedding(self, user_id: str) -> np.ndarray | None:
        results = self.client.retrieve(
            "user_preferences",
            ids=[user_id],
            with_vectors=True
        )
        if not results:
            return None
        return np.array(results[0].vector)

    def find_similar_users(self, user_id: str, top_k: int = 10) -> list[str]:
        """Cold-start bootstrapping: find users with similar preferences."""
        embedding = self.load_embedding(user_id)
        if embedding is None:
            return []
        
        results = self.client.search(
            "user_preferences",
            query_vector=embedding.tolist(),
            limit=top_k + 1    # +1 because the user themselves will appear
        )
        return [r.payload["user_id"] for r in results if r.payload["user_id"] != user_id]
```

---

### Week 21–22 — RL Training Pipeline

**Who:** You

```python
# backend/ml/rl/environment.py

import gymnasium as gym
import numpy as np
import torch
from ml.gnn.model import RoadNetworkEncoder
from ml.gnn.graph_builder import build_road_graph_from_db

class RouteEnvironment(gym.Env):
    """
    Custom Gymnasium environment for route optimization.
    
    State: [GNN graph embedding (128d)] + [user preference embedding (32d)] 
           + [context features (8d)] = 168-dim vector
    
    Action: Which road segment to traverse next (discrete, from current junction's neighbors)
    
    Reward: Injected from signal_processor — combination of implicit + LLM-extracted signals
    """
    def __init__(self, graph_data, user_embedding, preference_store, db):
        super().__init__()
        self.graph_data = graph_data
        self.user_embedding = user_embedding
        self.db = db
        
        self.gnn_encoder = RoadNetworkEncoder()
        self.gnn_encoder.eval()
        
        # Action space: up to 8 neighbors at any junction
        self.action_space = gym.spaces.Discrete(8)
        
        # State space: GNN (128) + user pref (32) + context (8)
        self.observation_space = gym.spaces.Box(
            low=-np.inf, high=np.inf, shape=(168,), dtype=np.float32
        )
        
        self.current_node = None
        self.destination_node = None
        self.visited_nodes = set()
        self.step_count = 0
        self.max_steps = 200

    def reset(self, origin_node=None, dest_node=None, seed=None):
        super().reset(seed=seed)
        self.current_node = origin_node or self._random_node()
        self.destination_node = dest_node or self._random_node()
        self.visited_nodes = {self.current_node}
        self.step_count = 0
        return self._get_observation(), {}

    def step(self, action: int):
        neighbors = self._get_neighbors(self.current_node)
        
        if action >= len(neighbors):
            # Invalid action — penalize
            return self._get_observation(), -0.1, False, False, {"invalid_action": True}
        
        next_node = neighbors[action]
        
        # Penalize revisiting nodes (prevents loops)
        if next_node in self.visited_nodes:
            reward = -0.05
        else:
            self.visited_nodes.add(next_node)
            # Small negative reward per step (encourages finding short routes)
            reward = -0.01
        
        self.current_node = next_node
        self.step_count += 1
        
        done = (next_node == self.destination_node)
        truncated = (self.step_count >= self.max_steps)
        
        if done:
            reward = 1.0    # Base reward for reaching destination
            # Final reward will be updated from trip signals (see below)
        
        return self._get_observation(), reward, done, truncated, {}

    def inject_trip_reward(self, reward: float):
        """Called after a real trip completes with the actual measured reward."""
        # This is how real-world signals enter the training loop
        # The RL model's last episode is updated with the true reward
        pass   # Implementation depends on your training loop setup

    def _get_observation(self) -> np.ndarray:
        with torch.no_grad():
            graph_emb = self.gnn_encoder(self.graph_data).numpy().flatten()
        
        context = np.array([
            self.step_count / self.max_steps,   # Progress
            # Add: time_of_day_sin, time_of_day_cos, is_weekend, etc.
            0, 0, 0, 0, 0, 0, 0                # Placeholder context features
        ], dtype=np.float32)
        
        return np.concatenate([graph_emb, self.user_embedding, context])

    def _get_neighbors(self, node_id: int) -> list[int]:
        edge_index = self.graph_data.edge_index
        mask = edge_index[0] == node_id
        return edge_index[1][mask].tolist()

    def _random_node(self) -> int:
        return np.random.randint(self.graph_data.num_nodes)
```

#### Training script

```python
# backend/ml/rl/train.py

from stable_baselines3 import PPO
from stable_baselines3.common.env_util import make_vec_env
from stable_baselines3.common.callbacks import EvalCallback, CheckpointCallback
import mlflow

def train_base_model(
    graph_data,
    total_timesteps: int = 1_000_000,
    run_name: str = "base_route_policy_v1"
):
    """Train the base route policy on synthetic routing tasks.
    
    This is Phase 1 of learning: supervised-style RL on random origin-destination pairs.
    No user preferences yet — just learning to navigate the road network efficiently.
    """
    with mlflow.start_run(run_name=run_name):
        env = make_vec_env(
            lambda: RouteEnvironment(graph_data, user_embedding=np.zeros(32)),
            n_envs=4   # Parallel environments for faster training
        )
        
        model = PPO(
            "MlpPolicy",
            env,
            learning_rate=3e-4,
            n_steps=2048,
            batch_size=64,
            n_epochs=10,
            gamma=0.99,
            gae_lambda=0.95,
            ent_coef=0.01,    # Entropy encourages exploration
            verbose=1,
            tensorboard_log="./tensorboard_logs/"
        )
        
        callbacks = [
            CheckpointCallback(save_freq=10_000, save_path="./models/checkpoints/"),
            EvalCallback(env, best_model_save_path="./models/best/", eval_freq=10_000)
        ]
        
        mlflow.log_params({
            "algorithm": "PPO",
            "total_timesteps": total_timesteps,
            "learning_rate": 3e-4,
            "n_envs": 4
        })
        
        model.learn(total_timesteps=total_timesteps, callback=callbacks)
        model.save("./models/base_route_policy")
        
        mlflow.log_artifact("./models/base_route_policy.zip")
        print(f"Training complete. Model saved.")
        
    return model

def fine_tune_for_user(
    base_model_path: str,
    user_id: str,
    user_embedding: np.ndarray,
    user_trips: list,    # Recent trip data with rewards
    timesteps: int = 50_000
):
    """Fine-tune the base model for a specific user using their trip history."""
    env = RouteEnvironment(graph_data=..., user_embedding=user_embedding)
    
    model = PPO.load(base_model_path, env=env)
    
    # Inject historical trip rewards into training data
    # This is where LLM-extracted rewards and implicit signals meet the RL model
    for trip in user_trips:
        if trip.reward_value is not None:
            env.inject_trip_reward(trip.reward_value)
    
    model.learn(total_timesteps=timesteps, reset_num_timesteps=False)
    model.save(f"./models/users/{user_id}/route_policy")
    
    return model
```

---

### Week 23–24 — Reward Function + Signal Fusion

**Who:** You, with Claude API

This is the component that ties together all the signals you've been collecting and produces a single reward value that the RL model can learn from.

```python
# backend/ml/rl/reward_engine.py

REWARD_EXTRACTOR_PROMPT = """You are a reward signal extractor for a routing AI system.
Given trip data and user feedback, compute a reward value from -1.0 to +1.0.

-1.0 = The route was very bad (user frustrated, took wrong way, much slower than expected)
 0.0 = The route was neutral (user followed it but gave no strong signal)
+1.0 = The route was excellent (user followed exactly, faster than expected, positive feedback)

Respond ONLY with a JSON object. No preamble.

Schema:
{
  "reward": float,              // -1.0 to +1.0
  "primary_signal": string,     // What drove this reward most?
  "preference_signals": {       // What should the system learn?
    "road_type_weights": {},
    "time_weights": {},
    "avoid_patterns": []
  },
  "confidence": float           // 0.0-1.0: how certain are you?
}"""

async def compute_final_reward(
    trip_id: str,
    implicit_signals: dict,     # From GPS tracking (adherence, deviations, time)
    explicit_feedback: str,     # User's post-trip conversation
    trip_context: dict          # What time, what route was suggested
) -> dict:
    """Fusion of implicit behavioral signals + LLM interpretation of explicit feedback."""
    
    # Weight: implicit signals are more reliable but less informative
    # Explicit feedback is richer but rarer and sometimes inaccurate
    
    # If no explicit feedback, rely entirely on implicit signals
    if not explicit_feedback or len(explicit_feedback.strip()) < 10:
        reward = implicit_signals.get("implicit_reward", 0.0)
        return {
            "reward": reward,
            "source": "implicit_only",
            "confidence": 0.6   # Lower confidence without explicit feedback
        }
    
    # Ask Claude to reason about all signals together
    prompt = f"""IMPLICIT SIGNALS (behavioral data from GPS tracking):
- Route adherence: {implicit_signals.get('adherence_rate', 'unknown')}
- Deviation events: {implicit_signals.get('deviation_count', 0)}
- Time vs estimate: {implicit_signals.get('time_delta_minutes', 0):+.1f} minutes
- App switches during trip: {implicit_signals.get('app_switch_count', 0)}
- Implicit reward score: {implicit_signals.get('implicit_reward', 0):.2f}

EXPLICIT USER FEEDBACK (post-trip conversation):
"{explicit_feedback}"

TRIP CONTEXT:
{trip_context}

Compute the final reward signal and extract preference updates."""

    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=400,
        system=REWARD_EXTRACTOR_PROMPT,
        messages=[{"role": "user", "content": prompt}]
    )
    
    import json
    return json.loads(response.content[0].text)
```

---

### Week 25–26 — Federated Learning

**Who:** You (Flower server), Jonathan (client API endpoint on mobile)

Federated learning lets user preferences improve the global model without any raw personal data ever leaving the user's device.

```python
# backend/ml/federated/flower_server.py

import flwr as fl
from flwr.server.strategy import FedAvg
import mlflow

class AdaptiveMapFedStrategy(FedAvg):
    """Custom federated strategy that weights contributions by trip count.
    
    Users who have taken more trips get more weight in the federated update —
    their preference embeddings are more reliable.
    """
    
    def aggregate_fit(self, server_round, results, failures):
        if not results:
            return None, {}
        
        # Weight each client's update by how many trips they've taken
        total_trips = sum(r.metrics.get("trip_count", 1) for _, r in results)
        weighted_results = [
            (r.parameters, r.metrics.get("trip_count", 1) / total_trips)
            for _, r in results
        ]
        
        aggregated = super().aggregate_fit(server_round, results, failures)
        
        if aggregated:
            mlflow.log_metric("federated_round", server_round)
            mlflow.log_metric("clients_this_round", len(results))
        
        return aggregated

def start_federated_server(num_rounds: int = 10):
    strategy = AdaptiveMapFedStrategy(
        min_fit_clients=3,        # Need at least 3 clients per round
        min_evaluate_clients=2,
        min_available_clients=3,
        fraction_fit=0.5          # Sample 50% of available clients each round
    )
    
    fl.server.start_server(
        server_address="0.0.0.0:8080",
        config=fl.server.ServerConfig(num_rounds=num_rounds),
        strategy=strategy
    )
```

```python
# backend/ml/federated/flower_client.py
# This runs on the user's device (mobile) or a per-user backend process

import flwr as fl
import torch
from ml.rl.preference_embedding import PreferenceEmbedding

class UserPreferenceClient(fl.client.NumPyClient):
    def __init__(self, user_id: str, local_trips: list):
        self.user_id = user_id
        self.model = PreferenceEmbedding()
        self.local_trips = local_trips  # The user's local trip data — never shared raw
    
    def get_parameters(self, config):
        return [p.detach().numpy() for p in self.model.parameters()]
    
    def fit(self, parameters, config):
        # Load global model parameters
        for p, new_p in zip(self.model.parameters(), parameters):
            p.data = torch.tensor(new_p)
        
        # Fine-tune locally on private trip data
        optimizer = torch.optim.Adam(self.model.parameters(), lr=1e-3)
        
        for trip in self.local_trips[-20:]:   # Use last 20 trips only
            if trip.reward_value is None:
                continue
            reward_tensor = torch.tensor([[trip.reward_value]], dtype=torch.float32)
            embedding = self.model()
            loss = -reward_tensor.mean() * embedding.norm()  # Simplified
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
        
        # Return updated parameters (gradients only — no raw trip data)
        return self.get_parameters(config={}), len(self.local_trips), {
            "trip_count": len(self.local_trips)
        }
    
    def evaluate(self, parameters, config):
        # Report local model performance back to server
        return 0.0, len(self.local_trips), {"user_id": self.user_id}
```

---

### Week 27–28 — Route Selection with RL

**Who:** You. Final integration of all ML components into the routing API.

```python
# backend/routing/rl_router.py

import torch
import numpy as np
from stable_baselines3 import PPO
from ml.gnn.model import RoadNetworkEncoder
from ml.rl.preference_embedding import PreferenceStore
from routing.valhalla_client import ValhallaRouter, UserRoutingPrefs

class RLEnhancedRouter:
    """The full stack router: Valhalla generates candidates, RL ranks them.
    
    Valhalla handles the hard graph traversal problem efficiently.
    RL uses learned preferences to select the best candidate for this user.
    """
    
    def __init__(self, valhalla_url: str, preference_store: PreferenceStore):
        self.valhalla = ValhallaRouter(valhalla_url)
        self.preference_store = preference_store
        self.gnn = RoadNetworkEncoder()
        self.gnn.eval()
        
        # Load base policy
        self.base_policy = PPO.load("./models/base_route_policy")

    async def get_personalized_route(
        self,
        user_id: str,
        origin: tuple[float, float],
        destination: tuple[float, float],
        declared_intent: str = None
    ) -> dict:
        """
        Full personalized routing:
        1. Get multiple route candidates from Valhalla
        2. Encode each with GNN
        3. Score each with user's RL policy + preference embedding
        4. Return ranked routes with recommended index
        """
        
        # Load user preference embedding (or zeros if new user)
        user_embedding = self.preference_store.load_embedding(user_id)
        if user_embedding is None:
            user_embedding = np.zeros(32)
            # Cold start: find similar users and average their embeddings
            similar_users = self.preference_store.find_similar_users(user_id)
            if similar_users:
                embeddings = [self.preference_store.load_embedding(u) for u in similar_users[:5]]
                valid = [e for e in embeddings if e is not None]
                if valid:
                    user_embedding = np.mean(valid, axis=0)
        
        # Get 3 route alternatives from Valhalla
        routes_response = await self.valhalla.get_route(
            origin, destination, alternatives=3
        )
        
        candidate_routes = routes_response.get("alternates", [])
        candidate_routes.insert(0, routes_response.get("trip"))
        
        # Score each route with RL model
        scored_routes = []
        for route in candidate_routes:
            if not route:
                continue
            
            # Build a feature vector for this route
            route_features = self._extract_route_features(route)
            
            # Combine with user preferences
            state = np.concatenate([
                route_features,
                user_embedding,
                self._encode_intent(declared_intent)
            ]).astype(np.float32)
            
            # Get RL policy's value estimate for this state
            with torch.no_grad():
                obs_tensor = torch.FloatTensor(state).unsqueeze(0)
                # Access the value network directly
                value = self.base_policy.policy.predict_values(obs_tensor)
                score = float(value.squeeze())
            
            scored_routes.append({"route": route, "rl_score": score})
        
        # Sort by RL score — highest score = recommended
        scored_routes.sort(key=lambda x: x["rl_score"], reverse=True)
        
        return {
            "routes": [r["route"] for r in scored_routes],
            "recommended_index": 0,   # After sorting, index 0 is always best
            "scores": [r["rl_score"] for r in scored_routes],
            "personalization_active": user_embedding.any()
        }
    
    def _extract_route_features(self, route: dict) -> np.ndarray:
        """Convert a Valhalla route object into a fixed-size feature vector."""
        summary = route.get("summary", {})
        legs = route.get("legs", [{}])
        
        # Count highway vs non-highway segments
        highway_ratio = 0.5  # Default — improve by parsing maneuvers
        
        return np.array([
            summary.get("time", 0) / 3600,           # Duration in hours (normalized)
            summary.get("length", 0) / 100,           # Distance in 100s of miles
            highway_ratio,
            len(legs[0].get("maneuvers", [])) / 50,  # Turn complexity
            0, 0, 0, 0, 0, 0, 0, 0                   # Placeholder — expand later
        ], dtype=np.float32)
    
    def _encode_intent(self, intent: str | None) -> np.ndarray:
        """One-hot encode declared intent."""
        intents = ["hurry", "explore", "commute", "none"]
        encoded = [1.0 if i == (intent or "none") else 0.0 for i in intents]
        return np.array(encoded + [0, 0, 0, 0], dtype=np.float32)  # Pad to 8
```

---

## Integration & End-to-End Testing

### The full journey integration test

After Phase 3, run this manually end-to-end before any real users touch the system:

```python
# tests/integration/test_full_journey.py

import pytest
import asyncio

@pytest.mark.asyncio
async def test_full_journey_happy_path():
    """Test the complete flow: signup → route → drive → feedback → learn."""
    
    # 1. Create user
    user = await api.post("/users/register", {
        "email": "test@example.com",
        "password": "testpass123"
    })
    user_id = user["id"]
    
    # 2. Set up profile
    await api.patch(f"/users/{user_id}/preferences", {
        "avoid_highways": True,
        "typical_use": "commute"
    })
    
    # 3. Start a journey — should get a contextual question
    trip = await api.post("/routing/route", {
        "origin_lat": 30.2672, "origin_lon": -97.7431,
        "dest_lat": 30.3075, "dest_lon": -97.8795,
        "user_id": user_id
    })
    trip_id = trip["trip_id"]
    
    assert trip["routes"], "Should return at least one route"
    assert trip["recommended_index"] == 0, "Should always recommend index 0"
    
    # 4. Get pre-journey message
    msg = await api.get(f"/trips/{trip_id}/pre-journey-message")
    assert len(msg["message"]) > 0
    assert len(msg["message"].split()) <= 30, "Message should be brief"
    
    # 5. User replies
    reply = await api.post(f"/trips/{trip_id}/message", {
        "message": "Yeah I'm not in a hurry, take the scenic route"
    })
    assert reply["ready_to_navigate"] == True
    
    # 6. Simulate GPS trace (slightly off route — 1 deviation)
    gps_trace = [
        (30.2672, -97.7431),
        (30.2700, -97.7500),
        (30.2750, -97.7600),   # Slightly off route here
        (30.2800, -97.7700),
        (30.3075, -97.8795)    # Destination
    ]
    await api.post(f"/trips/{trip_id}/complete", {"gps_trace": gps_trace})
    
    # 7. Wait for background signal processing (Celery task)
    await asyncio.sleep(2)
    
    # 8. Check that implicit signals were computed
    trip_data = await api.get(f"/trips/{trip_id}")
    assert trip_data["implicit_signals"]["adherence_rate"] is not None
    
    # 9. Post-trip feedback
    feedback = await api.post(f"/feedback/{trip_id}", {
        "message": "Good route but the road through downtown was stressful"
    })
    
    # 10. Wait for LLM preference extraction (Celery task)
    await asyncio.sleep(5)
    
    # 11. Verify preferences were updated
    prefs = await api.get(f"/users/{user_id}/preferences")
    # After "downtown was stressful" feedback, stress_aversion should increase
    assert prefs.get("preference_vector") is not None, "RL embedding should be initialized"
```

---

## Deployment & Infrastructure

### Staging environment (set up after Phase 1)

```bash
# Launch everything locally first
cd adaptive-map
docker compose up -d

# Verify all services are healthy
docker compose ps
curl http://localhost:8000/health     # FastAPI
curl http://localhost:8002/status     # Valhalla
curl http://localhost:6333/readyz     # Qdrant
```

### Production deployment (start simple, scale later)

For a two-person team, this is the right sequence:

1. **AWS EC2** — start with a single `c5.2xlarge` instance (8 vCPUs, 16GB RAM, $0.34/hr). Run your entire Docker Compose stack on it. This is simpler than Kubernetes and right-sized for early users.

2. **AWS RDS (PostgreSQL + PostGIS)** — managed database so you don't worry about backups, failover, or disk. Use `db.t3.medium` to start.

3. **AWS S3** — store OSM data files, ML model checkpoints, Valhalla tile archives.

4. **CloudFront** — CDN in front of your static React build and vector tile server. Huge latency improvement for map tiles at low cost.

5. **GitHub Actions CI/CD** — Jonathan configures this after Phase 1.

```yaml
# .github/workflows/deploy.yml
name: Deploy to Production

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run tests
        run: |
          cd backend
          pip install poetry
          poetry install
          poetry run pytest tests/ -v

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to EC2
        uses: appleboy/ssh-action@master
        with:
          host: ${{ secrets.EC2_HOST }}
          username: ubuntu
          key: ${{ secrets.EC2_SSH_KEY }}
          script: |
            cd /app/adaptive-map
            git pull origin main
            docker compose pull
            docker compose up -d --build backend celery_worker frontend
```

---

## Milestone Checklist

Use this as your weekly check-in. Do not move to the next phase until the current one is fully checked off.

### Phase 1 — Base Route Planner
- [ ] Docker Compose starts all services without errors
- [ ] OSM data downloaded and Valhalla tiles built for your target region
- [ ] PostGIS schema migrated with all tables created
- [ ] `MapDataSource` interface (`backend/mapdata/base.py`) and `Place`/`Address`/`BBox`/`RoutingGraphRef` models exist
- [ ] `OSMMapDataSource` implements the interface and passes `backend/tests/mapdata/test_contract.py`
- [ ] `get_map_data_source()` factory reads `settings.map_data_source` and is the only construction point used by API code
- [ ] No `httpx`/`requests` calls to Overpass/Nominatim exist outside `backend/mapdata/`
- [ ] GET `/api/v1/routing/route` returns a valid Valhalla route
- [ ] Route alternatives (3 options) return correctly
- [ ] Trips are saved to the database on every route request
- [ ] MapLibre GL renders a route on the map in the browser
- [ ] User can type a place name and get coordinates via `get_map_data_source().search_addresses()` (geocoding works)
- [ ] User preferences (avoid highways, avoid tolls) change the returned route
- [ ] Basic turn-by-turn instruction list displays in sidebar

### Phase 2 — LLM Conversation Layer
- [ ] User profile table populated on registration
- [ ] Claude API returns a contextual pre-journey message based on user profile
- [ ] Message is under 30 words and asks at most one question
- [ ] User reply is stored in `trip_conversations` table
- [ ] Intent (hurry / explore) extracted from user reply updates route weights
- [ ] Voice input (faster-whisper) transcribes speech correctly
- [ ] Coqui TTS synthesizes response audio and plays in browser
- [ ] Post-trip debrief message is sent after trip completion
- [ ] Claude extracts structured preference signals from post-trip conversation
- [ ] Celery task processes trip completion and updates `trips.implicit_signals`
- [ ] `trips.reward_value` is set for every completed trip

### Phase 3 — RL Personalization
- [ ] GNN encodes a road graph subgraph into a 128-dim vector without errors
- [ ] User preference embedding is initialized (zeros) for new users
- [ ] Preference embedding is stored and retrieved from Qdrant
- [ ] Base RL model trains for 100k steps on synthetic routing tasks without crashing
- [ ] Reward function combines implicit + explicit signals into a single float
- [ ] LLM-extracted preference signals update the `user_preferences` table
- [ ] RL router scores multiple route candidates and returns ranked list
- [ ] Personalized route is measurably different from default route for a user with strong preferences
- [ ] Federated learning server starts and accepts at least 3 clients
- [ ] User preference embedding updates after each trip (verify via Qdrant query)
- [ ] MLflow experiment dashboard shows training runs with logged metrics
- [ ] Cold start (new user) gets sensible routes via similar-user bootstrapping

### Integration
- [ ] Full end-to-end test passes: signup → route → drive → feedback → preference update
- [ ] Second trip for same user reflects preference learned in first trip
- [ ] Voice pipeline latency is under 1 second end-to-end (transcribe + LLM + TTS)
- [ ] App works on mobile browser (responsive design)
- [ ] All API endpoints have basic error handling and return meaningful errors
- [ ] Staging environment deployed and accessible via public URL

---

*This document covers the complete technical execution path. Revisit and update it weekly — some steps will move faster than estimated (especially early backend work), some will take longer (RL convergence and federated learning setup). The most important rule: ship Phase 1 before writing a single line of ML code. A working router with a real map is the foundation everything else builds on.*
