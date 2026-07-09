"""Async SQLAlchemy engine + session factory.

The engine is created lazily on first use so importing this module (e.g. from
tests that never touch the DB) doesn't require a reachable database.
"""
from __future__ import annotations

from pathlib import Path
from typing import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from config import settings

_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def _effective_database_url() -> str:
    """DATABASE_URL points at the compose service hostname `postgres`, which
    only resolves inside the Docker network. When this process runs directly
    on the host (dev: `poetry run uvicorn ...`), rewrite it to localhost —
    the compose file publishes Postgres on localhost:5432. Inside a container
    (/.dockerenv exists) the URL is left untouched.
    """
    url = settings.database_url
    if not Path("/.dockerenv").exists():
        url = url.replace("@postgres:5432", "@localhost:5432")
    return url


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        _engine = create_async_engine(_effective_database_url(), pool_pre_ping=True)
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(get_engine(), expire_on_commit=False)
    return _session_factory


async def get_db() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency: one session per request, committed on success."""
    async with get_session_factory()() as session:
        yield session
