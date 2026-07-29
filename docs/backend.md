# Backend Reference

FastAPI + SQLAlchemy (async) + Alembic, in `backend/`. Run it with:

```bash
cd backend && poetry run uvicorn api.main:app --reload --port 8000
```

For the request/response contracts see [api.md](api.md); for how a request moves through these
modules see [data-flow.md](data-flow.md). This page is the map of what lives where.

## Layout

```
backend/
  api/
    main.py            app, CORS, router mounting, lifespan
    routes/            one module per router
  config.py            Settings — the only place env config is read
  db/
    base.py            declarative Base
    models.py          ORM models
    session.py         async engine + session factory
    migrations/        Alembic (script_location = db/migrations)
  mapdata/             MapDataSource abstraction: places + addresses
  routing/             Valhalla client, candidate sweep, ranking
  services/            signal_processor.py
  ml/
    llm/               LLMClient abstraction + conversation prompts
    gnn/               road graph ingestion + GATv2 encoder
    rl/                environment, reward fusion, embeddings, scorer
  scripts/             data pipelines and training entrypoints
  tests/               pytest, mirroring the layout above
```

## `api/`

`main.py` builds the app, allows CORS from `http://localhost:3000`, and uses a `lifespan` context
to create two long-lived objects once rather than per request: a pooled `ValhallaRouter`
(`app.state.valhalla_router`, closed on shutdown) and `RouteRanker.from_path()`
(`app.state.route_ranker`, which reads a trained scorer off disk — absent or unreadable means a
deterministic fallback to Valhalla's own ordering, the normal state until enough trips exist).

| Router | Prefix | Owns |
|---|---|---|
| `routing.py` | `/api/v1/routing` | `POST /route` — preference→costing translation, candidate generation, ranking, and persisting a `trips` row. `GET /search` — geocoding/place search. |
| `users.py` | `/api/v1/users` | Register (email only), fetch profile, `PATCH` preferences, `PATCH` journey profile. |
| `trips.py` | `/api/v1/trips` | `POST /{id}/gps-update` (batched breadcrumb append), `POST /{id}/complete` (computes the implicit reward). |
| `conversation.py` | `/api/v1/trips` | Pre-trip `conversation/open` + `reply`, post-trip `debrief/open` + `reply`, and the `_find_stop` helper. Also defines the `_llm()` dependency that turns `LLMUnavailable` into a `503`. |
| `voice.py` | `/api/v1/trips` | `WS /{id}/voice` — the in-drive voice loop. Reuses `conversation.py`'s helpers so a spoken command and a typed one behave identically. |
| `speech.py` | `/api/v1/speech` | `POST /transcribe` — server-side STT fallback when the browser's Web Speech API returns nothing. |
| `feedback.py` | `/api/v1/feedback` | `POST /{trip_id}` — raw post-trip text. |

There is no auth. Every endpoint takes a `user_id` where it needs one. Real JWT auth is deferred
until there is something worth protecting.

## `config.py`

A single `Settings` (pydantic-settings) class reading the repo-root `.env`. Every env-derived
value in the system comes from here — nothing else calls `os.environ`. See
[setup.md](setup.md#configuration) for the full variable list and the two behaviours worth
knowing (compose-hostname rewriting, and empty-API-key degradation).

## `db/`

`session.py` builds the async engine lazily and applies the same host-vs-container rewrite to
`DATABASE_URL` that `config.py` applies to service URLs.

| Model | Table | Notes |
|---|---|---|
| `User` | `users` | Email-only accounts. |
| `UserPreference` | `user_preferences` | `avoid_highways`, `avoid_tolls`, `avoid_left_turns`, `prefer_scenic`, plus `preference_vector` (declared, nothing writes it yet). |
| `UserJourneyProfile` | `user_journey_profiles` | Home/work locations, conversation style, use cases, dislikes. `driving_persona` and `known_regular_routes` exist but are unwritten. |
| `Trip` | `trips` | Origin/destination geometry, `suggested_route` (every candidate), `actual_path_taken` (the GPS trace), `implicit_signals`, `reward_value`, and a `context` JSONB carrying labels, mode, `route_strategies`, `recommended_index`, and scores. The raw material for future training. |
| `TripConversation` | `trip_conversations` | The message log plus `preference_updates_extracted`, appended per turn (each entry carries the `route_options` that were on offer, so a chosen index stays resolvable later). |
| `RoadSegment` | `road_segments` | Junction-to-junction segments for the GNN graph. Populated by `scripts/ingest_road_segments.py`. |

Migrations live in `db/migrations/versions/`. Run Alembic from `backend/`.

## `mapdata/` — the first abstraction seam

Everything about places and addresses sits behind an ABC so a provider swap is one file plus one
config flip. `models.py` defines the only vocabulary the rest of the codebase speaks (`Place`,
`Address`, `BBox`, `PlaceCategory`, `RoutingGraphRef`); no OSM tag or Overture schema field is
meant to leak past the implementation that produced it.

- `base.py` — the ABC: `get_places`, `get_place_by_id`, `search_addresses`, `get_routing_graph_ref`.
- `osm_source.py` — Overpass for places, Nominatim for geocoding. Both require a `User-Agent` or
  return `406`.
- `overture_source.py` — a local GeoParquet extract queried in-process with `duckdb`. No live API.
- `hybrid_source.py` — composes the two *per method*: OSM for routing refs and addresses,
  Overture for place lookups. `search_addresses` runs both concurrently and de-dupes within ~50 m.
- `factory.py` — `get_map_data_source()` reads `settings.map_data_source`. **The only place in
  the codebase allowed to decide which provider is active.**

The rule this exists to enforce: no code outside `mapdata/` may call Overpass, Nominatim, or
Overture directly.

## `routing/`

Three modules, in the order a request touches them.

**`valhalla_client.py`** — `ValhallaRouter`, an HTTP client over the Valhalla service, plus the
`UserRoutingPrefs` → `costing_options` translation. Requests carry
`directions_options: {units: miles, language: en-US, narrative: true}`, which is what makes
maneuvers come back with `street_names` (the frontend reads those to name routes "via S Cooper
St"). Preference translation is auto-only; bike and pedestrian use Valhalla's defaults.

**`candidate_generator.py`** — one Valhalla call is not enough. On a measured north–south
Arlington pair it returned three routes where two were the same road with a trivial variation, so
the ranker was choosing between duplicates. This module sweeps several deliberately different
costing strategies concurrently (`No highways`, `Fewest turns`, `Shortest way`, `Calmer roads`,
`No tolls`, plus bike/pedestrian variants), pools every route each call returns, and de-dupes on
geometry overlap.

Two details that shape what the user sees:

- Under `_MIN_SWEEP_MILES` (2.0 straight-line miles) only the baseline runs — probing showed no
  costing knob changes a short route, so the extra calls would just rediscover the same road.
- Each `Candidate` carries `is_primary`: `True` for the route its strategy actually optimised
  for, `False` for the alternates Valhalla returned alongside it. Those alternates must not
  inherit the strategy's label, so they are all labelled `"Another way"` — and the frontend uses
  `is_primary` (surfaced as `route_primary`) to decide whether to show the strategy name or name
  the route by the road it mostly follows.

**`route_ranker.py`** — scores the candidate pool for a specific user via `ml/rl/route_scorer.py`
and returns a `recommended_index`. Behaviour-preserving until a model is trained: no model means
Valhalla's own order.

## `services/`

**`signal_processor.py`** — turns a GPS trace into implicit signals. `compute_route_adherence`
answers "what fraction of these points lie within 50 m of that line", used both for the reward
and (via `candidate_generator`) for de-duplicating routes. Includes a hand-rolled precision-6
polyline decoder and a corrected local-metres projection — a flat `degrees * 111_000` is wrong
for longitude and was the original bug here.

## `ml/llm/` — the second abstraction seam

Same shape as `mapdata/`.

- `base.py` — the ABC: `complete()` and an optional `transcribe()`. `LLMUnavailable` is the only
  exception type allowed to cross this boundary; provider-specific failures are caught and
  re-raised as it.
- `gemini_client.py` — the only implementation. Plain `httpx` against the REST `generateContent`
  endpoint, no SDK, translating the neutral `user`/`assistant` roles to Gemini's `user`/`model`.
- `conversation.py` — the prompts and extraction logic, provider-agnostic. `interpret_reply()`
  pulls seven signals from one call: intent, durable preference updates (confidence-gated),
  route switch, add/remove stop, destination override, and travel mode.
- `factory.py` — `get_llm_client()` reads `settings.llm_provider`. An empty API key raises
  `LLMUnavailable` immediately rather than failing later.

## `ml/gnn/`

Road-network encoding, built and tested in isolation — **no API route calls it**.

- `ingest.py` — OSM `.pbf` → `road_segments`, splitting ways at shared coordinates so segments
  run junction-to-junction.
- `graph_builder.py` — `road_segments` → a PyTorch Geometric `Data` graph. Async, reads endpoint
  coordinates via `ST_X`/`ST_Y` in SQL.
- `model.py` — `RoadNetworkEncoder`, a GATv2 encoder producing a 128-dim vector. Verified on the
  real Arlington graph (7,294 nodes / 18,821 edges). Note it is **randomly initialised and never
  trained**, so today it contributes a constant.

Needs `poetry install --with gnn`.

## `ml/rl/`

- `reward_engine.py` — `compute_final_reward(implicit, explicit)` fuses the behavioural signal
  with the debrief sentiment by confidence weight. **This one is live**, wired into
  `complete_trip` and `reply_debrief`, and degrades to explicit-only or neutral without a trace.
- `route_scorer.py` + `state.py` — the supervised scorer behind `RouteRanker`, and the 20-dim
  ranking feature builder. Trained by `scripts/train_route_scorer.py` from logged
  `trips.reward_value`; needs ≥30 completed trips before it emits a model.
- `environment.py` + `train.py` — a Gymnasium env and PPO loop for a sequential navigation
  policy. Scaffolding: it demonstrably learns to navigate, but nothing serves it.
- `preference_embedding.py` — a 32-dim per-user embedding and its Qdrant store. Tested
  in-memory; **no production call site**.

`state.py` (ranking features) and `environment.py` (navigation observations) describe different
problems and are deliberately kept apart — their docstrings say they must never be fed to each
other's model.

Needs `poetry install --with rl`.

## `scripts/`

| Script | Purpose |
|---|---|
| `ingest_road_segments.py` | Populate `road_segments` from the local OSM extract. Also reachable as `./scripts/rebuild_region.sh --with-road-segments`. |
| `train_route_scorer.py` | Train the supervised scorer from logged trips. |
| `train_rl.py` | Train the base navigation policy. |

## `tests/`

`poetry run pytest` from `backend/`. The suite mirrors the package layout. Integration tests
self-skip when Valhalla or Postgres aren't reachable, and network-dependent Overpass tests skip
on 5xx/timeout rather than failing, so a bare checkout stays green. `tests/fakes.py` provides a
fake LLM so conversation paths are testable without an API key.

## Related pages

- [API Specification](api.md)
- [Data Flow](data-flow.md)
- [Decision Records](decisions.md)
- [Contributing](contributing.md)
