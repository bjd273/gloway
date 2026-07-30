# Frontend Reference

React 19 + TypeScript + Vite, MapLibre GL for the map, Zustand for state. No component library,
no CSS framework — one hand-written stylesheet (`src/index.css`) against the tokens in
[`DESIGN.md`](../DESIGN.md).

```bash
cd frontend
npm install
npm run dev      # :3000
npm test         # vitest
npx tsc -b       # typecheck
npx oxlint src   # lint
```

For *why* the UI looks the way it does, see [`frontend.md` at the repo root](../frontend.md) —
that file is the design changelog. This page is the structural map.

## The shape of the app

Everything floats over a full-bleed map. `App.tsx` sets the stacking order and nothing else:

```
MapView          z 0    full-bleed map + all MapLibre controls
Wordmark         z 20   top-left
PrefsPanel       z 30   the gear, top-right
AssistantBubble  z 28   transient assistant reply, above the sheet
Sheet            z 25   the bottom sheet
  └ TripSheet           all trip content
```

The bubble is a **sibling** of the sheet, not a child: inside it, the sheet's `overflow` would
clip it and the sheet's scrolling would drag it around.

## Components

| Component | Responsibility |
|---|---|
| `MapView.tsx` | Owns the MapLibre instance. Markers, route layers, both camera modes, the locate control, and the mid-drive re-centre pill. The largest file in the frontend and the only one that talks to MapLibre. |
| `Sheet.tsx` | The bottom-sheet *shell*: three snap heights, drag-to-resize, and publishing its measured height. Knows nothing about trips. |
| `TripSheet.tsx` | Everything *inside* the sheet — destination search before a trip, then route cards, travel mode, steps, actions, wrap-up. Also owns snap policy. |
| `RouteCard.tsx` | One route option: name, time, delta versus the recommendation, and a "why" line. The leading stroke is a map-legend swatch in that route's line colour. |
| `PlaceSearchField.tsx` | Address/place search, shared by the destination field and the home/work pickers in preferences. |
| `ChatBar.tsx` | The conversation reduced to one input bar pinned to the sheet. |
| `AssistantBubble.tsx` | The assistant's latest reply, briefly, over the map. |
| `NavVoice.tsx` | Hands-free voice during a drive. Mounts only while navigating and holds the WebSocket for the whole trip — which is why `TripSheet` never conditionally unmounts its subtree per snap. |
| `Debrief.tsx` | The post-trip question, in the sheet's wrap-up slot. |
| `PrefsPanel.tsx` | Driving preferences and saved home/work locations. |
| `Wordmark.tsx` | The mark, top-left. |

### One structural rule

`TripSheet`'s content is **always mounted**; the snap height only changes what is *visible*.
Unmounting per snap would tear down `NavVoice`'s WebSocket mid-drive. The layout is:

```
header + summary   always visible          ← peek stops here
scroll region      routes, mode, stops, steps
actions            always visible (the primary action must be reachable at peek)
footer             ChatBar before a drive, NavVoice during one
```

### Snap policy lives in `TripSheet`, not the sheet store

How tall the panel is has nothing to do with what the trip is, so `Sheet.tsx` owns mechanism and
`TripSheet` owns policy:

- `status === 'idle'` → `half`
- `status === 'ready'` with **one** route → `peek`, so the map gets the screen
- `status === 'ready'` with **several** routes → `half`, because then the choice *is* the answer
- navigating → `peek`, and a mid-drive reroute must not throw the sheet over the map

## Stores

Six Zustand stores. Components subscribe to slices and call actions; almost no logic lives in
components.

