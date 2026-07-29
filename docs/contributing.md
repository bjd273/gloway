# Contributing

How to work in this codebase. Read [setup.md](setup.md) first to get it running.

> `CLAUDE.md`, `AGENTS.md` and `GEMINI.md` at the repo root are instructions for AI coding
> agents, not for humans, and describe a generic workflow rather than this repo's structure.
> This page is the human version.

## Where things go

| If you're changing... | Go to |
|---|---|
| An HTTP endpoint | `backend/api/routes/` — one module per router |
| How routes are generated or ranked | `backend/routing/` |
| Anything about places or addresses | `backend/mapdata/` — and only there |
| Prompts, extraction, or the LLM provider | `backend/ml/llm/` |
| Database shape | `backend/db/models.py` + a migration |
| Map rendering | `frontend/src/lib/routeLayers.ts` and `MapView.tsx` |
| Anything pure and testable in the UI | `frontend/src/lib/` — not a component |
| Client state | `frontend/src/stores/` |

The frontend convention is that components subscribe to store slices and call actions, and the
real logic lives in `lib/` as pure functions. That is why the test suite is weighted toward
`lib/` and there are no component render tests.

## Rules worth knowing before you change something

**Don't bypass the two abstraction seams.** `MapDataSource` (`backend/mapdata/`) and `LLMClient`
(`backend/ml/llm/`) exist so a provider swap is one new file plus one config flip. Concretely:
no code outside `mapdata/` may call Overpass, Nominatim, or Overture directly, and no code
outside `ml/llm/` may import a provider SDK or hit a provider URL. `factory.py` in each package
is the only place a provider name appears.

**`data/region.json` is the single source of truth for coverage.** Four artifacts derive from it
— Valhalla tiles, the Martin basemap, the Overture extract, and the frontend's coverage gate. Edit
that one file and run `./scripts/rebuild_region.sh`; never hand-edit
`frontend/src/lib/region.json`, which the script overwrites. Keeping them in sync manually is four
chances to miss one, and the failure is silent.

**`LLMUnavailable` is the only exception allowed to cross the LLM boundary.** Provider-specific
failures get caught and re-raised as it, so callers never have to guess. The `_llm()` dependency
turns it into a `503`, and the frontend reads `503` as "feature off", not as an error.

**Every user-facing error string in the frontend lives in `lib/api.ts`.** Components and stores
never format raw HTTP details.

**The `gw-` layer id prefix is a contract.** The theme-swap logic preserves `gw-` sources across
`setStyle` and re-adds those layers. A runtime map layer without the prefix will vanish when the
system theme changes.

## Running things

```bash
# Backend
cd backend
poetry run pytest
poetry run pytest -m "not integration"     # skip anything needing live services
poetry run uvicorn api.main:app --reload --port 8000

# Frontend
cd frontend
npm test          # vitest
npx tsc -b        # typecheck
npx oxlint src    # lint
npm run dev
```

Integration tests self-skip when Valhalla or Postgres aren't reachable, and the Overpass contract
tests skip on 5xx/timeout rather than failing, so a bare checkout stays green. `tests/fakes.py`
provides a fake LLM, so conversation paths are testable without an API key.

Both suites should be green before you commit. As of this writing: **209 passed, 2 skipped** on
the backend (the skips are the integration tests, with services up they run too) and **82 passed**
on the frontend.

## Dependencies

Backend dependencies are Poetry groups, and the ML ones are **optional** so a normal install stays
fast:

```bash
poetry install              # default: API, DB, routing, LLM
poetry install --with gnn   # torch + torch-geometric
poetry install --with rl    # gymnasium, stable-baselines3, mlflow, qdrant-client
poetry install --with ml    # remaining ML odds and ends
```

If you add a heavy dependency that only training needs, put it in a group rather than the default.

## Database migrations

```bash
cd backend
poetry run alembic revision --autogenerate -m "add whatever"
poetry run alembic upgrade head
```

Run from `backend/` — `alembic.ini` sets `script_location = %(here)s/db/migrations`. Read the
generated migration before applying it; autogenerate is good at columns and bad at PostGIS types
and indexes.

Note that JSONB columns often make a migration unnecessary. When
`trip_conversations.preference_updates_extracted` changed from a single object to a per-turn list,
no migration was needed — JSONB stores arrays natively, and pre-existing rows stayed `NULL`.

## Code style

There is no formatter enforced in CI, so match the file you're in. Two things are consistent
across the codebase and worth continuing:

**Comments explain *why*, not *what*.** The valuable ones record the thing that was tried and
failed, or the constraint that isn't visible from the code. For example, from `routeLayers.ts`:

```ts
// The lit remainder stays on the ORIGINAL colour ramp rather than restarting
// it at the driver, so a stretch of road keeps its colour for the whole drive.
// Restarting looked livelier in isolation and awful in motion: the ribbon
// recoloured itself under you continuously, which reads as the route changing
// rather than as you advancing along it.
```

That is worth a paragraph. `// set the gradient` is not.

**Tests assert the claim, not the implementation.** The most useful test in the frontend suite is
the one proving that an unevenly spaced route is 2% along by distance where index-based maths
would say 67% — it encodes *why* the module exists.

## Commits and PRs

Commit messages: imperative mood, describing the change's effect rather than its mechanics.
Recent history for the shape:

```
Generate route candidates by sweeping costing strategies, not one call
Stop discarding explicit feedback: split reward confidence from preference confidence
```

Work on a branch and open a PR. Keep commits thematically separable where the files allow it —
note that git commits whole file states, so a file touched by two efforts can only land once.

## Documentation

Keep these current with behaviour changes:

- `docs/api.md` when an endpoint's contract changes
- `docs/decisions.md` when you make a non-obvious call worth defending later
- `adaptive_map_build_roadmap.md` for substantial features — it is the build log, and its
  convention is a bolded **Built (date)** note listing numbered deviations from the original plan
- `frontend.md` (repo root) for UI changes and the reasoning behind them

Write about what is actually built. The roadmap is written partly in ambition tense; the wiki is
not, and the distinction is the whole reason the wiki exists.

## A note on headless browsers

The in-editor browser preview **never fires `requestAnimationFrame`**. Three consequences, all of
which look like bugs in your code:

- MapLibre's `easeTo`, `flyTo` and `fitBounds` never complete. `jumpTo` commits immediately.
- CSS transitions freeze at their starting value.
- `ResizeObserver` callbacks don't fire, so anything downstream of a measured element (such as
  the `--gw-sheet-h` variable the sheet publishes) goes stale.

You can still verify static layout, computed styles, DOM structure, and paint properties. Camera
behaviour, transitions and sheet-height tracking need a real browser. Workarounds that make
headless verification possible: drive the camera with `jumpTo`, set `transition: none` before
measuring, and set the CSS variable directly instead of waiting for the observer.

## Known rough edges

Things a newcomer will trip over that are known, not mysteries:

- `backend/Dockerfile` doesn't exist, so the `backend` and `celery_worker` Compose services can't
  build. Run the backend on the host.
- `redis` and `celery_worker` are declared for an async pipeline that was never built.
- The GNN encoder is randomly initialised and never trained, so its 128 dims are a constant.
- The route scorer needs ≥30 completed trips before `train_route_scorer.py` emits a model; until
  then ranking falls back to Valhalla's order.
- Real drive data needs an HTTPS origin (`./scripts/drive.sh`). Simulated drives replay the
  suggested route's own coordinates, so adherence is 1.0 by construction and the implicit reward
  carries no information.
