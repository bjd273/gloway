# Frontend Design Changes

> Companion to `adaptive_map_build_roadmap.md`, which tracks the backend/ML build. This file tracks
> the UI work and — more importantly — *why* each change matters, so the reasoning survives longer
> than the memory of the drive that prompted it.

**Written:** July 2026, after the first real GPS drive (Doug Russell Park) and the shipping of the
candidate-generation layer.

---

## Why now

The backend changed shape and the UI didn't follow. Two things happened in the same week:

1. **`POST /route` now returns up to 6 genuinely different routes**, each optimised for a different
   thing (fastest, no highways, fewest turns, shortest, calmer roads), where it used to return 2–3
   near-identical ones. See the Week 27-28 notes in the roadmap and
   `backend/routing/candidate_generator.py`.
2. **The conversation layer can re-plan a trip mid-sentence** — a reply already triggers
   `refreshRoute()` (`frontend/src/stores/useConvoStore.ts:102`).

Both are core product features. Neither is visible or usable in the current UI. The app currently
renders six routes as six unlabelled minute-chips — *"7 min · 8 min · 9 min · 10 min"* — which is
strictly worse than showing three, because the user now has more choices and no basis to choose.

Feedback came from actually driving with it on a phone, which is the only way these problems surface.

---

## The strategic decision: map-first, chat as refinement

**Decided: map-first.** Recorded here because it constrains everything below and will otherwise get
relitigated.

The alternative considered was *chat-first*: converse to collect intent, then present a single best
route. Rejected for three reasons:

- **The differentiator is spatial.** Six candidates differ by *geography* — one takes I-30, one
  threads the UTA campus, one avoids the highway entirely. That is instantly comparable as coloured
  lines on a map and nearly incomprehensible as prose. Chat-first would mean describing geography in
  words, which is the worst possible medium for it.
- **It taxes every trip to serve a minority.** The common case is "I know where I'm going." A
  mandatory conversational round-trip before anything renders punishes that case to benefit the
  ambiguous one.
- **Cold start.** "Collect preferences, then show the one best route" only pays off once the system
  knows the user. At the time of writing there is exactly one real drive on file.

Where chat genuinely wins is **refinement** — "avoid the highway", "add a coffee stop", "take me
home" — and that already works. The layout just gave it the whole screen.

> **Design rule that follows from this:** in a map app, the assistant's reply *is* the route change.
> The text is confirmation. So conversation must not hold permanent screen real estate — the redrawn
> line on the map is the real answer.

---

## Changes

### 1. Route options must carry their label and their trade-off — **highest value, smallest change**

**Problem.** `TripPanel.tsx` renders each option as `formatMinutes(route.minutes)` and nothing else.
Six options appear as six bare numbers. The user cannot tell which is which, so the entire
candidate-generation feature is invisible.

**The data already exists and is being discarded.** `POST /route` returns a `route_labels` array
("Fastest", "No highways", "Fewest turns", …) parallel to `routes`. Nothing in `frontend/src/`
references it.

**Change.**
- Render label + time + **delta versus the recommended route**: `No highways · 40 min (+11)`.
  The delta is the decision-relevant number; the absolute time is not.
- Add a one-line "why": `19.0 mi · surface streets`, `22.7 mi · 6 turns`.
- Show the recommended card plus two others; collapse the rest behind "More ways".
- Colour-match each card to its polyline so tapping previews rather than commits.

**Why essential.** Without labels the backend work has no user-visible effect at all. This is the
single change that converts finished backend work into a shipped feature.

---

### 2. One bottom sheet, not two stacked panels

**Problem.** `.prompt-shell` (top, hosting the chat inline) and `.trip-panel` (bottom sheet) are
separate absolutely-positioned elements. With a conversation open they sandwich the map into a
sliver. On a phone the map — the thing that makes six routes comparable — becomes the smallest
element on screen.

**Change.** Merge into a single bottom sheet with three snap heights, the pattern Google Maps, Apple
Maps and Uber have already taught everyone:

| Height | Contents | Map |
|---|---|---|
| **Peek** | recommended route, time, one primary button | ~75% |
| **Half** | labelled route cards with deltas | ~50% |
| **Full** | turn-by-turn steps, trip detail | ~10% |

Chat collapses to a single input bar pinned to the sheet. Assistant replies appear as a transient
bubble over the map and fade — they do not stack into a permanent transcript.

**Why essential.** Directly follows from the map-first decision. Also the prerequisite for the app
being usable in a car mount, which is the actual usage context.

---

### 3. Home and work need the address search that already exists

**Problem.** `PrefsPanel.tsx` offers exactly one way to set home/work: **"Use map center"**
(line ~127). If the map is not centred on your house, you cannot set your house.

**The capability already exists.** `searchPlaces()` in `frontend/src/lib/api.ts` powers the
destination bar. `PrefsPanel` simply never calls it. `resolveOrigin()` in `useTripStore.ts` already
does geolocation.

**Change.** Add the same search field to each place row, plus "use current location". Map-center
stays as a fallback, not the only option.

**Why essential.** Home/work feed `set_destination` ("take me home") and the journey profile the
assistant reads before every trip. An unsettable home silently disables a built feature.

---

### 4. Gradient diet — one accent per screen

**Problem.** Nine selectors use `--glow-gradient`:

```
.prompt-dest-dot   .trip-time              .trip-chip--active
.prefs-save        .pref-row input:checked .convo-bubble--user
.trip-start        .trip-nav-progress-fill .nav-voice-mic
```

Four or five are visible simultaneously, all with equal visual weight. Nothing draws the eye because
everything does.

**Change.** Reduce to **one gradient per screen, reserved for the single primary action** — keep it
on `.trip-start` ("Start drive"). Everything else goes flat:

- selected route → solid accent border, not a gradient fill
- toggles, `.prefs-save`, chat bubbles → solid accent or neutral surface
- `.trip-time` → plain text; it is information, not an action

**Why essential.** Visual hierarchy is what makes a glanceable interface, and glanceability is a
safety property when the user is in a car. Also cheap: one CSS pass.

---

## Order of work

1. **Route labels + deltas** — biggest value, smallest change, data already flowing.
2. **Gradient diet** — one CSS pass, instantly calmer.
3. **Bottom sheet** — the real work; restructures `PromptBar` and `TripPanel` into one component.
4. **Home/work search** — self-contained, can land any time.

1 and 2 together would make the next real drive noticeably better on their own.

---

## Status

- [ ] 1. Route cards: label, delta, reason, collapse beyond three, colour-matched to map
- [ ] 2. Single bottom sheet with peek/half/full snap points; chat reduced to one bar
- [ ] 3. Home/work address search + "use current location"
- [ ] 4. Gradient reduced to the single primary action

---

## Deliberately not doing yet

- **Chat-first onboarding flow.** See the strategic decision above. Revisit only if drive history
  gets rich enough that "one best route, no choices" beats showing options — that is a data
  question, not a taste question.
- **Frontend test coverage beyond `navigation.test.ts`.** The drive loop is tested because a broken
  GPS pipeline silently destroys training data. Layout has no equivalent failure mode, so it is not
  worth the harness until the sheet lands and stabilises.
