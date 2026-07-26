"""RouteEnvironment — Gymnasium env for route-policy RL (Week 21-22).

An agent walks the road graph one junction at a time (pick one of up to 8
neighbors) trying to reach a destination node. This is the *base* navigation
task the roadmap calls "synthetic routing on random O-D pairs" — no user trips,
no Valhalla, no live reward yet; it exists to train a policy end-to-end and
prove the GNN + preference embedding + PPO all wire together.

Deliberate deviations from the roadmap sample (which is a non-runnable scaffold):

- **Position-aware observation.** The sample's state is `[whole-graph GNN
  embedding | user vector | progress]` — it contains no current-position or
  destination signal, so PPO literally cannot learn to navigate. We keep the
  128+32+8 = 168 layout but fill the 8 context dims with real position/goal
  features (current coord, destination coord, delta, distance), making the MDP
  learnable while preserving the state-size contract.
- **Constructor.** Dropped the sample's unused `preference_store`/`db` args (the
  env trains purely on the in-memory graph) — that also fixes the training
  script's 2-vs-4 arg mismatch. The GNN encoder is injectable so vec-envs can
  share one instead of each spawning a random encoder.
- **Performance.** Adjacency and the (episode-constant) graph embedding are
  precomputed once, not recomputed every step as the sample did.
- **Reward shaping.** Potential-based shaping on distance-to-goal makes the
  sparse +1 terminal reward reachable; being potential-based it provably does
  not change the optimal policy.
- **Compass-sector actions with snapping.** The sample's action i = "i-th
  neighbor by id", whose direction is arbitrary per junction — a policy would
  have to memorize every junction's layout to navigate. Here each neighbor
  occupies the action slot matching its compass bearing (8 x 45-degree
  sectors, slot 0 = east, counter-clockwise), and an action aimed at an empty
  sector snaps to the nearest occupied one. So every action means "head
  roughly that way along whatever road exists" — no invalid actions to learn
  around (the observation can't express per-junction validity, and empirically
  the -0.1 invalid penalty swamped the navigation gradient: the policy stayed
  near-uniform for 80k steps). Stepping from a sink node (one-way ending, no
  out-edges) ends the episode as truncated.
- **Solvable episodes with a curriculum radius.** Random origins are never
  sink nodes (one-way endings with no out-edges — real road graphs have them),
  and random destinations are drawn from the origin's BFS-reachable set within
  `episode_hop_limit` hops. Diagnostics on the Arlington graph showed uniform
  random O-D pairs average ~19 hops and even a hand-coded greedy-compass
  oracle solves only ~half of them — PPO gets no early successes to bootstrap
  from. A hop-limited curriculum makes smoke-scale training actually converge;
  raise or drop the limit as training scales up. Explicit origin/dest passed
  via reset(options=...) are never restricted.

**Live user-embedding dims (fixed).** `user_embedding` used to default to
zeros and never change during base training. A constant-zero input contributes
nothing and receives no gradient (dL/dW[:,i] is proportional to x_i = 0), so
those 32 weights stayed at random init forever and the trained policy was
provably invariant to the user embedding — while `fine_tune_for_user` then fed
a *nonzero* embedding straight into those never-trained weights, injecting noise
into an otherwise working navigation policy instead of personalizing it. Pass
`user_embedding_fn` to resample a user per episode (see `train.py`) so the dims
carry real signal. It stays optional: eval and serving want one fixed user.

**Constant graph-embedding dims (still deferred).** The other 128 dims have the
same problem for a different reason: `RoadNetworkEncoder` is randomly
initialized, never trained, and encodes one fixed graph, so the block is a
single constant vector acting as a bias. Fixing it needs a *trained* encoder —
a self-supervised objective, or RL gradients flowing through it across
multi-graph episodes — which is a larger effort than this pass and is blocked
on the same missing trip volume as the replay path. Until then, treat the
navigation policy as conditioned on `[user_emb | context]` only.

Neither issue affects production routing: route ranking is served by the
supervised `ml/rl/route_scorer.py`, not by this policy. See `ml/rl/state.py`.

The real reward pipeline (turning logged `trips.reward_value` into episodes)
is intentionally NOT here — see `inject_trip_reward`; it belongs to Week 23-24
(reward fusion) once trip volume exists.
"""
from __future__ import annotations

from collections import deque
from typing import Callable

import gymnasium as gym
import numpy as np
import torch
from torch_geometric.data import Data

from ml.gnn.model import RoadNetworkEncoder
from ml.rl.preference_embedding import EMBEDDING_DIM

