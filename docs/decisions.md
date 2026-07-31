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

---

## Turn lanes come from a second OSRM-format call, not the native response

**Status:** Adopted (July 2026).

**Context:** Lane guidance ("use the left 2 lanes") needs `turn:lanes` from OSM. Valhalla's documentation describes a top-level `turn_lanes` request flag that adds a `lanes` array to each maneuver. On the pinned build (3.5.1, `ghcr.io/gis-ops/docker-valhalla`) that flag is accepted and silently ignored — the native JSON response carries no lane data at all. Lanes appear only when the response is requested in Valhalla's OSRM-compatible dialect, as `steps[].intersections[].lanes`.

Switching the routing call wholesale to OSRM format was not available. `trips.suggested_route` stores the raw native trip, and `services/signal_processor.py` and `ml/training/train_route_scorer.py` both read that shape back out to score every completed drive. Changing it would have invalidated stored trips and two consumers well outside this feature.

**Decision:** `routing/lane_guidance.py` issues a second, concurrent OSRM-format call per routing strategy and grafts only the `lanes` array onto the matching native maneuvers. The native response stays the system of record.

**Consequences:** Roughly double the Valhalla requests per route. Both calls are concurrent and Valhalla is local, so the wall-clock cost is small, and the harvest is best-effort — any failure leaves the route intact without lanes. The graft is guarded: it checks leg count, duration and maneuver count agree before matching, because wrong lane data is worse than none. It points a driver at a real lane that happens to be the wrong one, and a driver who follows it ends up somewhere unrecoverable. On a mismatch the lanes are dropped.

Lane coverage is a property of OSM, not of this code. Across the Arlington extract, arterials and highway approaches carry `turn:lanes` and residential streets do not, so most maneuvers have no lanes. The banner is designed around their absence — the strip renders nothing rather than reserving space.

---

## Maneuver boundaries come from `begin_shape_index`, not `end_shape_index`

**Status:** Adopted (July 2026).

**Context:** Valhalla gives each maneuver a span over the route's shape points. `begin_shape_index` is where its instruction is carried out; `end_shape_index` is where that span hands over to the next maneuver. The two meet, so `end[N] === begin[N+1]`:

```
0: "Drive north on South Pecan Street."   begin=0  end=12
1: "Turn left onto West Mitchell Street." begin=12 end=34
```

The first implementation built the countdown targets from `end`. That is the correct *point* — shape index 12 really is where the left turn happens — but it pairs that point with maneuver 0, the road being driven, rather than maneuver 1, the turn being approached. Because the two lists differ by exactly one position, every instruction displayed and was spoken one turn late: the banner read "turn left onto West Mitchell" while the driver was already on West Mitchell, and the announcement arrived just after the turn was completed. The distance was correct throughout, which is what made it hard to see in the numbers.

**Decision:** `stepBoundaries()` maps each maneuver to `cumulative[beginShapeIndex]` — the distance at which it is performed. `ManeuverTracker` reports the first maneuver whose point is still ahead of the driver.

**Consequences:** `stepIndex` now means "the turn being approached", which is what both the banner and the announcer want, and `steps[stepIndex]` needs no offsetting at the call site. Boundary 0 is the departure at distance 0, so the tracker's first update walks straight past it onto the first real turn — correct, since a driver pulling away wants the turn ahead, not a description of the road they are on. The distance-based fallback (for maneuvers with no shape indices) had to become an *exclusive* prefix sum to match: boundary N is where step N starts.

---

## The step tracker only moves forward

**Status:** Adopted (July 2026).

**Context:** `DriveController` originally found each GPS fix's nearest route *coordinate* by scanning the entire line. On a loop-shaped route, or on either side of a U-turn where two opposite stretches of road sit metres apart, one noisy fix can project onto a coordinate the driver passed ten minutes ago. (The projection is windowed now — see the snap-to-route entry below — which makes this much rarer without making it impossible: the window still falls back to a full scan when it loses the driver.)

**Decision:** `ManeuverTracker` holds its step index against any backwards movement. The distance readout is floored at the previous maneuver but not held at a high-water mark.

**Consequences:** A stale projection can no longer re-announce a turn already taken or flip the banner back to an instruction the driver has finished obeying — the two worst failures a turn banner has. Within a step the honest projection still wins, so drifting or backing up reads truthfully. A genuine reroute doesn't rewind the tracker either: `startNavigation` throws it away and builds a new one, which is also what stops a post-reroute drive from replaying announcements for turns already made.

---

## Simulated drives move in metres per second, not in fractions of the route

**Status:** Adopted (July 2026), replacing the fixed-duration sim.

**Context:** The simulator advanced by `stride = coords.length / 45`, covering any route in ~36 seconds regardless of length. That was fine while the sim only had to move a puck. It is useless for turn-by-turn: on a 10-mile route each 800 ms tick covered about a quarter mile, so a "turn in 500 feet" countdown jumped straight to zero with nothing in between, and no announcement threshold could be crossed in a meaningful place.

