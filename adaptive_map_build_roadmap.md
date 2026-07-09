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
4. [Phase 1 — Base Route Planner](#phase-1--base-route-planner-weeks-1-8)
5. [Phase 2 — LLM Conversation Layer](#phase-2--llm-conversation-layer-weeks-9-16)
6. [Phase 3 — RL Personalization Engine](#phase-3--rl-personalization-engine-weeks-17-28)
7. [Integration & End-to-End Testing](#integration--end-to-end-testing)
8. [Deployment & Infrastructure](#deployment--infrastructure)
9. [Milestone Checklist](#milestone-checklist)

---

## Tech Stack Master Reference

### Backend
| Component | Technology | Why |
|---|---|---|
| API framework | FastAPI (Python) | Async, fast, auto-generates OpenAPI docs. Python keeps ML and API in the same language. |
| Database | PostgreSQL + PostGIS | PostGIS extension makes Postgres a full spatial database — required for road network queries. |
| Cache / fast store | Redis | Sub-millisecond reads for user profiles, active sessions, real-time route state. |
| Message queue | Celery + Redis | Async task processing for post-trip signal analysis, LLM reward extraction, RL updates. |
| Map tile server | Martin (Rust) or pg_tileserv | Serves vector tiles directly from PostGIS. Extremely fast. |

### Routing Engine
| Component | Technology | Why |
|---|---|---|
| Base routing engine | Valhalla (open source) | More flexible than OSRM — supports custom cost functions, which you NEED for RL weight injection. Runs as a local service. |
| Map base data | OpenStreetMap (OSM) | Free, global, updated by community. Your real-time updates layer on top. |
| Graph representation | NetworkX → PyTorch Geometric | NetworkX for initial prototyping, PyTorch Geometric for production GNN. |

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

---

## Repository & Environment Setup

**Do this in Week 1 before anything else.**

### Step 1 — Repository structure

Create one monorepo. Jonathan sets this up and invites you.

```
adaptive-map/
├── backend/                  # FastAPI + all Python services
│   ├── api/                  # Route handlers, request/response models
│   ├── routing/              # Valhalla client, cost function injection
│   ├── ml/                   # GNN, RL, preference embedding code
│   │   ├── gnn/
│   │   ├── rl/
│   │   ├── llm/              # Claude API wrappers, prompt templates
│   │   └── federated/        # Flower server code
│   ├── services/             # Celery tasks, background workers
│   ├── db/                   # SQLAlchemy models, Alembic migrations
│   └── tests/
├── frontend/                 # React + TypeScript
│   ├── src/
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── stores/           # Zustand state
│   │   └── services/         # API client code
│   └── tests/
├── valhalla/                 # Valhalla config files and custom costing
├── data/                     # OSM data download scripts, pipeline scripts
├── infra/                    # Docker Compose, Terraform (later), Nginx config
│   └── docker-compose.yml
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

```bash
cd backend
poetry init
poetry add fastapi uvicorn[standard] sqlalchemy alembic asyncpg \
  psycopg2-binary redis celery aioredis httpx python-dotenv \
  pydantic-settings geopandas shapely anthropic openai \
  torch torchvision torch-geometric \
  stable-baselines3 gymnasium ray[rllib] flwr \
  faster-whisper mlflow qdrant-client
poetry add --group dev pytest pytest-asyncio httpx black ruff mypy
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
      - use_tiles_ignore_pbf=True

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

---

## Phase 1 — Base Route Planner (Weeks 1–8)

**Goal by end of Phase 1:** A working web app where a user can type an origin and destination, get a route drawn on a map, and drive it with basic turn-by-turn navigation. No ML yet — clean, fast, correct.

---

### Week 1–2 — OSM Data Pipeline + PostGIS Schema

**Who:** Jonathan on PostGIS, You on Valhalla config

#### Get OSM data

Download a regional extract to start (your city or state, not the whole world yet). Use Geofabrik — they provide daily updated OSM extracts.

```bash
# data/download_osm.sh
mkdir -p data/osm
# Example: Initializing Agent Architecture Framework
2:10 PM
I have updated the implementation plan in the 
implementation_plan.md
 artifact to specifically include cropping the OSM data to the Central Arlington bounding box (bounded by I-30, W Park Row Dr, Fielder Rd, Collins St) using osmium extract.

Please review the updated plan and let me know if it looks good, or if you'd like any other adjustments before we begin the instantiation process!

Implementation Plan
1:59 PM
Proceeded with
Implementation Plan
I've completed the environment setup and instantiated the initial repository structure based on the roadmap.

You can review the summary of the work done in the 
walkthrough.md
 artifact. Let me know if you would like me to proceed with the next steps (such as downloading the map data and building the Valhalla routing tiles).

Task
Walkthrough
2:16 PM
Lets move on to phase 1. lets start with getting OSM Data first
4:24 PM
I've successfully updated the script for macOS compatibility (switching from wget to curl) and ran it to pull down the OSM Data!

The Texas extract (~676 MB) was downloaded, and we used osmium to successfully crop the map down exactly to the Central Arlington bounding box (-97.140, 32.715, -97.080, 32.760).

The cropped data is now sitting securely in 

region.osm.pbf
, which is a lean 1.06MB file perfectly primed for our initial development. I've tracked this update in the 
walkthrough
 and 
task
 lists.

According to our roadmap for Phase 1, the next step is to build Valhalla tiles from this OSM data using Docker. Would you like me to proceed with building the routing tiles and spinning up the backend container infrastructure?

Task
Walkthrough
4:23 PM
7:39 PM
Texas extract (~700MB). Replace with your region.
wget https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf \
  -O data/osm/region.osm.pbf

# Verify the download
osmium fileinfo data/osm/region.osm.pbf
```

#### Build Valhalla tiles from OSM data

Valhalla needs to pre-process OSM data into its own tile format. This takes 15–45 minutes depending on region size.

```bash
# valhalla/valhalla.json — Valhalla configuration
{
  "mjolnir": {
    "tile_dir": "/tiles",
    "max_cache_size": 1000000000,
    "hierarchy": true,
    "shortcuts": true,
    "include_bicycle": true,
    "include_pedestrian": true
  },
  "loki": {
    "actions": ["locate", "route", "optimized_route", "sources_to_targets"],
    "service": { "proxy": "none" }
  },
  "thor": {
    "service": { "proxy": "none" }
  }
}

# Build tiles (run inside the valhalla container)
docker compose run valhalla valhalla_build_config \
  --mjolnir-tile-dir /tiles \
  --mjolnir-timezone /tiles/tz_world.sqlite \
  --mjolnir-admin /tiles/admins.sqlite > valhalla/valhalla.json

docker compose run valhalla valhalla_build_tiles \
  -c /custom_files/valhalla.json \
  /custom_files/region.osm.pbf
```

#### PostGIS schema

```sql
-- db/migrations/001_initial_schema.sql

-- Enable PostGIS
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  onboarding_completed BOOLEAN DEFAULT FALSE
);

-- User preferences (starts simple, grows with ML)
CREATE TABLE user_preferences (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  avoid_highways BOOLEAN DEFAULT FALSE,
  avoid_tolls BOOLEAN DEFAULT FALSE,
  avoid_left_turns BOOLEAN DEFAULT FALSE,
  prefer_scenic BOOLEAN DEFAULT FALSE,
  max_acceptable_detour_minutes INT DEFAULT 5,
  -- Preference embedding stored here once ML layer is built
  preference_vector FLOAT[] DEFAULT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id)
);

-- Trips (every navigation session is recorded)
CREATE TABLE trips (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  origin GEOGRAPHY(POINT, 4326) NOT NULL,
  destination GEOGRAPHY(POINT, 4326) NOT NULL,
  suggested_route JSONB NOT NULL,          -- The route we suggested
  actual_path_taken JSONB DEFAULT NULL,    -- GPS trace of what user actually drove
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ DEFAULT NULL,
  context JSONB DEFAULT '{}',              -- Time of day, weather, declared intent
  implicit_signals JSONB DEFAULT '{}',     -- Deviations, app switches, pace changes
  explicit_feedback TEXT DEFAULT NULL,     -- Post-trip user text
  reward_value FLOAT DEFAULT NULL          -- Computed reward for RL (filled later)
);

-- Index for spatial queries
CREATE INDEX idx_trips_origin ON trips USING GIST(origin);
CREATE INDEX idx_trips_destination ON trips USING GIST(destination);
CREATE INDEX idx_trips_user_id ON trips(user_id);

-- Road segments we know about (starts from OSM, grows with user updates)
CREATE TABLE road_segments (
  id BIGSERIAL PRIMARY KEY,
  osm_way_id BIGINT,
  geom GEOGRAPHY(LINESTRING, 4326) NOT NULL,
  name VARCHAR(255),
  highway_type VARCHAR(50),       -- motorway, primary, residential, etc.
  speed_limit_kph INT,
  lanes INT,
  one_way BOOLEAN DEFAULT FALSE,
  last_verified_at TIMESTAMPTZ DEFAULT NOW(),
  confidence_score FLOAT DEFAULT 1.0     -- drops if conflicting reports
);

CREATE INDEX idx_road_segments_geom ON road_segments USING GIST(geom);
```

Run migrations with Alembic:

```bash
cd backend
alembic init db/migrations
# Edit alembic.ini to point to your DATABASE_URL
alembic revision --autogenerate -m "initial schema"
alembic upgrade head
```

---

### Week 3–4 — Routing Engine + Custom Cost Functions

**Who:** You. This is your path planning background applied directly.

Valhalla uses a costing model to decide route quality. You need to build a custom costing layer that accepts user preference weights — this is the hook where RL weights will plug in later.

#### Valhalla custom costing (Python client)

```python
# backend/routing/valhalla_client.py

import httpx
import json
from dataclasses import dataclass
from typing import Optional

@dataclass
class UserRoutingPrefs:
    """User preference weights injected into Valhalla's cost model.
    Starts as rule-based. RL replaces these with learned weights later."""
    avoid_highways: float = 0.0       # 0.0 = no penalty, 1.0 = avoid entirely
    avoid_tolls: float = 0.0
    prefer_scenic: float = 0.0
    avoid_left_turns: float = 0.0
    urgency: float = 0.5              # 0.0 = leisurely, 1.0 = fastest possible

class ValhallaRouter:
    def __init__(self, base_url: str):
        self.base_url = base_url
        self.client = httpx.AsyncClient(timeout=30.0)

    def _build_costing_options(self, prefs: UserRoutingPrefs) -> dict:
        """Translate user preferences into Valhalla costing parameters.
        
        This function is the bridge between user preferences and routing.
        RL will eventually generate these weights instead of rule-based logic.
        """
        # Use_highways: 0.0 = avoid, 1.0 = prefer. Valhalla's scale.
        use_highways = 1.0 - (prefs.avoid_highways * 0.9)
        use_tolls = 1.0 - (prefs.avoid_tolls * 0.9)
        
        # Urgency shifts the cost function toward time vs. distance
        # High urgency = weight time heavily; low urgency = consider alternatives
        shortest = 0.0 if prefs.urgency > 0.7 else (0.5 if prefs.urgency < 0.3 else 0.2)

        return {
            "auto": {
                "use_highways": use_highways,
                "use_tolls": use_tolls,
                "shortest": shortest,
                "top_speed": 130,       # km/h, adjust per region
            }
        }

    async def get_route(
        self,
        origin: tuple[float, float],           # (lat, lon)
        destination: tuple[float, float],      # (lat, lon)
        waypoints: list[tuple[float, float]] = None,
        prefs: UserRoutingPrefs = None,
        alternatives: int = 3                  # Always fetch alternatives for RL data
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
            "directions_options": {
                "units": "miles",
                "language": "en-US",
                "narrative": True
            }
        }

        response = await self.client.post(
            f"{self.base_url}/route",
            content=json.dumps(payload),
            headers={"Content-Type": "application/json"}
        )
        response.raise_for_status()
        return response.json()

    async def get_isochrone(
        self,
        location: tuple[float, float],
        minutes: list[int] = [5, 10, 15]
    ) -> dict:
        """Reachability polygon — useful for 'what can I reach in X minutes'."""
        payload = {
            "locations": [{"lat": location[0], "lon": location[1]}],
            "costing": "auto",
            "contours": [{"time": m} for m in minutes],
            "polygons": True
        }
        response = await self.client.post(
            f"{self.base_url}/isochrone",
            content=json.dumps(payload)
        )
        response.raise_for_status()
        return response.json()
```

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

For geocoding (turning "Austin, TX" into coordinates), use **Nominatim** — the OSM geocoder. Self-host it or hit the public endpoint for development.

```python
# backend/routing/geocoder.py

import httpx

async def geocode(query: str) -> dict | None:
    """Convert place name or address to lat/lon using OSM Nominatim."""
    async with httpx.AsyncClient() as client:
        response = await client.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": query, "format": "json", "limit": 5},
            headers={"User-Agent": "AdaptiveMapApp/0.1 contact@yourapp.com"}
        )
        results = response.json()
        if not results:
            return None
        return {
            "lat": float(results[0]["lat"]),
            "lon": float(results[0]["lon"]),
            "display_name": results[0]["display_name"]
        }
```

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
- [ ] GET `/api/v1/routing/route` returns a valid Valhalla route
- [ ] Route alternatives (3 options) return correctly
- [ ] Trips are saved to the database on every route request
- [ ] MapLibre GL renders a route on the map in the browser
- [ ] User can type a place name and get coordinates (geocoding works)
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
