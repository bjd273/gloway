"""PreferenceEmbedding + PreferenceStore tests — fully in-memory Qdrant,
no live container, no DB."""
import uuid

import numpy as np
import pytest

pytest.importorskip("qdrant_client")

from qdrant_client import QdrantClient  # noqa: E402

from ml.rl.preference_embedding import (  # noqa: E402
    EMBEDDING_DIM,
    PreferenceEmbedding,
    PreferenceStore,
)


@pytest.fixture
def store():
    return PreferenceStore(client=QdrantClient(location=":memory:"))


def _uid() -> str:
    return str(uuid.uuid4())


def _vec(seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.standard_normal(EMBEDDING_DIM).astype(np.float32)


def test_embedding_is_neutral_and_bounded():
    emb = PreferenceEmbedding()
    out = emb.forward()
    assert out.shape == (EMBEDDING_DIM,)
    # tanh(0) == 0 — neutral start.
    assert np.allclose(emb.as_numpy(), 0.0)
    # Push the parameter around; forward stays in [-1, 1].
    with __import__("torch").no_grad():
        emb.embedding.add_(5.0)
    assert emb.forward().abs().max().item() <= 1.0


def test_save_and_load_round_trip(store):
    # Cosine collections unit-normalize on upsert, so the round-trip preserves
    # direction, not raw magnitude — compare the normalized vectors.
    uid = _uid()
    vec = _vec(1)
    store.save_embedding(uid, vec)
    loaded = store.load_embedding(uid)
    assert loaded is not None
    assert np.allclose(loaded / np.linalg.norm(loaded), vec / np.linalg.norm(vec), atol=1e-5)


def test_load_unknown_user_returns_none(store):
    assert store.load_embedding(_uid()) is None


def test_get_or_create_returns_neutral_without_persisting(store):
    uid = _uid()
    neutral = store.get_or_create_embedding(uid)
    assert neutral.shape == (EMBEDDING_DIM,)
    assert np.allclose(neutral, 0.0)
    # Neutral must not have been written.
    assert store.load_embedding(uid) is None


def test_save_zero_vector_is_rejected(store):
    with pytest.raises(ValueError):
        store.save_embedding(_uid(), np.zeros(EMBEDDING_DIM, dtype=np.float32))


def test_payload_carries_user_id_and_metadata(store):
    uid = _uid()
    store.save_embedding(uid, _vec(2), metadata={"avoid_highways": True})
    point = store.client.retrieve("user_preferences", ids=[uid], with_payload=True)[0]
    assert point.payload["user_id"] == uid
    assert point.payload["avoid_highways"] is True


def test_find_similar_users_ranks_by_cosine_and_excludes_self(store):
    base = _vec(3)
    near = base + 0.01 * _vec(4)   # almost the same direction
    far = -base                     # opposite direction
    me, friend, stranger = _uid(), _uid(), _uid()
    store.save_embedding(me, base)
    store.save_embedding(friend, near)
    store.save_embedding(stranger, far)

    similar = store.find_similar_users(me, top_k=10)
    assert me not in similar
    assert friend in similar
    # Nearest neighbour ranks ahead of the opposite-direction user.
    assert similar.index(friend) < similar.index(stranger)


def test_find_similar_users_unknown_returns_empty(store):
    assert store.find_similar_users(_uid()) == []
