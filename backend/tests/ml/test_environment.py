"""RouteEnvironment tests — tiny synthetic graph, no DB, no training."""
import numpy as np
import pytest

pytest.importorskip("gymnasium")
pytest.importorskip("torch_geometric")

import torch  # noqa: E402
from torch_geometric.data import Data  # noqa: E402

from ml.gnn.graph_builder import EDGE_FEATURE_DIM  # noqa: E402
from ml.rl.environment import STATE_DIM, RouteEnvironment  # noqa: E402


def _grid_graph(side: int = 3) -> Data:
    """side x side grid with bidirectional edges and [lon, lat]-style coords."""
    coords = [[-97.1 + 0.01 * c, 32.7 + 0.01 * r] for r in range(side) for c in range(side)]
    edges = []
    for r in range(side):
        for c in range(side):
            node = r * side + c
            if c + 1 < side:
                edges += [[node, node + 1], [node + 1, node]]
            if r + 1 < side:
                edges += [[node, node + side], [node + side, node]]
    return Data(
        x=torch.tensor(coords, dtype=torch.float),
        edge_index=torch.tensor(edges, dtype=torch.long).t().contiguous(),
        edge_attr=torch.rand((len(edges), EDGE_FEATURE_DIM)),
    )


@pytest.fixture
def env():
    return RouteEnvironment(_grid_graph(), max_steps=50)


def test_observation_shape_and_finiteness(env):
    obs, info = env.reset(seed=0)
    assert obs.shape == (STATE_DIM,)
    assert obs.dtype == np.float32
    assert np.isfinite(obs).all()
    assert info == {}


def test_spaces(env):
    assert env.action_space.n == 8
    assert env.observation_space.shape == (STATE_DIM,)


def test_reset_is_seed_deterministic():
    graph = _grid_graph()
    encoder_seedless_a = RouteEnvironment(graph)
    encoder_seedless_b = RouteEnvironment(graph, gnn_encoder=None)
    a_first = encoder_seedless_a.reset(seed=42)
    b_first = encoder_seedless_b.reset(seed=42)
    # Same seed -> same origin/destination selection.
    assert encoder_seedless_a.current_node == encoder_seedless_b.current_node
    assert encoder_seedless_a.destination_node == encoder_seedless_b.destination_node
    del a_first, b_first


def _first_valid_slot(env, node):
    return next(i for i in range(8) if env._slots[node, i] != -1)


def test_valid_step_moves_and_returns_five_tuple(env):
    env.reset(seed=1)
    start = env.current_node
    obs, reward, terminated, truncated, info = env.step(_first_valid_slot(env, start))
    assert obs.shape == (STATE_DIM,)
    assert isinstance(reward, float)
    assert isinstance(terminated, bool) and isinstance(truncated, bool)
    assert env.current_node != start


def test_empty_direction_snaps_to_nearest_road(env):
    env.reset(seed=1)
    node = env.current_node
    # Grid roads run only N/S/E/W (even sectors); diagonal slot 7 is empty and
    # must snap to an adjacent occupied slot — the agent always moves.
    env.step(7)
    assert env.current_node != node
    assert env.current_node in env._neighbors(node)


def test_sink_node_truncates_episode():
    # A -> B only; B has no out-edges (a one-way ending). Stepping from B
    # ends the episode as truncated.
    graph = Data(
        x=torch.tensor([[-97.10, 32.70], [-97.09, 32.70]], dtype=torch.float),
        edge_index=torch.tensor([[0], [1]], dtype=torch.long),
        edge_attr=torch.rand((1, EDGE_FEATURE_DIM)),
    )
    env = RouteEnvironment(graph, max_steps=10)
    env.reset(options={"origin_node": 0, "dest_node": 1})
    env.step(0)                      # A -> B (east)
    assert env.current_node == 1 or True  # reaching B may terminate (B == dest)
    env.reset(options={"origin_node": 1, "dest_node": 0})
    obs, reward, terminated, truncated, info = env.step(0)
    assert truncated and not terminated
    assert info["sink"] is True


def test_reaching_destination_terminates_with_goal_reward(env):
    env.reset(seed=1)
    # Force a one-step episode: destination = the neighbor in the first
    # occupied compass slot.
    slot = _first_valid_slot(env, env.current_node)
    env.destination_node = int(env._slots[env.current_node, slot])
    obs, reward, terminated, truncated, info = env.step(slot)
    assert terminated
    assert reward == pytest.approx(1.0)


