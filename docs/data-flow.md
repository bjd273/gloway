# Data Flow & Sequence Diagrams

## 1. Route calculation

The core loop: pick two points, get a route, and have that request itself become training data for later.

```mermaid
sequenceDiagram
    participant U as User
    participant FE as Frontend (useTripStore)
    participant API as POST /api/v1/routing/route
    participant DB as Postgres
    participant VH as Valhalla

    U->>FE: drop/search origin & destination
    FE->>API: RouteRequest {origin, dest, user_id?, declared_intent?, waypoints, mode}
    API->>DB: SELECT user_preferences WHERE user_id
    DB-->>API: avoid_highways / avoid_tolls / prefer_scenic / avoid_left_turns
    Note over API: _load_prefs() builds UserRoutingPrefs<br/>declared_intent overrides urgency (hurry=1.0, explore=0.2)
    API->>API: _build_costing_options(prefs) — clamped 0..1 values

    Note over API,VH: candidate_generator.generate_candidates()<br/>skipped under 2 straight-line miles — baseline only
    par one call per costing strategy, concurrently
        API->>VH: POST /route (baseline)
    and
        API->>VH: POST /route (use_highways: 0)
    and
        API->>VH: POST /route (maneuver_penalty, shortest, top_speed, use_tolls: 0)
    end
    VH-->>API: each returns {trip, alternates[]}
    Note over API: pool primaries first, then leftovers<br/>drop anything ≥0.8 geometry overlap, cap at 6

    API->>API: RouteRanker.rank() — supervised scorer, or<br/>Valhalla's order when no model is trained
    API->>DB: INSERT trips (origin, destination, suggested_route=every candidate,<br/>context={route_strategies, recommended_index, scores, ...})
    API-->>FE: RouteResponse {trip_id, routes[], recommended_index,<br/>route_labels[], route_strategies[], route_primary[]}
    FE->>FE: parseTrip() decodes polyline6 → coords + steps,<br/>and dominantStreet() picks each route's main road
    FE->>FE: routeLabels() names the set — strategy name, else "via S Cooper St"
    FE->>U: render selected route (glowing) + alternates (neutral grey)
```

Every route request is persisted as a `trips` row **whether or not** anyone consumes it downstream yet — this is the raw material the Phase 3 RL trainer will eventually read (`suggested_route`, `context`, later `actual_path_taken` and `reward_value`). See `api/routes/routing.py`'s module docstring.

The sweep exists because one call is not enough: on a measured Arlington pair, Valhalla's three "alternates" were two copies of one road plus one bad option, so ranking had nothing real to choose between. See [ADR: sweep several costing strategies](decisions.md#sweep-several-costing-strategies-instead-of-trusting-one-valhalla-call).

If Valhalla returns a `4xx` (point outside the tiled region, unroutable), the backend forwards that status with Valhalla's error detail rather than a blind `500`; a `503` is returned if Valhalla is unreachable at all. The frontend maps both into one of two fixed, friendly strings (`ENGINE_DOWN_MESSAGE` / `OUT_OF_AREA_MESSAGE`) — see `lib/api.ts::getRoute`.

## 2. Geocoding / place search

```mermaid
sequenceDiagram
    participant FE as Frontend (PlaceSearchField)
    participant API as GET /api/v1/routing/search
    participant Factory as mapdata.factory
    participant Hybrid as HybridMapDataSource
    participant Overture as OvertureMapDataSource (duckdb)
    participant OsmPoi as OsmPlacesSource (duckdb)
    participant OSM as OSMMapDataSource (Nominatim)

    FE->>API: GET /search?q=...
    API->>Factory: get_map_data_source()
    Factory->>Hybrid: constructed per settings.map_data_source
    API->>Hybrid: search_addresses(q, limit=10)
    par concurrently (asyncio.gather)
        Hybrid->>Overture: search_addresses(q, limit*4)
        Hybrid->>OsmPoi: search_addresses(q, limit*4)
        Hybrid->>OSM: search_addresses(q, limit*4)
    end
    Overture-->>Hybrid: name / brand / category / address matches
    OsmPoi-->>Hybrid: matches from the same data the map labels
    OSM-->>Hybrid: Nominatim addresses, bounded to the region
    Note over Hybrid: rank the union (ranking.py),<br/>then de-dupe, then truncate
    Hybrid-->>API: merged Address[]
    API-->>FE: {results: [{lat, lon, display_name}]}
```

