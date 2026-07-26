"""Smoke test for the PPO training pipeline — tiny graph, few steps, tmp dirs."""
import numpy as np
import pytest

pytest.importorskip("stable_baselines3")
pytest.importorskip("torch_geometric")

from stable_baselines3 import PPO  # noqa: E402

from tests.ml.test_environment import _grid_graph  # noqa: E402


@pytest.fixture(autouse=True)
def _local_mlflow(tmp_path, monkeypatch):
    # Keep test runs out of backend/mlruns.db and any configured server:
    # _setup_mlflow honors settings.mlflow_url, and a sqlite URI is valid.
    from config import settings

    monkeypatch.setattr(settings, "mlflow_url", f"sqlite:///{tmp_path}/mlruns.db")
    yield


def test_train_and_reload_round_trip(tmp_path):
    from ml.rl.train import train_base_model

    graph = _grid_graph()
    model = train_base_model(
        graph,
        total_timesteps=512,
        n_envs=1,
        model_dir=tmp_path,
        run_name="pytest-smoke",
        max_steps=30,
    )
    assert model is not None

    zip_path = tmp_path / "base_route_policy.zip"
    assert zip_path.exists()

    loaded = PPO.load(str(zip_path))
    obs = np.zeros(loaded.observation_space.shape, dtype=np.float32)
    action, _state = loaded.predict(obs, deterministic=True)
    assert 0 <= int(action) < 8
