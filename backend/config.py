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


settings = Settings()
