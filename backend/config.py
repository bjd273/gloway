"""Application settings, loaded from environment / .env.

Kept intentionally small for Phase 1 — grows as backend services come online.
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # In docker-compose this is http://valhalla:8002 (the service hostname);
    # for local host-side dev the compose port is published to localhost:8002,
    # which is the sensible default when no env var is present.
    valhalla_url: str = "http://localhost:8002"

    # Same host-vs-container logic as valhalla_url.
    database_url: str = "postgresql+asyncpg://postgres:adaptivemap@localhost:5432/adaptivemap"

    # Which MapDataSource the factory constructs: "osm" | "overture" | "hybrid".
    # See backend/mapdata/factory.py.
    map_data_source: str = "osm"
    routing_region_id: str = "central-arlington"
    routing_tiles_built_at: str = ""  # populated by the Week 1-2 tile build step


settings = Settings()
