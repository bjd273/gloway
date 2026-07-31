# Environment Setup

The [README quickstart](../README.md#quickstart) is the happy path. This page is the version
that explains *why* each step is shaped the way it is, what every Docker service is actually for,
and what to do when something breaks.

## Prerequisites

| Tool | Needed for | Install |
|---|---|---|
| Docker + Compose v2 | Postgres/PostGIS, Valhalla, Martin | [docker.com](https://docs.docker.com/get-docker/) |
| Python 3.11+ | backend (`requires-python = ">=3.11,<4.0"`) | |
| Poetry | backend dependencies | `pipx install poetry` |
| Node 20+ | frontend | |
| `osmium-tool` | cropping the OSM extract to the region bbox, and building the POI search index | `brew install osmium-tool` |

Planetiler builds the basemap inside a container (`ghcr.io/onthegomap/planetiler`), so no local
Java is required. The Overture download needs only network access to their public S3 bucket — it
goes through duckdb, which the backend already depends on. If it fails, `rebuild_region.sh` says
so and continues; place search still works, falling back to the OSM POI index and Nominatim.

## Configuration

```bash
cp .env.example .env
```

`.env` lives at the **repo root**, not in `backend/`. `backend/config.py` resolves it absolutely
(`Path(__file__).resolve().parents[1] / ".env"`) so the same file loads whether you start uvicorn
from the repo root, from `backend/`, or under pytest.

Two behaviours in there are worth knowing before they confuse you:

**Compose hostnames are rewritten on the host.** `.env` says `VALHALLA_URL=http://valhalla:8002`,
which only resolves inside the Compose network. `Settings._rewrite_compose_hostnames` checks for
`/.dockerenv` and, when absent, rewrites `valhalla` → `localhost` (and the same for `qdrant` and
`mlflow`). `db/session.py` applies the same trick to `DATABASE_URL`. One file, both contexts.

**An empty `GEMINI_API_KEY` is a supported configuration.** `get_llm_client()` raises
`LLMUnavailable`, the `_llm()` dependency turns that into a `503`, and the frontend treats `503`
as "this feature is off" and hides the UI. Routing, search, preferences, and the whole drive loop
are unaffected.

## Bringing up infrastructure

```bash
docker compose -f infra/docker-compose.yml --project-directory . up -d postgres valhalla martin
```

### Why both flags

`-f infra/docker-compose.yml` points at the file. `--project-directory .` sets the directory that
relative paths resolve against. Without it, Compose would resolve `./valhalla/custom_files` and
`./data/tiles` relative to `infra/`, where neither exists, and would look for `.env` there too.
Every script in this repo uses the same incantation:

```bash
COMPOSE="docker compose -f infra/docker-compose.yml --project-directory ."
```

### Why name the services explicitly

A bare `docker compose up` tries to start everything, and **two services cannot build**:

- `backend` declares `build: ./backend`, but there is no `backend/Dockerfile`.
- `celery_worker` declares the same build plus `command: celery -A services.celery_app worker`,
  and `backend/services/celery_app.py` does not exist either.

Both are placeholders for a containerised deployment that hasn't been built. During development
the backend runs on the host with uvicorn. Start only what you need.

### What each service is for

| Service | Port | Status | Notes |
|---|---|---|---|
| `postgres` | 5432 | **required** | PostGIS 16-3.4. System of record. Volume `postgres_data`. |
| `valhalla` | 8002 | **required** | Routing engine. Mounts `valhalla/custom_files` for tile build inputs and the `valhalla_tiles` volume for the built graph. |
| `martin` | 3001 → 3000 | **required for the basemap** | Serves `data/tiles/region.pmtiles`. Without it the map renders blank but routing still works. |
| `redis` | 6379 | unused | Declared for a Celery queue that was never built. |
| `qdrant` | 6333 | optional | `ml/rl/preference_embedding.py` can use it; nothing in the request path does. Its tests run fully in-memory. |
| `mlflow` | 5000 | optional | RL training tracking. `MLFLOW_URL` empty = local sqlite, which is enough for smoke runs. |
| `backend` | 8000 | **broken** | No Dockerfile. Run on the host instead. |
| `celery_worker` | — | **broken** | No Dockerfile, no celery app. |
| `frontend` | 3000 | buildable | `frontend/Dockerfile` exists, but `npm run dev` is what you want while developing. |

## Building the region

```bash
./scripts/rebuild_region.sh                       # tiles, basemap, places
./scripts/rebuild_region.sh --with-road-segments  # ...plus the GNN road graph
```

Everything downstream of the bounding box in `data/region.json`, in one command. It is safe to
re-run, and everything except the Overture download works offline once the caches exist.

| Step | What happens | First run |
|---|---|---|
| 1. OSM extract | `data/download_osm.sh` downloads the Texas extract if absent, then `osmium extract` crops it to the bbox | ~700 MB download, then seconds |
| 2. Valhalla tiles | Copies the crop into `valhalla/custom_files/`, clears the cached tar, restarts Valhalla with `VALHALLA_USE_CACHED_TILES=False` to force a rebuild, waits for `"Starting valhalla service"` in the logs, then restarts with caching back on | the slow one — minutes |
| 3. Basemap | Planetiler (Docker) → `data/tiles/region.pmtiles`, then restarts Martin | ~1.3 GB of sources cached on first run |
| 4. Overture places | `data/download_overture.sh` (duckdb + httpfs against Overture's S3). **Non-fatal** — a failure here warns and continues, deliberately, so later steps still run. Verifies the extract covers `region.json` before declaring success | minutes |
| 5. OSM POI index | `data/build_osm_places.sh` — osmium over the same `region.osm.pbf` the basemap labels come from, so anything labelled is searchable | seconds |
| 6. Frontend sync | Copies `data/region.json` → `frontend/src/lib/region.json` | instant |

Steps 4 and 5 are allowed to fail on purpose. Places only enrich destination search; routing and
the basemap don't need them. Failing hard would skip step 6 and leave the frontend's coverage gate
disagreeing with the tiles just built — a much worse outcome than thinner POI search.

Step 4 does fail the build if the extract it downloaded doesn't cover `region.json`. That is the
one case worth stopping for: an extract quietly narrower than the region is invisible at runtime —
every query succeeds and simply finds nothing outside the old box — and it has happened. See
[Decisions](decisions.md#the-places-extract-is-checked-against-the-region-it-claims-to-cover).

Restart the frontend dev server afterwards so Vite picks up the new `region.json`.

### The cached-tiles toggle

`VALHALLA_USE_CACHED_TILES` (default `True`) maps to the container's `use_tiles_ignore_pbf`.
`True` boots from `valhalla_tiles.tar` and ignores any `.pbf`, making restarts near-instant.
`False` forces a rebuild from the `.pbf` on next start. `rebuild_region.sh` flips it for one run
and flips it back; you rarely need to touch it by hand.

### Changing the region

`data/region.json` is the single source of truth for the routable bounding box. Four artifacts
derive from it — Valhalla tiles, the Martin basemap, the Overture extract, and the frontend's
coverage gate (`frontend/src/lib/region.ts` → `inRegion()`, `MAP_MAX_BOUNDS`, `REGION_CENTER`).

```bash
$EDITOR data/region.json      # edit the bbox
./scripts/rebuild_region.sh   # move all four together
```

Do not edit `frontend/src/lib/region.json` directly — step 5 overwrites it. Keeping these in sync
by hand is four chances to miss one, and the failure is silent: the app offers destinations the
router has no tiles for, or quietly falls back to the map centre as a trip origin.

## Database

```bash
cd backend
poetry install                    # skips the optional gnn/rl/ml groups
poetry run alembic upgrade head
```

Creates `users`, `user_preferences`, `user_journey_profiles`, `trips`, `trip_conversations`,
`road_segments`. `alembic.ini` sets `script_location = %(here)s/db/migrations`, so run Alembic
from `backend/`.

The heavy ML dependencies are optional Poetry groups so a normal backend install stays fast:

```bash
poetry install --with gnn   # torch + torch-geometric (road graph encoder)
poetry install --with rl    # gymnasium, stable-baselines3, mlflow, qdrant-client
poetry install --with ml    # the remaining ML odds and ends
```

## Running the app

```bash
cd backend  && poetry run uvicorn api.main:app --reload --port 8000
cd frontend && npm install && npm run dev
```

`frontend/vite.config.ts` proxies:

- `/api/v1/*` → `http://localhost:8000`, with `ws: true` so the in-drive voice WebSocket upgrade
  passes through
- `/api/tiles/*` → `http://localhost:3001` (Martin), with the prefix stripped

It also allowlists `.trycloudflare.com`, `.ngrok-free.app` and `.ngrok.io` as hosts, because Vite
otherwise rejects tunnelled `Host` headers with "Blocked request. This host is not allowed."

### Simulated drives

Append `?sim=1` to the URL to walk a synthetic position along the selected route instead of using
real GPS. Outside Arlington this is the only way to exercise the drive loop — a real
`watchPosition` fix would sit off-map forever. Everything downstream of the position source
(batching, `gps-update` flushes, the puck, the camera, arrival) is identical in both modes, which
is what makes sim an honest stand-in.

### Real GPS drives

`watchPosition` and `getUserMedia` are secure-context-only, so a phone cannot use
`http://<laptop-ip>:3000` at all. `./scripts/drive.sh` runs a pre-flight and then opens an HTTPS
tunnel over the dev server; because everything is proxied through port 3000, tunnelling that one
port covers API, tiles and the voice socket. `./scripts/drive.sh --check` runs the pre-flight
only and publishes nothing.

Note the tunnel exposes an unauthenticated API. It is a supervised test-drive tool, not a
standing environment.

## Troubleshooting

**`docker ps` shows containers "Up" but connections are refused.** Ports aren't actually bound —
Docker Desktop's proxy can get into this state. Confirm with `lsof -nP -iTCP -sTCP:LISTEN | grep 8002`;
if nothing is listening, restart the services:

```bash
docker compose -f infra/docker-compose.yml --project-directory . restart valhalla martin
```

**Routing returns "Can't reach the road network right now."** That is the frontend's copy for a
`503`, which means the backend could not reach Valhalla. Check `curl -s -o /dev/null -w '%{http_code}' http://localhost:8002/status`
— a `404` at `/` is healthy (Valhalla has no root handler), a connection refusal is not.

**Blank basemap, but routing works.** Martin isn't serving tiles. A `204 No Content` from
`http://localhost:3001/region/<z>/<x>/<y>` means that tile has no data — expected outside the
built bbox, a symptom of a stale `region.pmtiles` inside it. Rebuild with
`./scripts/rebuild_region.sh`. The route line is app-drawn GeoJSON, so it renders over a blank
basemap either way.

**Route requests 400 with an out-of-area message.** The origin or destination is outside the
tiled region. Either pick a point inside it or widen `data/region.json` and rebuild.

**No conversation, voice, or debrief UI.** `GEMINI_API_KEY` is empty. This is deliberate
degradation, not a failure.

**Place search returns addresses but few named places.** The Overture parquet is missing or was
built for a previous bbox. Re-run `./scripts/rebuild_region.sh` (with `uv` installed).

**`docker compose up` fails building `backend`.** Expected — see
[what each service is for](#what-each-service-is-for). Name the three services you need.

## Related pages

- [Architecture](architecture.md) — how the pieces fit together
- [Contributing](contributing.md) — tests, migrations, conventions
- [`adaptive_map_build_roadmap.md`](../adaptive_map_build_roadmap.md) — the full build log
