"""Per-user preference embedding + its Qdrant store (Week 19-20).

The embedding is a small (32-dim) *latent steering vector*, not a feature
encoding of the user's stated preferences. It initializes neutral (zeros) and
is shaped entirely by the RL loop (Week 21-22) from trip rewards — so the 32
dimensions have no hand-assigned meaning; RL decides what they encode. The
Week 21-22 environment concatenates it with the road-graph embedding (128)
and context features (8) into a 168-dim state. This module is the storage and
the learnable parameter; nothing trains or reads it yet.

Two deliberate deviations from the roadmap sample:
- Injected client for testability: the sample's PreferenceStore(qdrant_url)
  can only build a networked client, but qdrant-client's in-memory mode
  (location=":memory:") is mutually exclusive with url=. So __init__ accepts
  an optional pre-built client, letting tests run fully in-memory with no
  container.
- Zero-vector guard: the sample inits to zeros AND uses cosine distance, but a
  zero-norm vector has undefined cosine similarity. So untrained (all-zero)
  vectors are never persisted; a user with no learned preference simply has no
  Qdrant point, and callers treat "missing" as neutral (get_or_create_embedding
  returns neutral zeros without writing them).

Note on cosine storage: a cosine collection unit-normalizes vectors on upsert,
so load_embedding returns the stored *direction*, not the raw magnitude. That
is what cosine similarity (and find_similar_users) cares about; if Week 21-22
RL ever needs to recover exact magnitude, stash the norm in the point payload.
"""
from __future__ import annotations

import numpy as np
import torch
import torch.nn as nn
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams

EMBEDDING_DIM = 32  # small — one per user, updated often by RL
_COLLECTION = "user_preferences"


class PreferenceEmbedding(nn.Module):
    """A user's learnable preference vector, bounded to [-1, 1]."""

    def __init__(self, embedding_dim: int = EMBEDDING_DIM):
        super().__init__()
        # Neutral start — no strong preferences until RL moves it.
        self.embedding = nn.Parameter(torch.zeros(embedding_dim))

    def forward(self) -> torch.Tensor:
        return torch.tanh(self.embedding)

    def as_numpy(self) -> np.ndarray:
        return self.forward().detach().cpu().numpy()


class PreferenceStore:
    """Qdrant-backed storage for per-user preference vectors."""

    def __init__(self, url: str | None = None, *, client: QdrantClient | None = None):
        if client is None:
            if url is None:
                raise ValueError("PreferenceStore needs either a url or a client")
            client = QdrantClient(url=url)
        self.client = client
        self._ensure_collection()

    def _ensure_collection(self) -> None:
        existing = [c.name for c in self.client.get_collections().collections]
        if _COLLECTION not in existing:
            self.client.create_collection(
                _COLLECTION,
                vectors_config=VectorParams(size=EMBEDDING_DIM, distance=Distance.COSINE),
            )

    def save_embedding(
        self, user_id: str, embedding: np.ndarray, metadata: dict | None = None
    ) -> None:
        # A zero-norm vector has no direction, so cosine distance is undefined —
        # Qdrant would reject or mis-score it. Untrained users just stay absent.
        if not np.any(embedding):
            raise ValueError("refusing to persist an all-zero (neutral) embedding")
        payload = {**(metadata or {}), "user_id": user_id}
        self.client.upsert(
            collection_name=_COLLECTION,
            points=[PointStruct(id=user_id, vector=embedding.tolist(), payload=payload)],
        )

    def load_embedding(self, user_id: str) -> np.ndarray | None:
        results = self.client.retrieve(_COLLECTION, ids=[user_id], with_vectors=True)
        if not results:
            return None
        return np.array(results[0].vector)

    def get_or_create_embedding(self, user_id: str) -> np.ndarray:
        """Persisted vector if trained, else an in-memory neutral vector.
        Neutral vectors are NOT written (see the zero-vector deviation)."""
        existing = self.load_embedding(user_id)
        if existing is not None:
            return existing
        return np.zeros(EMBEDDING_DIM, dtype=np.float32)

    def find_similar_users(self, user_id: str, top_k: int = 10) -> list[str]:
        """Cold-start bootstrapping: users with the nearest preference vectors."""
        embedding = self.load_embedding(user_id)
        if embedding is None:
            return []
        response = self.client.query_points(
            _COLLECTION,
            query=embedding.tolist(),
            limit=top_k + 1,  # +1 since the user themselves ranks first
        )
        return [p.payload["user_id"] for p in response.points if p.payload["user_id"] != user_id]


def get_preference_store() -> PreferenceStore:
    """Construct the store from settings (mirrors get_llm_client /
    get_map_data_source). Imported lazily by consumers so environments without
    qdrant-client aren't affected."""
    from config import settings

    return PreferenceStore(url=settings.qdrant_url)
