"""Adaptive Map API entrypoint.

Run from backend/ so config.py resolves host-side defaults correctly:

    poetry run uvicorn api.main:app --reload --port 8000

Only the routing router exists so far. The roadmap's users/trips/feedback
routers (auth, GPS streaming, post-trip feedback) land with the rest of
Week 5-6 / Phase 2 work.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes import routing
from routing.valhalla_client import get_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # One pooled Valhalla client for the app's lifetime.
    app.state.valhalla_router = get_router()
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


@app.get("/health")
async def health():
    return {"status": "ok"}