**Decision:** The sim advances `metresPerSecond × elapsed`, taking its speed from the route's own per-step timings, and interpolates *within* a segment rather than snapping to shape points. A persisted 1×/4×/8× multiplier is read through a closure on every tick.

**Consequences:** A simulated drive now takes about as long as the real one at 1×, which is the setting for judging whether a countdown reads believably. 4× is the default because sitting through a 25-minute route is not a development loop. Reading the multiplier per tick rather than capturing it means changing speed mid-drive takes effect on the next tick with no restart. Interpolating matters more than it sounds: without it the countdown would quantise to Valhalla's shape-point spacing, which on a straight is 100 m or more. `driveDurationMinutes()` still reports `null` for sim drives — the multiplier makes wall-clock time a measurement of the UI setting rather than of the route.

---

## Turn announcements fire on threshold crossings, and outrank conversation

**Status:** Adopted (July 2026).

**Context:** Two problems. First, a level test ("are we within half a mile?") fires the moment a drive starts, because the first maneuver is routinely a few hundred metres from where the car is parked — the driver would hear "in a half mile, turn right" while still on the driveway. Second, `speak()` called `speechSynthesis.cancel()` unconditionally, so any utterance cut off any other: a turn announcement could decapitate an assistant reply, and an assistant reply could cut off "turn right onto Coop—" mid-word.

**Decision:** `TurnAnnouncer` fires only on a *downward crossing* of each threshold, once per step, and checks the near threshold before the far one. `speak()` takes a priority: `'turn'` still cancels, `'chat'` now waits for an in-flight turn and is dropped if it goes stale.

**Consequences:** A drive that begins inside the warning distance stays quiet until the turn itself, and a reroute that lands the driver mid-route announces nothing for the steps it skipped — a fresh announcer has seen no crossings. Checking the near threshold first matters when one update jumps past both, which an 8× sim tick or a GPS gap under an overpass will do: the urgent line is the one worth saying, and marking the warning spent stops it arriving after the turn it was warning about. Priority defaults to `'chat'`, so the three existing call sites behave exactly as before.

`voiceGuidance` is a separate preference from `autoSpeak` in both storage and default — `autoSpeak` reads the assistant aloud and starts off, `voiceGuidance` speaks turns and starts on. Because the key was added to an existing persisted blob, it is read as `parsed.voiceGuidance !== false` rather than `Boolean(...)`: absent means "never chose", and reading it as false would have shipped the feature muted to exactly the people who had used the app before.

---

## The places extract is checked against the region it claims to cover

**Status:** Adopted (July 2026), after the failure below.

**Context:** `data/region.json` was widened from a 5.6 × 4.9 km box to all of Arlington, and every derived artifact was rebuilt except `data/overture/places.parquet`, which kept covering the old box for eleven days. Nothing anywhere reported a problem: the file existed, the duckdb queries ran, they simply found nothing across 94% of the area the basemap was drawing labels for. Measured after the fact, 81% of the region's labelled POIs were not in the search index at all. The Overture download was also the one step of `rebuild_region.sh` that needed a tool (`uv`/`uvx`) the rest of the pipeline did not, which is how it came to be skipped.

**Decision:** `mapdata/places_coverage.check_coverage()` compares the bbox recorded in `places.parquet.state` against `region.json`, and both ends call it: `data/download_overture.sh` fails the build, and `OvertureMapDataSource.__init__` logs a warning at startup. The download itself moved to duckdb + httpfs against Overture's public S3, so it needs nothing that the query path did not already need.

**Consequences:** A short extract is now loud at build time and at boot instead of silent forever. The check is deliberately on the *recorded* bbox rather than on the data, so a region with genuinely no places near one edge doesn't fail. The runtime check warns rather than raising: an extract short on one side is still far better than no search at all, and taking the service down over it would be a worse failure than the one being prevented.

**Revisit if:** more than one extract needs this, in which case the state-file convention is worth formalising rather than repeating.

---

## Destination search indexes OSM as well as Overture

**Status:** Adopted (July 2026).

**Context:** The map's POI labels are built by Planetiler from `region.osm.pbf`; search queried an Overture extract. Two providers, two vocabularies, two id spaces, and no crosswalk between them — so "labelled on the map" and "findable by name" were only ever coincidentally the same set, and a driver hit the gap. Overture is genuinely the larger corpus (~22k places against ~3.8k named OSM POIs for the same region), so replacing one with the other was not the answer either.

**Decision:** `HybridMapDataSource` takes a *list* of places sources — `[OvertureMapDataSource, OsmPlacesSource]` — and unions them with Nominatim. `OsmPlacesSource` reads `data/osm/places.parquet`, built by `data/build_osm_places.sh` from the same `region.osm.pbf` the labels come from. Results are scored by one shared ranker (`mapdata/ranking.py`) *after* the merge and truncated afterwards.

