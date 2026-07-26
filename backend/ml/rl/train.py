"""PPO training for the base route policy (Week 21-22).

Phase 1 of learning per the roadmap: "supervised-style RL on random
origin-destination pairs" over the road graph — the policy learns to navigate
toward targets; no user preferences (neutral embedding) and no real trip
rewards yet. MLflow tracks runs (local ./mlruns file store by default, or the
compose mlflow server when settings.mlflow_url is set).

Deviations from the roadmap sample, which was not runnable as written: missing
imports fixed; env constructor matches (the sample passed 2 args to a 4-arg
ctor); one GNN encoder is shared across vec envs (the sample let each env
spawn its own randomly-initialized encoder, so their observations wouldn't
even agree); artifact paths are parameters instead of CWD-relative literals.
`fine_tune_for_user` continues training with a user's embedding in the state —
consuming their real logged trip rewards is deferred to Week 23-24 (reward
fusion + replay), and this docstring says so rather than pretending.
"""
from __future__ import annotations

from pathlib import Path

import mlflow
import numpy as np
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import CheckpointCallback
from stable_baselines3.common.env_util import make_vec_env
from torch_geometric.data import Data

from ml.gnn.model import RoadNetworkEncoder
from ml.rl.environment import RouteEnvironment
from ml.rl.preference_embedding import EMBEDDING_DIM

_DEFAULT_MODEL_DIR = Path(__file__).resolve().parents[2] / "models"


def _sample_user_embedding(rng: np.random.Generator) -> np.ndarray:
    """A random user for one episode.

    Uniform on [-1, 1]^d matches the range `PreferenceEmbedding` can produce
    (its forward() is tanh-bounded), so the policy trains over the same space
    the real per-user vectors live in. Without this the embedding block is
    constant and its weights never leave initialization — see the environment's
    module docstring.
    """
    return rng.uniform(-1.0, 1.0, size=EMBEDDING_DIM).astype(np.float32)


def _setup_mlflow() -> None:
    from config import settings

    if settings.mlflow_url:
        mlflow.set_tracking_uri(settings.mlflow_url)
    else:
        # Local sqlite store — no server required (mlflow 3.x deprecated the
        # plain-directory file store).
        mlflow.set_tracking_uri(f"sqlite:///{_DEFAULT_MODEL_DIR.parent / 'mlruns.db'}")
    mlflow.set_experiment("route_policy")


def train_base_model(
    graph_data: Data,
    total_timesteps: int = 1_000_000,
    run_name: str = "base_route_policy_v1",
    model_dir: Path | str = _DEFAULT_MODEL_DIR,
    gnn_encoder: RoadNetworkEncoder | None = None,
    n_envs: int = 4,
    max_steps: int = 200,
    randomize_users: bool = True,
) -> PPO:
    """Train the base route policy on synthetic routing tasks.

    With ``randomize_users`` (the default) each episode draws a fresh preference
    vector, so the policy is trained *conditioned on* the user embedding rather
    than ignoring it. This is what makes `fine_tune_for_user` meaningful: the
    weights on those dims have actually been trained, so handing them a real
    user's vector steers the policy instead of injecting noise through
    never-updated random weights. Pass False only to reproduce the old
    zero-embedding behaviour.
    """
    model_dir = Path(model_dir)
    model_dir.mkdir(parents=True, exist_ok=True)

    # One shared, frozen encoder: every env must observe the same graph
    # embedding, and encoding once per env (not per env per step) is free.
    encoder = gnn_encoder or RoadNetworkEncoder()

    # One shared stream across envs. make_vec_env defaults to DummyVecEnv, which
    # runs every env in this process, so a single Generator hands out different
    # users to each. (A SubprocVecEnv would fork this state and need per-worker
    # seeding instead.)
    rng = np.random.default_rng(0)
    sampler = (lambda: _sample_user_embedding(rng)) if randomize_users else None

    def _make_env() -> RouteEnvironment:
        return RouteEnvironment(
            graph_data,
            gnn_encoder=encoder,
            max_steps=max_steps,
            user_embedding_fn=sampler,
        )

    _setup_mlflow()
    with mlflow.start_run(run_name=run_name):
        env = make_vec_env(_make_env, n_envs=n_envs)

        model = PPO(
            "MlpPolicy",
            env,
            learning_rate=3e-4,
            n_steps=2048,
            batch_size=64,
            n_epochs=10,
            gamma=0.99,
            gae_lambda=0.95,
            ent_coef=0.01,  # entropy encourages exploration
            verbose=1,
        )

        callbacks = [
            CheckpointCallback(save_freq=10_000, save_path=str(model_dir / "checkpoints")),
        ]

        mlflow.log_params({
            "algorithm": "PPO",
            "total_timesteps": total_timesteps,
            "learning_rate": 3e-4,
            "n_envs": n_envs,
            "graph_nodes": graph_data.num_nodes,
            "graph_edges": graph_data.edge_index.shape[1],
            # Runs before/after this fix are not comparable — a policy trained
            # with constant-zero users ignores the embedding entirely.
            "randomize_users": randomize_users,
        })

        model.learn(total_timesteps=total_timesteps, callback=callbacks)

        save_path = model_dir / "base_route_policy"
        model.save(str(save_path))
        mlflow.log_artifact(f"{save_path}.zip")

        # The learning-curve summary: mean episode reward over the run's tail.
        rewards = [ep["r"] for ep in model.ep_info_buffer]
        if rewards:
            mlflow.log_metric("final_ep_rew_mean", float(np.mean(rewards)))

    return model


def fine_tune_for_user(
    base_model_path: str | Path,
    user_embedding: np.ndarray,
    graph_data: Data,
    user_id: str,
    timesteps: int = 50_000,
    model_dir: Path | str = _DEFAULT_MODEL_DIR,
    gnn_encoder: RoadNetworkEncoder | None = None,
) -> PPO:
    """Continue training the base policy with a specific user's preference
    embedding in the observation.

    Only meaningful against a base model trained with ``randomize_users=True``.
    Before that fix the embedding dims were constant zero throughout base
    training, so their weights sat at random init and passing a real user vector
    here perturbed a working policy with noise rather than personalizing it. A
    base policy trained over sampled users has genuinely fit those weights, so
    conditioning on one user now steers it.

    NOTE: this still does NOT consume the user's logged trip rewards
    (trips.reward_value) — that requires an offline-replay path (see
    RouteEnvironment.inject_trip_reward). Until then fine-tuning only conditions
    the policy on the user's embedding.
    """
    encoder = gnn_encoder or RoadNetworkEncoder()
    env = make_vec_env(
        lambda: RouteEnvironment(graph_data, user_embedding=user_embedding, gnn_encoder=encoder),
        n_envs=1,
    )
    model = PPO.load(str(base_model_path), env=env)
    model.learn(total_timesteps=timesteps, reset_num_timesteps=False)

    save_path = Path(model_dir) / "users" / user_id / "route_policy"
    save_path.parent.mkdir(parents=True, exist_ok=True)
    model.save(str(save_path))
    return model