| Store | Owns | Notable |
|---|---|---|
| `useTripStore` | Endpoints, stops, fetched routes, selection, travel mode, nav phase/progress, live position | `requestRoute()` is the single place `getRoute()` is called; every mutation funnels through it or `refreshRoute()`. Holds the non-serializable `DriveController` outside store state on purpose. |
| `useUserStore` | Remembered account, preferences, journey profile | Preferences are optimistic: set locally, `PATCH`ed, reverted on failure. Persisted to `localStorage` under `gloway:user`. |
| `useConvoStore` | Pre-trip conversation | Exports `applyReplyResult()` — see below. |
| `useDebriefStore` | Post-trip debrief | Mirrors the conversation store's open/reply shape. |
| `useVoiceStore` | Whether replies are read aloud | Persisted under `gloway:voice`; auto-enables the first time the mic is used. |
| `useSheetStore` | Current snap and the sheet's **measured** height | Measured, not computed from `dvh` — mobile browser chrome slides in and out while driving, so the mapping shifts underneath you. A store rather than props because `MapView` is a sibling of the sheet. |

`applyReplyResult()` in `useConvoStore.ts` is the single place a backend reply turns into store
mutations — route switch, stop insertion, mode change, destination override, preference sync.
Both the HTTP pre-trip path and the WebSocket voice path call it, so "take me home" typed before
the drive and spoken during it behave identically.

## `lib/`

| Module | Purpose |
|---|---|
| `api.ts` | The only module that calls `fetch` or opens the WebSocket. Every user-facing error string lives here (`FriendlyError`) so components never format raw HTTP. Also decodes Valhalla trips into `ParsedRoute` and extracts each route's dominant street. |
| `navigation.ts` | `DriveController` — the live position source. |
| `routeProgress.ts` | Distance-along-route maths shared by the drive controller and the map. |
| `routeLayers.ts` | The MapLibre layer stack for routes. |
| `routeColors.ts` | The only place route-line colours are written down. |
| `routeSummary.ts` | Pure formatting for the cards: durations, distances, deltas, the "why" line, and route naming. |
| `geolocate.ts` | Two ways to ask for the device's location, deliberately different (below). |
| `placeLabels.ts` | Remembers what a saved coordinate was called when the user picked it. |
| `region.ts` / `region.json` | The coverage gate. `region.json` is **copied** from `data/region.json` by `rebuild_region.sh` — never edit it directly. |
| `mapStyles.ts`, `styles/*.json` | Light and dark basemap styles, vendored via `npm run vendor:styles`. |
| `voice.ts`, `recorder.ts`, `navVoice.ts` | Browser TTS/STT feature detection, the `MediaRecorder` fallback capture, and the in-drive voice socket client. |

### Two geolocation functions, on purpose

`resolveOrigin()` is for routing: the user asked for a route, not a permission dialog, so a denial
or a slow fix silently falls back to the map centre. `requestCurrentLocation()` is for an explicit
tap and **must** report failure with a typed reason — the silent fallback would quietly save the
map centre as the user's home address. Copy for every failure lives in
`LOCATION_FAILURE_MESSAGE` so callers don't invent their own.

Both region-gate the result, so outside Arlington the locate button correctly reports
"You're outside the area Gloway covers right now" rather than moving the map.

## The map layer stack

Everything `MapView` adds at runtime uses a `gw-` id prefix. That prefix is a **contract**: the
theme-swap logic preserves `gw-` sources across `setStyle` and re-adds the layers with the new
theme's paints.

| Layer | Source | Role |
|---|---|---|
| `gw-routes-alt` | `gw-routes-alt` | Unselected routes. Always neutral grey — anything the user has not chosen must not compete with the selection. Clickable. |
| `gw-route-halo` | `gw-route-selected` | The wide blurred glow. |
| `gw-route-casing` | `gw-route-selected` | The crisp white body under the core. |
| `gw-route-core` | `gw-route-selected` | The gradient ribbon. |

The selected source sets `lineMetrics: true`, which is what makes `line-progress` gradients
possible.

`setRouteProgress(map, theme, progress)` rewrites all three selected-route gradients so the
traveled span goes flat grey and loses its glow while the road ahead keeps the ribbon. It is
paint-only and idempotent because it runs on every GPS fix. `progress` is a fraction of route
**length**, not of coordinate count — see below.

## The drive loop

```
DriveController ──onPosition──▶ useTripStore.currentPosition ──▶ MapView puck
       │         ──onProgress──▶ useTripStore.navProgress   ──▶ setRouteProgress
       │                                                     ──▶ TripSheet progress bar
       │                                                     ──▶ NavVoice remaining time
       └──batched every 3s──────▶ POST /trips/{id}/gps-update
```