**Consequences:** Anything the basemap can label is findable by name by construction, not by luck, while Overture still supplies the volume. Ranking had to move after the merge: the previous "Overture first, Nominatim appended, cut to five" let five weak substring matches discard an exact match another source had found before anything compared them. Dedupe needed two rules rather than one — a 50 m radius for same-ish names, and a ~1 km radius for *identical* names, because a large site is a polygon in one source and a point in the other and their centroids can sit far apart (this is why "Six Flags Over Texas" came back twice). Ranking also needed a specificity term, or every tenant whose name contains "Parks Mall" ties with the mall itself.

**Revisit if:** a third places provider arrives, or the two indexes drift far enough apart that an id crosswalk is worth building instead of a name-and-distance dedupe.

---

## The driving camera is one continuous loop, and owns the map while it runs

**Status:** Adopted (July 2026), replacing a per-fix `easeTo`.

**Context:** The camera fired a single `easeTo({duration: 650})` per position update, and updates arrive roughly once a second. It therefore moved for 650 ms and then sat still for ~350 ms, repeatedly. The 650 ms was chosen deliberately, to stop eases overlapping — the original comment's reasoning ("overlapping eases read as the camera drifting rather than tracking") was correct, and the dead gap it produced is what a driver described as the rotation into a turn being good but not smooth.

**Decision:** `lib/driveCamera.ts` runs a `requestAnimationFrame` loop holding a target (updated per fix) and a current state, interpolating between them each frame with a first-order lag from `lib/smoothing.ts`.

**The constraint that is invisible from the call site:** maplibre-gl 5's `Camera.jumpTo` begins with `this.stop()`. A per-frame `jumpTo` therefore cancels any animation in flight, so **while the loop runs nothing else may call `easeTo`/`flyTo`/`fitBounds`/`jumpTo` on the map**. The drive-end unwind calls `driveCamera.stop()` *before* its `fitBounds` for exactly this reason, and `recenter()` pauses the loop for the duration of its ease. Anyone adding an `easeTo` back to a drive-time path will find it silently cancelled a frame later.

`jumpTo` also fires `movestart`/`move`/`moveend` on every call — measured at 360 events in 6 seconds — so `moveend` → `setMapCenter` is guarded by `navigatingRef`, or a drive would push 60 store writes a second.

**Consequences:** A first-order lag rather than a spring, because a spring overshoots and overshoot on a bearing is the "drifting rather than tracking" failure again; and because `1 - exp(-dt/tau)` is exactly frame-rate independent, which is a property a test can assert and the thing a later simplification to a fixed per-frame factor would break. Bearings interpolate on the short arc, or a driver crossing north sends the camera 358° the wrong way mid-turn. The loop settles and then sleeps, since a phone in a hot windscreen mount for 25 minutes is a real constraint. Owning every frame also makes dead reckoning possible: the target advances along the *route* (not the heading vector, which would fling the puck off every bend) capped at 1.5 s, so the puck freezes in a tunnel rather than confidently driving down a road the car may have left.

**Revisit if:** MapLibre gains a first-class "follow this position" camera mode, which would make most of this file redundant.

---

## Snap-to-route is display-only, and gated on confidence

**Status:** Adopted (July 2026).

**Context:** The puck was drawn at the raw GPS fix. In an outer lane of a six-lane arterial that is 10–15 m off the route's centreline, and a driver reported it as looking like the app thought they were making a mistake. There was no map matching anywhere in the codebase.

**Decision:** Each fix is projected perpendicularly onto the route (`lib/snapToRoute.ts`) and the puck is drawn on the line, blended toward the raw fix by a confidence weight. The weight combines distance — against a corridor that widens with the fix's own reported accuracy — with heading agreement between the fix's course and the road's direction, both smoothstepped, and is then smoothed over ~0.7 s so nothing pops.

**Only the display position is snapped.** `DriveController` keeps pushing raw coordinates to `/gps-update`, because `services/signal_processor.py` scores route adherence off that trace: posting snapped points would make `adherence_rate` 1.0 by construction and quietly poison the reward signal the whole learning loop depends on. The sim honours the same rule — under `?jitter=` it displays the scattered position and buffers the true one.

**Consequences:** The heading term is *directed*, not folded to ±90°, so the opposite carriageway of a divided road scores ~180° and correctly refuses to snap; folding would have stuck the puck on the wrong roadway, which is worse than not snapping. Confidence collapsing on a genuine wrong turn is what keeps the screen honest — it releases within about two seconds rather than lying until re-routing notices. Progress now comes from the projection too, replacing a nearest-shape-point scan that quantised to Valhalla's spacing (100 m+ on a straight) and took the turn countdown with it. The search is windowed around the last position, which is what stops a route that doubles back from matching a leg driven ten minutes ago, but the first fix of a drive still scans the whole line because a reroute restart can resume anywhere.

**Revisit if:** the app needs to know which *lane* the driver is in, or starts routing on roads dense enough that a 1 km-scale windowed search picks the wrong parallel road — either would mean reaching for Valhalla's `trace_attributes` map matching instead.
