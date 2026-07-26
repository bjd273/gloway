"""Shared test fixtures.

pytest-asyncio (mode=auto) runs each test in its own event loop, but
db.session caches one global async engine whose pooled connections stay bound
to the loop that created them — a second DB-touching test would inherit
connections from a closed loop and die with "Event loop is closed". Dispose
the engine after every test so each one builds a fresh pool on its own loop.
"""
import pytest

import db.session as db_session


@pytest.fixture(autouse=True)
async def _fresh_db_engine():
    yield
    if db_session._engine is not None:
        await db_session._engine.dispose()
        db_session._engine = None
        db_session._session_factory = None