Any branch failing (`return_exceptions=True` in the `asyncio.gather`) degrades to the other sources' results rather than failing the whole search — see `hybrid_source.py`.

Each source is asked for more than the caller wants so the ranker has candidates to choose between; ranking happens **after** the merge, or a source listed first could fill the limit with weak matches and discard a better one another source had found. Two places supply results because the map's labels and Overture are different providers with different vocabularies — see [Decisions](decisions.md#destination-search-indexes-osm-as-well-as-overture).

## 3. Pre-trip conversation

```mermaid
sequenceDiagram
    participant FE as Frontend (useConvoStore)
    participant Open as POST .../conversation/open
    participant Reply as POST .../conversation/reply
    participant LLM as Gemini (via LLMClient)
    participant DB as Postgres

    FE->>Open: (after a route is drawn)
    Open->>DB: load trip, journey profile, preferences
    Open->>LLM: complete(PRE_JOURNEY_SYSTEM, profile+trip context)
    LLM-->>Open: one short contextual opener (<=30 words)
    Open->>DB: INSERT trip_conversations {messages:[opener]}
    Open-->>FE: {conversation_id, messages}

    FE->>Reply: {text, route_options: [{index, minutes, selected}, ...]}
    Reply->>LLM: complete(_REPLY_SYSTEM, conversation history + user text), json_mode
    LLM-->>Reply: JSON {intent, preference_updates, switch_to_route,<br/>add_stop, remove_stops, set_destination, travel_mode, confidence}
    alt add_stop present
        Reply->>Reply: _find_stop(): bbox around O-D, nearest candidate to midpoint<br/>via mapdata.factory (place-name search or category lookup)
    end
    alt preference_updates present AND confidence high enough AND trip has a user_id
        Reply->>DB: UPDATE user_preferences
    end
    Reply->>DB: append both turns to trip_conversations.messages
    Reply-->>FE: ReplyResponse {message, intent, preferences?, switch_to_route?, stop?, ...}
    FE->>FE: applyReplyResult() — reroute / switch / add stop / change mode / go home
```

