"""Train the base route policy on the region's road graph.

Usage (from repo root or backend/):
    poetry --directory backend run python scripts/train_rl.py --timesteps 20000

Needs Postgres up (road_segments populated via scripts/ingest_road_segments.py)
and the gnn + rl poetry groups installed. Artifacts land in backend/models/
(gitignored); MLflow logs to backend/mlruns/ unless settings.mlflow_url is set.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Central Arlington, matching data/download_osm.sh — (min_lat, min_lon, max_lat, max_lon).
REGION_BBOX = (32.715, -97.140, 32.760, -97.080)


async def _build_graph():
    from db.session import get_session_factory
    from ml.gnn.graph_builder import build_road_graph_from_db

    async with get_session_factory()() as session:
        return await build_road_graph_from_db(session, REGION_BBOX)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timesteps", type=int, default=20_000)
    parser.add_argument("--n-envs", type=int, default=4)
    parser.add_argument("--model-dir", type=Path, default=None)
    args = parser.parse_args()

    from ml.rl.train import _DEFAULT_MODEL_DIR, train_base_model

    graph = asyncio.run(_build_graph())
    if graph.num_nodes == 0:
        raise SystemExit("road graph is empty — run scripts/ingest_road_segments.py first")
    print(f"graph: {graph.num_nodes} nodes / {graph.edge_index.shape[1]} edges")

    model = train_base_model(
        graph,
        total_timesteps=args.timesteps,
        n_envs=args.n_envs,
        model_dir=args.model_dir or _DEFAULT_MODEL_DIR,
    )
    rewards = [ep["r"] for ep in model.ep_info_buffer]
    if rewards:
        print(f"tail mean episode reward: {sum(rewards) / len(rewards):.3f}")
    print("saved: base_route_policy.zip")


if __name__ == "__main__":
    main()
