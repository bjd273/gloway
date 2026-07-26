"""Adaptive Map API entrypoint.

Run from backend/ so config.py resolves host-side defaults correctly:

    poetry run uvicorn api.main:app --reload --port 8000

Routers: routing (routes + geocoding), users (minimal email-only accounts +
preferences), trips (GPS breadcrumbs + completion), feedback (post-trip text).
Real auth (JWT) is deferred until there's something to protect.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes import conversation, feedback, routing, speech, trips, users, voice
from routing.route_ranker import RouteRanker
from routing.valhalla_client import get_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # One pooled Valhalla client for the app's lifetime.
    app.state.valhalla_router = get_router()
    # Read the trained route scorer from disk once, not per request. Absent or
    # unreadable model = deterministic fallback (Valhalla's own order), which is
    # the normal state until scripts/train_route_scorer.py has enough trips.
    app.state.route_ranker = RouteRanker.from_path()
    try:
        yield
    finally:
        await app.state.valhalla_router.aclose()


app = FastAPI(title="Adaptive Map API", version="0.1.0", lifespan=lifespan)

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
app.include_router(conversation.router, prefix="/api/v1/trips", tags=["conversation"])
app.include_router(feedback.router, prefix="/api/v1/feedback", tags=["feedback"])
app.include_router(speech.router, prefix="/api/v1/speech", tags=["speech"])
app.include_router(voice.router, prefix="/api/v1/trips", tags=["voice"])


@app.get("/health")
async def health():
    return {"status": "ok"}