`DriveController` has two position sources sharing one downstream pipeline:

- **`real`** — `navigator.geolocation.watchPosition`. Requires a secure context.
- **`sim`** — walks the route's own coordinates on a timer (~36 s per route). Selected with
  `?sim=1`, or automatically when the Geolocation API is missing.

Buffering, batch flushes, the puck, and arrival are identical in both modes, which is what makes
sim an honest stand-in. On arrival the controller flushes the tail **before** announcing, because
`onArrive` triggers `POST /complete` and completion scores adherence against whatever has reached
the server.

### Progress is a fraction of length, not of coordinates

Valhalla packs shape points tightly through curves and spreads them on straights, so coordinate
50 of 100 is routinely nowhere near the halfway mark. `routeProgress.ts` does the maths in
cumulative metres:

- `lengthFractions(coords)` — cumulative length fraction per coordinate, index-parallel so a
  nearest-point search converts in O(1). Degenerate routes return zeros, never `NaN` — a `NaN`
  reaching `line-progress` blanks the route silently.
- `bearingAtFraction(...)` — compass bearing from the route's **geometry**, looking ~60 m ahead,
  not from consecutive GPS fixes. A fix-delta bearing spins randomly at a standstill and a map
  that spins at every red light is unusable.

## Camera modes

Two deliberately distinct modes, not one with tweaks.

**Planning** — flat overview. A zoom band auto-tilts to `pitch: 45` above zoom 16.5 and back flat
below 15.5 (hysteresis prevents flapping), and any user pitch gesture disables the automation.

**Driving** — `NAV_ZOOM 16.8`, `NAV_PITCH 55`, bearing tracking the route so "ahead" is up, and a
padding that weights the **top** so the puck sits low and the screen is spent on road ahead. The
zoom-band automation is suppressed while driving, or the two would fight over pitch. Touching the
map releases follow and raises a "Re-center" pill; the guard is `originalEvent`, so the app's own
`easeTo` can't trip it.

## Route naming

Three inputs decide what a card says, resolved for the whole set at once by
`routeLabels(routes)`:

1. If a strategy purpose-built the route (`isPrimary`, from the backend's `route_primary`), its
   name is the real answer — "No highways", "Fewest turns".
2. Otherwise the route is named by the road it spends the most **distance** on —
   `via S Cooper St`. `dominantStreet()` in `api.ts` weights by distance rather than maneuver
   count, and excludes the first and last maneuvers because every candidate for a trip leaves
   from and arrives on the same street.
3. Failing that, a superlative that is true of the set on offer, then the backend's label.

Resolved as a whole array so two alternates can't both claim the same road — that is a worse lie
than "Another way", because it asserts a distinction and gets it wrong. `abbreviateRoad()`
shortens to street-sign form (`South Collins Street` → `S Collins St`) while leaving route
numbers like `TX 180` alone.

## Testing

`npm test` runs vitest. The suite is deliberately weighted toward the pure modules where the
logic actually lives:

| File | Covers |
|---|---|
| `navigation.test.ts` | `DriveController` — fix throttling, nearest-point progress, arrival ordering, the tail flush, permission denial. Injects a fake Geolocation and mocks the API. |
| `routeProgress.test.ts` | Length-vs-index progress, degenerate routes, bearing orientation and lookahead smoothing. |
| `routeSummary.test.ts` | Formatting, route naming and de-duplication, road abbreviation. |
| `api.test.ts` | `dominantStreet` — distance weighting, first/last exclusion. |
| `geolocate.test.ts` | Both geolocation paths, including every failure reason. |
| `placeLabels.test.ts`, `useSheetStore.test.ts` | Label memory, snap resolution. |

There are no component render tests. Interaction and layout are verified in a real browser
instead — and note the caveat in [contributing.md](contributing.md#a-note-on-headless-browsers).

## Related pages

- [Architecture](architecture.md)
- [API Specification](api.md)
- [`frontend.md` (design changelog)](../frontend.md), [`DESIGN.md`](../DESIGN.md)
