# Gloway frontend

Minimal, search-first route planner on MapLibre GL. Light/dark follows the
system theme; the glowing route is the brand.

## Running locally

Everything below assumes the repo root as working directory.

```bash
# 1. Infra: Postgres, Valhalla (routing, :8002), Martin (basemap tiles, :3001)
docker compose -f infra/docker-compose.yml --project-directory . up -d postgres valhalla martin

# 2. Backend API (:8000)
poetry --directory backend run uvicorn api.main:app --port 8000

# 3. Frontend (:3000)
npm --prefix frontend run dev
```

The Vite dev server proxies `/api/v1/*` to the backend and `/api/tiles/*` to
Martin — the browser only ever talks to :3000.

## Map styles

Two committed MapLibre styles in `src/styles/`:

- `mapStyleLight.json` — vendored OpenFreeMap "liberty".
- `mapStyleDark.json` — generated from openmaptiles/dark-matter-gl-style by
  `npm run vendor:styles` (see `scripts/vendor-map-styles.mjs` for the pinned
  upstream commit and the transforms applied). Re-run only when bumping the
  pin; the output is committed so builds never fetch from GitHub.

Both keep the OpenMapTiles attribution requirement intact
(© OpenMapTiles © OpenStreetMap contributors).

## Coverage

Routing currently covers the Central Arlington, TX extract only —
`src/lib/region.ts` is the single source of truth the UI uses to filter
search results and clamp the map. Widen it when bigger OSM extracts are
built (see `data/download_osm.sh`).
