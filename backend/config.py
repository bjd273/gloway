"""Application settings, loaded from environment / .env.

Kept intentionally small for Phase 1 — grows as backend services come online.
"""
from pathlib import Path

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# The .env lives at the repo root (one level above backend/). Resolve it
# absolutely so settings load identically whether the process starts from
# the repo root (launch.json), backend/ (pytest), or anywhere else.
_ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_ENV_FILE, env_file_encoding="utf-8", extra="ignore"
    )

    # In docker-compose this is http://valhalla:8002 (the service hostname);
    # for local host-side dev the compose port is published to localhost:8002,
    # which is the sensible default when no env var is present.
    valhalla_url: str = "http://localhost:8002"

    # Same host-vs-container logic as valhalla_url.
    database_url: str = "postgresql+asyncpg://postgres:adaptivemap@localhost:5432/adaptivemap"

    # Which MapDataSource the factory constructs: "osm" | "overture" | "hybrid".
    # See backend/mapdata/factory.py. Hybrid = OSM routing/addresses + Overture
    # places, merged in HybridMapDataSource.
    map_data_source: str = "hybrid"

    # Local Overture places extract (regenerate via data/download_overture.sh).
    # Absolute so it resolves identically from repo root or backend/. Missing
    # file = place search degrades to Nominatim-only, with a startup warning.
    overture_places_path: str = str(
        Path(__file__).resolve().parents[1] / "data" / "overture" / "places.parquet"
    )

    # Local OSM POI index, built from the SAME region.osm.pbf that Planetiler
    # turns into the basemap's label layer (regenerate via
    # data/build_osm_places.sh). Having it means anything the map labels is
    # findable by name, which Overture alone does not guarantee — the two use
    # different vocabularies for the same real-world place.
    osm_places_path: str = str(
        Path(__file__).resolve().parents[1] / "data" / "osm" / "places.parquet"
    )

    # The region every derived artifact must cover. Read at startup to check the
    # places extracts against it; see mapdata/places_coverage.py.
    region_json_path: str = str(
        Path(__file__).resolve().parents[1] / "data" / "region.json"
    )

    # LLM conversation layer (Phase 2). Provider is a seam like map_data_source:
    # "gemini" today, "claude" when an Anthropic key is provisioned — see
    # backend/ml/llm/factory.py. Empty api key = conversation features off
    # (endpoints 503, frontend hides the UI).
    llm_provider: str = "gemini"
    # gemini-2.5-flash-lite was the first choice but Google returns 404
    # "no longer available to new users" for keys created after its sunset —
    # 3.1-flash-lite is the same tier's current generation (verified working
    # for this key; "gemini-flash-lite-latest" is the unpinned alias).
    llm_model: str = "gemini-3.1-flash-lite"
    gemini_api_key: str = ""

    # Qdrant vector store for Phase 3 per-user preference embeddings. Same
    # host-vs-container logic as valhalla_url (compose hostname "qdrant").
    qdrant_url: str = "http://localhost:6333"

    # MLflow experiment tracking for RL training (Week 21-22). Empty = local
    # ./mlruns file store (no server needed for smoke runs); set to the compose
    # service ("http://mlflow:5000") to log to the shared server.
    mlflow_url: str = ""

    @model_validator(mode="after")
    def _rewrite_compose_hostnames(self):
        """.env uses docker-compose service hostnames (valhalla, postgres),
        which only resolve inside the compose network. On the host, rewrite to
        the published localhost ports — same pattern db/session.py applies to
        DATABASE_URL."""
        if not Path("/.dockerenv").exists():
            self.valhalla_url = self.valhalla_url.replace(
                "http://valhalla:8002", "http://localhost:8002"
            )
            self.qdrant_url = self.qdrant_url.replace(
                "http://qdrant:6333", "http://localhost:6333"
            )
            self.mlflow_url = self.mlflow_url.replace(
                "http://mlflow:5000", "http://localhost:5000"
            )
        return self
    routing_region_id: str = "central-arlington"
    routing_tiles_built_at: str = ""  # populated by the Week 1-2 tile build step


settings = Settings()