Key extraction rules baked into the `_REPLY_SYSTEM` prompt (`ml/llm/conversation.py`): a one-off "avoid the highway *today*" is `intent`, not a durable `preference_updates` entry; only a clearly-stated durable preference (`"I hate highways"`) writes to `user_preferences`. Extractions below `CONFIDENCE_FLOOR = 0.5` are dropped for preferences (but `intent` always passes through — a wrong one-trip guess is cheap to undo, a wrongly-persisted preference isn't).

## 4. In-drive voice (WebSocket)

The same reply-interpretation contract as above, but over a persistent connection held open for the whole drive, with live navigation context riding along each utterance.

```mermaid
sequenceDiagram
    participant FE as Frontend (NavVoice)
    participant WS as WS /api/v1/trips/{id}/voice
    participant LLM as Gemini
    participant DB as Postgres

    FE->>WS: connect (once, at navigation start)
    WS->>LLM: get_llm_client() — closes 1011 immediately if unconfigured
    loop each utterance
        FE->>WS: {type:"utterance", mime, audio_b64, nav:{destLabel, progress, minutesRemaining, nextManeuver}, routeOptions}
        WS->>LLM: transcribe(audio, mime)
        LLM-->>WS: text (empty string = no speech heard)
        WS-->>FE: {type:"transcript", text}
        opt text non-empty
            WS->>DB: load trip + latest conversation
            WS->>LLM: interpret_navigation_reply(history, text, nav_context, route_options)
            LLM-->>WS: same structured shape as the HTTP reply path
            opt add_stop present
                WS->>WS: _find_stop() (same helper conversation.py uses)
            end
            WS->>DB: persist prefs (if any) + append turns (best-effort — never breaks the drive)
            WS-->>FE: {type:"reply", text, action:{message, intent, preferences, switch_to_route, stop, stops_cleared, set_destination, travel_mode}}
            FE->>FE: applyReplyResult(action, {reArmDrive:true}) — same parser as pre-trip
        end
    end
```

`action`'s shape is byte-for-byte the same as the HTTP `ReplyResponse` (snake_case field names preserved over the wire) specifically so the frontend's `applyReplyResult()` handles both without a second parser. The one difference: `reArmDrive: true` tells the trip store to restart the (simulated) drive on the newly-computed route after any reroute, so a mid-drive "take me home" doesn't silently end navigation.

## 5. The live drive loop

One position source feeds four consumers plus the backend. `DriveController` has two
interchangeable modes — `real` (`watchPosition`) and `sim` (walks the route's own coordinates on
a timer, selected with `?sim=1`) — and everything downstream is identical in both, which is what
makes sim an honest stand-in outside the tiled region. That equivalence is load-bearing and has to
be maintained: sim fills course, speed and snap confidence with real values rather than leaving
them blank, and `?sim=1&jitter=8` scatters its emitted position so the snapping path can be
exercised without a car.

Note the two rates. Fixes arrive about once a second and update the camera's *target*; the camera
itself moves every animation frame. And note which position goes where: the display position is
snapped to the road, the position sent to the backend never is.

```mermaid
sequenceDiagram
    participant GPS as Position source<br/>(watchPosition | sim tick)
    participant DC as DriveController
    participant Store as useTripStore
    participant Map as MapView
    participant API as POST .../trips/{id}/gps-update
    participant DB as Postgres

    loop every fix (real: every usable fix · sim: 800ms)
        GPS->>DC: {lat, lng, accuracy, heading, speed}
        DC->>DC: reject unusable fixes (accuracy > 100m, implied speed > 60m/s)
        DC->>DC: project perpendicularly onto the route (windowed)
        DC->>DC: snapConfidence → blend display position toward the road
        DC->>Store: onPosition — display position AND raw fix, course, speed
        DC->>Store: onProgress — fraction of route LENGTH, not coordinate count
        DC->>DC: buffer the RAW {lat, lon, timestamp} (≥1000ms apart)
        Store->>Map: navFix → camera target + puck arrow bearing
        Store->>Map: navProgress → setRouteProgress() greys the traveled span
        Note over Store: also drives TripSheet's progress bar<br/>and NavVoice's spoken remaining time
    end

    loop every animation frame, independent of fixes
        Map->>Map: DriveCamera eases toward the target and moves the puck
    end

    loop every 3000ms
        DC->>API: flush() — batched points [{lat, lon, timestamp}, ...]
        API->>DB: UPDATE trips SET actual_path_taken =<br/>coalesce(actual_path_taken,'[]') || :new_points
        Note over API,DB: Atomic jsonb append at the DB.<br/>Two concurrent flushes serialize under<br/>the row lock instead of one clobbering<br/>the other (the old read-modify-write bug).
    end

    DC->>DC: within 40m of the final coordinate AND past 90% of the route
    DC->>API: flush the tail FIRST
    API-->>DC: ok
    DC->>Store: onArrive() → triggers POST /complete
```

Two orderings in there are load-bearing:

- **The tail flush precedes `onArrive`.** `onArrive` triggers `POST /complete`, and completion
  scores adherence against whatever GPS has reached the server. A fire-and-forget flush raced the
  request, and the last seconds of every drive — often the whole trace — arrived too late to
  count, leaving `implicit` null on every trip in the database.
- **Arrival needs both proximity and progress.** The 90% tail check stops a loop-shaped route
  (destination near origin) from "arriving" the moment the drive starts.

See [ADR: atomic GPS append](decisions.md#atomic-jsonb-append-for-gps-breadcrumbs-not-read-modify-write) for why the append is a single `UPDATE ... = col || :new` rather than reading the array into Python, appending, and writing it back — and [ADR: distance-based progress](decisions.md#progress-is-a-fraction-of-length-not-of-coordinate-count) for why `onProgress` reports length rather than index.

## 6. Post-trip debrief → reward signal

This is the pipeline that eventually feeds RL training: a driver's reaction to the trip becomes a numeric `reward_value` on the `trips` row.

```mermaid
sequenceDiagram
    participant FE as Frontend (useDebriefStore)
    participant Complete as POST .../trips/{id}/complete
    participant Open as POST .../debrief/open
    participant Reply as POST .../debrief/reply
    participant LLM as Gemini
    participant DB as Postgres

    FE->>Complete: {duration_minutes?, deviated?}
    Complete->>DB: trip.completed_at = now(), reward_value = 0.0 (neutral default)<br/>implicit_signals.reward_source = "default_neutral"
    Note over Complete: Idempotent — a retried tap returns the<br/>existing completed_at rather than overwriting.

    FE->>Open: (drive ended, "how was it?")
    Open->>LLM: generate_debrief_question(journey, {dest_label})
    LLM-->>Open: one short question
    Open-->>FE: {message}

    FE->>Reply: {text: driver's reaction}
    Reply->>LLM: interpret_debrief(question, text)
    LLM-->>Reply: {reward_delta, confidence, preference_updates, assistant_reply}
    Reply->>DB: trip.reward_value = reward_delta<br/>implicit_signals.debrief = {...}, reward_source = "debrief"
    opt preference_updates present
        Reply->>DB: UPDATE user_preferences
    end
    Reply-->>FE: {message, reward, preferences?}
```

Every completed trip gets a `reward_value` — `0.0` by default the moment `/complete` is called, overwritten by the real `reward_delta` if the driver actually finishes the debrief. This guarantees the Phase 3 RL trainer always has a reward to read, never a `NULL`, regardless of how engaged the driver was.

## Schema (entity relationships)

```mermaid
erDiagram
    users ||--o| user_preferences : has
    users ||--o| user_journey_profiles : has
    users ||--o{ trips : makes
    trips ||--o{ trip_conversations : has

    users {
        uuid id PK
        string email
        bool onboarding_completed
    }
    user_preferences {
        uuid user_id PK, FK
        bool avoid_highways
        bool avoid_tolls
        bool avoid_left_turns
        bool prefer_scenic
        int max_acceptable_detour_minutes
        float_array preference_vector "unused today — Phase 3 RL input"
    }
    user_journey_profiles {
        uuid user_id PK, FK
        text_array typical_use_cases
        text_array stated_dislikes
        geography home_location
        geography work_location
        jsonb known_regular_routes "unused today"
        jsonb driving_persona "unused today"
        string preferred_convo_style
    }
    trips {
        uuid id PK
        uuid user_id FK "nullable — anonymous trips allowed"
        geography origin
        geography destination
        jsonb suggested_route
        jsonb actual_path_taken "GPS breadcrumbs, appended live"
        jsonb context
        jsonb implicit_signals
        text explicit_feedback
        float reward_value
    }
    trip_conversations {
        uuid id PK
        uuid trip_id FK
        uuid user_id FK "nullable"
        jsonb messages "role/content/timestamp, phase-tagged"
        jsonb preference_updates_extracted
    }
    road_segments {
        bigint id PK
        bigint osm_way_id
        geography geom "LINESTRING, junction-to-junction"
        string highway_type
        int speed_limit_kph
        int lanes
        bool one_way
    }
```

`road_segments` has no foreign key to anything else — it's populated wholesale from an OSM extract by `backend/scripts/ingest_road_segments.py` / `ml/gnn/ingest.py`, and consumed only by `ml/gnn/graph_builder.py` (not yet by any API route).