GRAPH_EMBED_DIM = 128
CONTEXT_DIM = 8
STATE_DIM = GRAPH_EMBED_DIM + EMBEDDING_DIM + CONTEXT_DIM  # 168
MAX_NEIGHBORS = 8

# Reward constants (roadmap's, plus the shaping term).
_REWARD_GOAL = 1.0
_REWARD_STEP = -0.01
_REWARD_REVISIT = -0.05
# Weight on (prev_dist - new_dist), distances in normalized units. Sized so a
# typical one-segment step toward the goal (~0.01-0.05 normalized) clearly
# outweighs the -0.01 step cost — at 0.1 the shaping was drowned out and PPO
# learned penalty-avoidance without goal-seeking (verified empirically).
# Potential-based shaping is optimal-policy-preserving at any scale.
_SHAPING_SCALE = 2.0


class RouteEnvironment(gym.Env):
    metadata = {"render_modes": []}

    def __init__(
        self,
        graph_data: Data,
        user_embedding: np.ndarray | None = None,
        gnn_encoder: RoadNetworkEncoder | None = None,
        max_steps: int = 200,
        episode_hop_limit: int = 12,
        user_embedding_fn: Callable[[], np.ndarray] | None = None,
    ):
        super().__init__()
        if graph_data.num_nodes == 0:
            raise ValueError("RouteEnvironment needs a non-empty graph")
        self.graph_data = graph_data
        self.max_steps = max_steps
        self.episode_hop_limit = episode_hop_limit
        # Resamples the user embedding every reset() when provided — see the
        # "Live user-embedding dims" note in the module docstring. Default None
        # keeps the fixed-embedding behaviour (what serving/eval wants).
        self.user_embedding_fn = user_embedding_fn
        self.user_embedding = (
            np.zeros(EMBEDDING_DIM, dtype=np.float32)
            if user_embedding is None
            else np.asarray(user_embedding, dtype=np.float32)
        )
        if self.user_embedding.shape != (EMBEDDING_DIM,):
            raise ValueError(f"user_embedding must be shape ({EMBEDDING_DIM},)")

        self.action_space = gym.spaces.Discrete(MAX_NEIGHBORS)
        self.observation_space = gym.spaces.Box(
            low=-np.inf, high=np.inf, shape=(STATE_DIM,), dtype=np.float32
        )

        # --- precompute (all episode-invariant) ---
        self._coords = graph_data.x.detach().cpu().numpy().astype(np.float32)  # (N, 2) [lon, lat]
        self._slots = self._build_action_slots(graph_data, self._coords)

        # Center/scale coords so context features sit ~[-1, 1] regardless of region.
        self._centroid = self._coords.mean(axis=0)
        span = (self._coords.max(axis=0) - self._coords.min(axis=0))
        self._scale = np.where(span > 0, span, 1.0)

        # The graph embedding is constant across an episode — encode once.
        encoder = gnn_encoder or RoadNetworkEncoder()
        encoder.eval()
        with torch.no_grad():
            self._graph_emb = encoder(graph_data).cpu().numpy().flatten().astype(np.float32)

        self.current_node = 0
        self.destination_node = 0
        self.visited_nodes: set[int] = set()
        self.step_count = 0

    @staticmethod
    def _build_action_slots(graph_data: Data, coords: np.ndarray) -> np.ndarray:
        """(N, 8) array: slot s of node n = neighbor reached by heading into
        compass sector s (slot 0 = east, counter-clockwise 45-degree sectors),
        or -1 when no road leaves in that direction. Sector collisions spill to
        the nearest free slot so up to 8 neighbors always fit."""
        adjacency: list[set[int]] = [set() for _ in range(graph_data.num_nodes)]
        src, dst = graph_data.edge_index.tolist()
        for s, d in zip(src, dst):
            adjacency[s].add(d)

        slots = np.full((graph_data.num_nodes, MAX_NEIGHBORS), -1, dtype=np.int64)
        for node, neighbors in enumerate(adjacency):
            for nb in sorted(neighbors)[:MAX_NEIGHBORS]:
                delta = coords[nb] - coords[node]
                bearing = np.arctan2(delta[1], delta[0])  # [-pi, pi], 0 = east
                sector = int(np.round(bearing / (np.pi / 4))) % MAX_NEIGHBORS
                # Nearest free slot: exact sector first, then +-1, +-2, ...
                for offset in (0, 1, -1, 2, -2, 3, -3, 4):
                    slot = (sector + offset) % MAX_NEIGHBORS
                    if slots[node, slot] == -1:
                        slots[node, slot] = nb
                        break
        return slots

    def _neighbors(self, node: int) -> list[int]:
        """Distinct neighbor ids of a node (order not action-meaningful)."""
        return [int(n) for n in self._slots[node] if n != -1]

    def _reachable_from(self, origin: int, max_hops: int | None = None) -> list[int]:
        """Nodes reachable from origin, optionally within a BFS hop budget."""
        depth = {origin: 0}
        queue = deque([origin])
        while queue:
            node = queue.popleft()
            if max_hops is not None and depth[node] >= max_hops:
                continue
            for nb in self._neighbors(node):
                if nb not in depth:
                    depth[nb] = depth[node] + 1
                    queue.append(nb)
        del depth[origin]
        return list(depth)

    def _distance(self, a: int, b: int) -> float:
        """Normalized euclidean distance between two nodes (scaled coords)."""
        delta = (self._coords[a] - self._coords[b]) / self._scale
        return float(np.linalg.norm(delta))

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        options = options or {}
        origin = options.get("origin_node")
        dest = options.get("dest_node")

        # Draw a fresh user for this episode when a sampler is configured, so
        # the 32 user-embedding dims actually vary across training.
        if self.user_embedding_fn is not None:
            sampled = np.asarray(self.user_embedding_fn(), dtype=np.float32)
            if sampled.shape != (EMBEDDING_DIM,):
                raise ValueError(
                    f"user_embedding_fn must return shape ({EMBEDDING_DIM},), got {sampled.shape}"
                )
            self.user_embedding = sampled

        if origin is None:
            # Never start on a sink node (no out-edges) — the episode would be
            # unwinnable by construction.
            for _ in range(64):
                origin = int(self.np_random.integers(self.graph_data.num_nodes))
                if self._neighbors(origin):
                    break
        if dest is None:
            reachable = self._reachable_from(origin, max_hops=self.episode_hop_limit)
            # Isolated node (rare) — fall back to any other node.
            dest = (
                int(self.np_random.choice(reachable))
                if reachable
                else (origin + 1) % self.graph_data.num_nodes
            )

        self.current_node = origin
        self.destination_node = dest
        self.visited_nodes = {origin}
        self.step_count = 0
        return self._observation(), {}

    def step(self, action: int):
        next_node = int(self._slots[self.current_node, action])
        if next_node == -1:
            # No road in that exact direction — snap to the nearest occupied
            # compass slot so every action means "head roughly that way".
            for offset in (1, -1, 2, -2, 3, -3, 4):
                candidate = int(self._slots[self.current_node, (action + offset) % MAX_NEIGHBORS])
                if candidate != -1:
                    next_node = candidate
                    break

        if next_node == -1:
            # Sink node (in-edges only) — nowhere to go, the episode is dead.
            self.step_count += 1
            return self._observation(), _REWARD_STEP, False, True, {"sink": True}

        prev_dist = self._distance(self.current_node, self.destination_node)

        if next_node in self.visited_nodes:
            reward = _REWARD_REVISIT
        else:
            self.visited_nodes.add(next_node)
            reward = _REWARD_STEP

        # Potential-based shaping toward the goal (optimal-policy-preserving).
        new_dist = self._distance(next_node, self.destination_node)
        reward += (prev_dist - new_dist) * _SHAPING_SCALE

        self.current_node = next_node
        self.step_count += 1

        terminated = next_node == self.destination_node
        truncated = self.step_count >= self.max_steps
        if terminated:
            reward = _REWARD_GOAL

        return self._observation(), reward, terminated, truncated, {}

    def inject_trip_reward(self, reward: float) -> None:
        """Seam for feeding a real completed trip's measured reward into
        training. Week 23-24's reward fusion now exists — every completed trip
        carries a real `trips.reward_value` (services.signal_processor +
        ml.rl.reward_engine). What remains is the offline-RL replay itself:
        a buffer that maps a logged trip (origin/dest, route, reward) to an
        episode PPO can learn from. That is a separate effort — the base
        policy still trains on synthetic O-D pairs only."""
        raise NotImplementedError(
            "Trip rewards are now computed (Week 23-24); the offline replay buffer -> PPO "
            "path is still unbuilt."
        )

    def _observation(self) -> np.ndarray:
        cur = (self._coords[self.current_node] - self._centroid) / self._scale
        dest = (self._coords[self.destination_node] - self._centroid) / self._scale
        delta = dest - cur
        dist = float(np.linalg.norm(delta))
        context = np.array(
            [self.step_count / self.max_steps, cur[0], cur[1], dest[0], dest[1],
             delta[0], delta[1], dist],
            dtype=np.float32,
        )
        return np.concatenate([self._graph_emb, self.user_embedding, context]).astype(np.float32)