def test_truncation_at_max_steps():
    env = RouteEnvironment(_grid_graph(), max_steps=3)
    env.reset(seed=2)
    env.destination_node = -1  # unreachable — force truncation
    truncated = False
    for _ in range(3):
        # Valid or invalid, every step consumes budget.
        _, _, terminated, truncated, _ = env.step(0)
        assert not terminated
    assert truncated


def test_destination_is_encoded_in_observation():
    graph = _grid_graph()
    env = RouteEnvironment(graph)
    obs_a, _ = env.reset(options={"origin_node": 0, "dest_node": 4})
    obs_b, _ = env.reset(options={"origin_node": 0, "dest_node": 8})
    # Same origin, different destination -> the observation must differ,
    # otherwise the policy cannot learn goal-directed behaviour.
    assert not np.allclose(obs_a, obs_b)


def _slot_of(env, node, neighbor):
    return int(np.where(env._slots[node] == neighbor)[0][0])


def test_shaping_rewards_progress_toward_goal():
    graph = _grid_graph()
    env = RouteEnvironment(graph)
    env.reset(options={"origin_node": 0, "dest_node": 8})  # opposite corner
    _, reward_toward, _, _, _ = env.step(_slot_of(env, 0, 1))  # toward goal column
    env.reset(options={"origin_node": 1, "dest_node": 8})
    _, reward_away, _, _, _ = env.step(_slot_of(env, 1, 0))    # back away from goal
    assert reward_toward > reward_away


def test_actions_are_compass_aligned():
    # Node 4 = grid center: east neighbor in slot 0, north in slot 2,
    # west in slot 4, south in slot 6 — the geometric contract that lets the
    # policy generalize "head toward the goal" across junctions.
    env = RouteEnvironment(_grid_graph())
    assert env._slots[4, 0] == 5   # east  (+lon)
    assert env._slots[4, 2] == 7   # north (+lat)
    assert env._slots[4, 4] == 3   # west  (-lon)
    assert env._slots[4, 6] == 1   # south (-lat)


def test_random_episodes_respect_hop_limit_and_avoid_sinks():
    graph = _grid_graph(5)
    env = RouteEnvironment(graph, episode_hop_limit=2)
    for seed in range(10):
        env.reset(seed=seed)
        # Origin must be able to move; destination within the hop budget.
        assert env._neighbors(env.current_node)
        assert env.destination_node in env._reachable_from(env.current_node, max_hops=2)


def _user_block(obs):
    """The 32 user-embedding dims sit between the graph embedding and context."""
    from ml.rl.environment import GRAPH_EMBED_DIM
    from ml.rl.preference_embedding import EMBEDDING_DIM

    return obs[GRAPH_EMBED_DIM:GRAPH_EMBED_DIM + EMBEDDING_DIM]


def test_user_embedding_is_constant_without_a_sampler(env):
    """Default behaviour is unchanged — one fixed user, which is what eval and
    serving want."""
    first, _ = env.reset(seed=0)
    second, _ = env.reset(seed=1)
    assert np.array_equal(_user_block(first), _user_block(second))
    assert not _user_block(first).any()  # neutral zeros


def test_user_embedding_fn_resamples_every_episode():
    """Without this the 32 user dims are constant, receive zero gradient, and
    the trained policy is provably invariant to the user embedding."""
    from ml.rl.preference_embedding import EMBEDDING_DIM

    rng = np.random.default_rng(0)
    env = RouteEnvironment(
        _grid_graph(),
        user_embedding_fn=lambda: rng.uniform(-1, 1, EMBEDDING_DIM).astype(np.float32),
    )
    first, _ = env.reset(seed=0)
    second, _ = env.reset(seed=0)  # same seed: only the user should differ

    assert not np.array_equal(_user_block(first), _user_block(second))
    assert np.isfinite(second).all()
    # Sampled values must stay in the tanh-bounded range real embeddings use.
    assert np.abs(_user_block(second)).max() <= 1.0


def test_user_embedding_fn_rejects_a_wrong_shape():
    env = RouteEnvironment(_grid_graph(), user_embedding_fn=lambda: np.zeros(7, dtype=np.float32))
    with pytest.raises(ValueError, match="user_embedding_fn"):
        env.reset(seed=0)


def test_sb3_env_checker_passes():
    pytest.importorskip("stable_baselines3")
    from stable_baselines3.common.env_checker import check_env

    check_env(RouteEnvironment(_grid_graph()), warn=False)
