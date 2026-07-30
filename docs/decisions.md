# Decision Records

Lightweight ADRs for choices in this codebase whose reasoning isn't obvious from reading the code alone — provider/library picks, and a handful of bugs whose fixes look like unnecessary complexity until you know what they replaced. Sourced from the codebase's own docstrings/comments, commit messages, and [`adaptive_map_build_roadmap.md`](../adaptive_map_build_roadmap.md). Each entry notes what would have to change to be worth revisiting.

---

## The `MapDataSource` and `LLMClient` abstraction layers

**Status:** Adopted, load-bearing (see [Architecture](architecture.md#the-abstraction-layer-pattern-used-twice-deliberately)).

**Context:** Differentiation in this product — personalization, use-case-specific routing, richer place data, a conversational layer — lives in code *above* whatever routing engine or LLM provider is chosen underneath. If enrichment/conversation logic called Overpass, Nominatim, or a specific LLM SDK inline, a provider swap or blend later would mean auditing every call site.

**Decision:** Two ABC + factory seams: `mapdata.base.MapDataSource` (places/addresses) and `ml.llm.base.LLMClient` (chat + transcription). One hard rule enforced by convention (not yet by lint/CI): no code outside `backend/mapdata/` imports `httpx`/`requests` to hit a places/geocoding provider directly, and no code outside `backend/ml/llm/` talks to an LLM SDK/API directly. Every `MapDataSource` implementation must pass the shared `backend/tests/mapdata/test_contract.py` before being wired into the factory.

**Consequences:** Adding Overture (an `OvertureMapDataSource`) and blending it with OSM (`HybridMapDataSource`) shipped as new files plus a `settings.map_data_source` flip — no changes to `api/routes/routing.py` or `conversation.py`. The same is true for the LLM seam: adding a `claude_client.py` is scoped to be "a same-day swap, not a rewrite" per the `factory.py` docstring.

**Revisit if:** the interfaces themselves turn out to be the wrong shape for a use case (e.g. a provider that needs streaming responses `LLMClient.complete()` can't express) — that's a reason to extend the ABC, not to abandon the pattern.

---

## Overture via local parquet + duckdb, not a live API

**Status:** Adopted.

**Context:** OSM's place/POI data quality was a measured bottleneck — central-Arlington POIs were missing from destination search under the OSM-only Overpass implementation (a handful of results vs. Overture's 3,700+ for the same bbox). The roadmap's original plan deferred Overture until this was proven, not assumed — see the roadmap's Map Data Abstraction Layer section: *"Do not adopt until OSM place-data quality is an actual measured bottleneck."*

**Decision:** Rather than calling a live Overture API, `OvertureMapDataSource` queries a locally-downloaded GeoParquet extract (`data/download_overture.sh`) via embedded `duckdb` — no network call per request, no API key, no rate limit. `map_data_source` default flipped from `"osm"` to `"hybrid"` once this was built (see `config.py`).

**Consequences:** The extract is a point-in-time snapshot that needs periodic regeneration via the download script; there's no live sync. Category matching needed both an exact-match dict and suffix rules (`%_restaurant`) because Overture's taxonomy leaves are far more granular than OSM's free-form tags.

**Revisit if:** the region grows beyond what a local extract can reasonably cover, or Overture ships a hosted query API cheap enough to prefer over extract-refresh maintenance.

---

## Gemini instead of Claude for the LLM conversation layer

**Status:** Adopted, explicitly provisional.

**Context:** The roadmap's original tech-stack plan specified Claude for the conversation/prompt layer. At implementation time, only a Gemini API key was available.

**Decision:** Build the `LLMClient` seam (above) so the provider choice is a config value, implement `GeminiLLMClient` first, ship with `llm_provider="gemini"`. Also noted: `gemini-2.5-flash-lite` 404s for API keys created after its sunset date; `gemini-3.1-flash-lite` is the working current-generation equivalent, verified against that key's `ListModels`.

**Consequences:** Every prompt in `ml/llm/conversation.py` is written against the neutral `LLMClient.complete()` contract, not Gemini specifics — so this is a config flip plus one new file (`claude_client.py`) away from the originally-planned provider, not a rewrite.

**Revisit if:** an Anthropic API key becomes available and Claude's behavior (instruction-following, JSON-mode reliability, cost) is worth the swap — check `gemini_model` naming against `ListModels` again if it ever needs re-verifying, since this exact class of breakage (model sunset) already happened once.

---

## Self-hosted basemap tiles (Planetiler → PMTiles → Martin)

**Status:** Adopted.

**Context:** The vector *basemap* MapLibre renders (roads/buildings/labels/water) is a separate concern from the Valhalla *routing* graph, and wasn't in the original plan at all. Hosted options were evaluated against startup-commercial licensing, not just cost:

| Option | Commercial-free for a startup? |
|---|---|
| CARTO hosted tiles | Free tier exists but third-party, no SLA/ToS guarantee |
| MapTiler Cloud | **No** — free tier is explicitly non-commercial only |
| Protomaps hosted API | **No** past 1M req/mo without paid sponsorship |
| Self-hosted Planetiler → PMTiles → Martin | **Yes, unambiguously** — generated from data already downloaded, served by infrastructure already run |

**Decision:** Generate OpenMapTiles-schema PMTiles from the same OSM extract used for Valhalla, via Planetiler (BSD-3), served by Martin. Attribution (`© OpenMapTiles © OpenStreetMap contributors`) is required and auto-embedded by Martin's `/catalog` endpoint. Style vendored from OpenFreeMap's `liberty` style rather than hand-written, repointed at the local Martin instance.

**Consequences:** One more Docker service (`martin`) and one more build step (Planetiler) in the dev setup, in exchange for no third-party rate limits or ToS risk. A known frontend gotcha this decision surfaced: MapLibre's tile fetches run inside a Blob-URL Web Worker that can't resolve *relative* tile URL templates — the style's `tiles` array must be resolved against `window.location.origin` at map-construction time, not baked into the committed style JSON.

**Revisit if:** cost/scale pressure makes a fully serverless `pmtiles` (byte-range fetch from S3/R2, no server process) worth the loss of Martin's ability to *also* serve live PostGIS layers later (e.g. crowdsourced `road_segments` updates) — Martin was chosen partly to keep that door open.

---

## Valhalla over OSRM for routing

**Status:** Adopted.

**Context:** The long-term plan is RL-personalized routing — user/context-specific cost weights need to flow into the routing engine's decision, not just its post-processing.

**Decision:** Valhalla, because it supports custom cost functions (`costing_options`) that a preference vector can be translated into per-request, without needing to fork or modify the routing engine's core. OSRM's cost model is comparatively rigid. The explicit rule that follows: *"Never modify Valhalla's C++ core — differentiation happens above it,"* i.e. in `routing/valhalla_client.py`'s translation layer, not inside the engine.

**Consequences:** `routing/valhalla_client.py::_build_costing_options` is the single, stable seam the eventual RL policy will write into (replacing today's rule-based `UserRoutingPrefs` construction) — the routing plumbing itself doesn't change when that happens.

**Revisit if:** Valhalla's costing model turns out insufficiently expressive for a preference the RL policy needs to express — the fallback described in the roadmap is a custom C++ costing model, not a different open-source router.

---

## Valhalla costing quirks — clamped values, no boolean-urgency, coarse left-turn proxy

**Status:** Adopted (documented workarounds, not open bugs).

**Context:** Probing a live Valhalla instance surfaced three behaviors the docs alone didn't make obvious:
1. `shortest` is a **boolean** (distance-optimized, not graduated), and produces routes that are shorter in distance but *slower* in time — the opposite of what "urgency" should do. It is therefore never derived from `UserRoutingPrefs` and is always sent as `False`.
2. Out-of-range or wrong-typed costing values are **silently ignored** — the route still succeeds, just without the intended effect. There's no error to catch.
3. `auto` costing has no left-turn-specific penalty; `maneuver_penalty` penalizes *all* turns.

**Decision:** `_build_costing_options()` clamps every derived value to Valhalla's actual accepted range before sending it (point 2), never wires `urgency` to `shortest` (point 1), and treats `avoid_left_turns` as a coarse approximation via `maneuver_penalty` (point 3) rather than pretending it's precise.

**Consequences:** `avoid_left_turns` is documented, in three places (module docstring, roadmap, this ADR) as approximate — don't "fix" it by tuning `costing_options` further; it needs a custom C++ costing model to do properly.

**Revisit if:** left-turn avoidance becomes a priority feature — the fix is scoped work (custom costing), not a parameter tweak.

---

## Atomic JSONB append for GPS breadcrumbs, not read-modify-write

**Status:** Adopted (bug fix).

**Context:** `POST /trips/{id}/gps-update` originally loaded `actual_path_taken` into Python, appended the new batch, and wrote the whole array back. Two in-flight flushes (the frontend's `DriveController` flushes every 3s) could both read the same array state and the second write would clobber the first's points — a classic lost-update race.

**Decision:** `UPDATE trips SET actual_path_taken = coalesce(actual_path_taken, '[]'::jsonb) || cast(:pts as jsonb) WHERE id = :id` — a single statement that re-reads the row under its own lock, so concurrent appends serialize at the database instead of racing in application code.

**Consequences:** Application code never holds or mutates the full array; every append is one round trip.

**Revisit if:** breadcrumb volume grows enough that JSONB array append becomes a write-amplification concern — the fix then is a separate `trip_points` table, not reverting this pattern.

---

## `gen_random_uuid()` and Alembic `include_object` filtering for PostGIS's own tables

**Status:** Adopted.

**Context:** Two issues surfaced setting up Alembic autogenerate against a `postgis/postgis` Docker image: (1) the roadmap's reference schema used `uuid_generate_v4()`/the `uuid-ossp` extension; Postgres 16 has `gen_random_uuid()` built into core, one less extension to manage. (2) The `postgis/postgis` image auto-creates `postgis_tiger_geocoder`/`postgis_topology` tables (`county`, `state`, `edges`, `topology`, ~30 more) directly in `public` on database init — without filtering, the *first* `alembic revision --autogenerate` proposed `DROP TABLE` for all of them.

**Decision:** Use `gen_random_uuid()` for every PK default. In `db/migrations/env.py`, wire a custom `include_object` that skips any reflected table with no corresponding SQLAlchemy model, combined with `geoalchemy2.alembic_helpers.include_object` (which alone only filters `spatial_ref_sys`, not the tiger/topology tables). `CREATE EXTENSION IF NOT EXISTS postgis` is added to the first migration's `upgrade()` by hand — autogenerate never emits `CREATE EXTENSION` statements.

**Consequences:** Every future `alembic revision --autogenerate` diff should be reviewed for stray tiger/topology drops before being trusted, per the roadmap's explicit callout, even though the filter should already exclude them.

---

## Minimal Phase 1 auth: no passwords, no JWT

**Status:** Adopted, explicitly temporary.

**Context:** `POST /users/register` needs to exist to close the loop from preferences → route costing (`_load_prefs` in `routing.py`), but there was nothing yet worth protecting behind real authentication.

**Decision:** Registration claims an email and returns a user id the client remembers (in `localStorage`); it's idempotent on email (a client that lost its stored id gets the same account back). No password, no session token, no JWT.

**Consequences:** Anyone who learns a `user_id` UUID can read/mutate that user's preferences and journey profile via the API — acceptable for a local/dev-only Phase 1 system, not for anything internet-facing.

**Revisit if:** the app is deployed anywhere a `user_id` could leak to someone other than its owner — this is explicitly called out in `api/routes/users.py`'s module docstring as deferred, not forgotten.

---

## Poetry `package-mode = false` and split optional dependency groups

**Status:** Adopted.

**Context:** Two issues with a naive `poetry install` setup: (1) Poetry 2.x's PEP 621 `[project]` table, with no matching installable package directory, tries to build the project as its own package and fails outright. (2) The full ML stack (`torch`, `ray[rllib]`, `flwr`, `mlflow`, `faster-whisper`, `qdrant-client`) is multi-GB and irrelevant until Phase 2/3 — a plain `poetry install` for a Phase 1 routing/DB task would burn 10+ minutes and several GB for nothing.

**Decision:** `[tool.poetry] package-mode = false`. ML dependencies split into **optional** Poetry groups (`ml`, and later a narrower `gnn` group for just `torch`+`torch-geometric` once GNN work started needing less than the full ML stack) — `poetry install` stays fast through Phase 1/2, `poetry install --with gnn` or `--with ml` pulls in the heavy stack only when that work actually starts.

**Consequences:** Anyone running backend tests or the API for the first time should default to plain `poetry install`, not reach for `--with ml` unless they're touching `ml/gnn/` or later RL code.

---

## Docker Compose `--project-directory .`

**Status:** Adopted (documented gotcha).

**Context:** `infra/docker-compose.yml` lives in `infra/`, but Compose resolves relative volume paths and `.env` against the compose file's own directory by default — not the repo root. Running `docker compose -f infra/docker-compose.yml up` without `--project-directory .` silently fails to resolve `.env` and bind-mount paths.

**Decision:** Always run Compose from the repo root with `--project-directory .` explicitly set: `docker compose -f infra/docker-compose.yml --project-directory . up -d <service>`. Documented in the roadmap and repeated in [Setup](setup.md#why-both-flags).

**Consequences:** Every Compose invocation in docs/scripts should carry this flag; a bare `docker compose -f infra/docker-compose.yml up` from any directory is a likely source of "why can't it find my .env" support questions.

---

## Sweep several costing strategies instead of trusting one Valhalla call

**Status:** Adopted (July 2026).

**Context:** Ranking can only choose from what generation produced. Measured on a north–south Arlington pair, one Valhalla call with `alternates=3` returned 13.14 mi, 13.16 mi and 19.44 mi — the first two being the same road with a trivial variation. Asking for six alternates still returned three. The whole personalization stack was therefore choosing between two identical routes and one bad one, and the first real drive went 460 m off-route precisely because the rider's preferred route was never a candidate.

**Decision:** `routing/candidate_generator.py` runs several deliberately different costing strategies concurrently (`use_highways: 0`, `maneuver_penalty: 300`, `shortest`, `top_speed: 45`, `use_tolls: 0`, plus bike/pedestrian variants), pools every route each call returns, and de-dupes on geometry overlap ≥0.8, reusing `compute_route_adherence` rather than writing new geometry code. Every strategy in the list was verified against the live engine to actually change a route; knobs that did nothing on this extract (`use_living_streets`, `use_hills`, `date_time`) were dropped.

**Consequences:** Six concurrent Valhalla calls per request instead of one, which is why trips under 2 straight-line miles skip the sweep — probing found no knob changes a short route. Candidates are ordered strategy-primaries first, then leftovers: ranked purely by arrival order, the baseline's own alternates filled the cap and "no highways" was never even looked at.

---

## `route_primary` over string-matching route labels

**Status:** Adopted (July 2026).

**Context:** Only the route a strategy purpose-built deserves that strategy's name. The alternates Valhalla returns alongside each call are useful variety but are not what the strategy asked for, so they all carry the literal label `"Another way"`. On a short trip, where only the baseline runs, that meant the entire card list read "Fastest" then "Another way" three times — accurate and useless. The `Candidate` dataclass had tracked `is_primary` for exactly this distinction since the sweep was built, but nothing downstream read it.

**Decision:** Surface it as `route_primary: list[bool]` on `RouteResponse`, parallel to the existing `route_labels`/`route_strategies`. The frontend names non-primary routes by the road they spend the most distance on (`"via S Cooper St"`), falling back to a superlative and then to the backend label.

**Consequences:** One more additive response field. The client could instead have matched the literal string `"Another way"`, but labels are display copy the backend explicitly expects to reword — the same reasoning that put `route_strategies` alongside `route_labels` in the first place.

---

## Progress is a fraction of length, not of coordinate count

**Status:** Adopted (July 2026).

**Context:** `DriveController` reported drive progress as `index / (coords.length - 1)` — a fraction of the route's *coordinate count*. MapLibre's `line-progress` addresses a line by fraction of its *length*, and Valhalla packs shape points tightly through curves while spreading them along straights. On a real test route, coordinate 21 of 34 was 62% by index and 45% by distance. Styling the route with the index figure would have put the traveled/remaining boundary visibly away from the puck.

**Decision:** `frontend/src/lib/routeProgress.ts` computes cumulative length fractions in metres, using the same local equirectangular projection `services/signal_processor.py` uses server-side. `DriveController` precomputes them once per route and indexes into them.

**Consequences:** This also silently corrected two existing consumers that already *assumed* distance semantics and were quietly wrong: `TripSheet`'s current-maneuver picker (`navProgress * selected.miles`) and `NavVoice`'s spoken remaining distance. Summing segment lengths lands a few ulps off round numbers, so tests assert with `closeTo` rather than equality — rounding would mean rounding the value `line-progress` consumes.

---

## Heading comes from route geometry, not consecutive GPS fixes

**Status:** Adopted (July 2026).

**Context:** The driving camera rotates so the direction of travel is up, and the position puck carries a heading arrow. Both need a bearing. The obvious source is the delta between consecutive GPS fixes.

**Decision:** Read the bearing off the route's own geometry, looking ~60 m ahead (`bearingAtFraction`).

**Consequences:** A parked car still has a heading. Fix-delta bearing spins randomly at a standstill, and a map that spins at every red light is unusable; averaging over ~60 m of road also smooths the per-shape-point jitter that would wobble the camera through curves. The cost is that a driver who leaves the route keeps being shown the route's heading until they rejoin — acceptable, and the same assumption the greyed-out traveled line already makes.

---

## Sheet snap policy lives in `TripSheet`, not the trip store

**Status:** Adopted (July 2026).

**Context:** Route cards were unreachable: every completed route request called `setSnap('peek')`, collapsing the sheet so the map got the screen, which left the cards rendered into a clipped region. The only way to pick a route was to notice the "N ways" button and tap that first. An initial fix put an auto-raise in `useTripStore.requestRoute()` — and it silently lost, because `TripSheet`'s effect ran afterwards and dropped the sheet straight back to peek.

**Decision:** Keep all snap policy in `TripSheet`, whose existing comment already stated the rule ("how tall a panel is has nothing to do with what the trip is"). `Sheet.tsx` owns mechanism — heights, drag, publishing its measured size — and `TripSheet` owns policy: one route drops to peek, several rises to half, navigating stays at peek.

**Consequences:** Two components writing the same state is a fight the later effect always wins, and the split is what makes that impossible. A related latent bug was fixed alongside: `pointer-events: none` on the collapsed scroll region also killed taps on whatever remained visible.
