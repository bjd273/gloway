"""RoadNetworkEncoder contract tests — synthetic graphs only, no DB."""
import pytest

pytest.importorskip("torch_geometric")

import torch  # noqa: E402
from torch_geometric.data import Batch, Data  # noqa: E402

from ml.gnn.graph_builder import EDGE_FEATURE_DIM, NODE_FEATURE_DIM  # noqa: E402
from ml.gnn.model import RoadNetworkEncoder  # noqa: E402


def _graph(num_nodes: int = 4, shift: float = 0.0) -> Data:
    """Small connected graph with graph_builder-shaped features."""
    torch.manual_seed(0)
    x = torch.rand((num_nodes, NODE_FEATURE_DIM)) + shift
    src = torch.arange(num_nodes)
    dst = torch.roll(src, -1)  # ring
    edge_index = torch.stack([torch.cat([src, dst]), torch.cat([dst, src])])
    edge_attr = torch.rand((edge_index.shape[1], EDGE_FEATURE_DIM))
    return Data(x=x, edge_index=edge_index, edge_attr=edge_attr)


def _empty() -> Data:
    return Data(
        x=torch.zeros((0, NODE_FEATURE_DIM)),
        edge_index=torch.zeros((2, 0), dtype=torch.long),
        edge_attr=torch.zeros((0, EDGE_FEATURE_DIM)),
    )


def test_forward_produces_128_dim_vector():
    encoder = RoadNetworkEncoder()
    out = encoder(_graph())
    assert out.shape == (1, 128)
    assert torch.isfinite(out).all()


def test_batched_graphs_produce_one_vector_each():
    encoder = RoadNetworkEncoder()
    batch = Batch.from_data_list([_graph(4), _graph(6)])
    out = encoder(batch)
    assert out.shape == (2, 128)
    assert torch.isfinite(out).all()


def test_empty_graph_encodes_to_zero_vector():
    encoder = RoadNetworkEncoder()
    out = encoder(_empty())
    assert out.shape == (1, 128)
    assert torch.count_nonzero(out) == 0


def test_translation_invariance():
    encoder = RoadNetworkEncoder().eval()  # dropout off for determinism
    base = _graph(shift=0.0)
    shifted = _graph(shift=1.0)  # same seed → same graph, coordinates shifted
    with torch.no_grad():
        assert torch.allclose(encoder(base), encoder(shifted), atol=1e-5)


def test_gradients_flow():
    encoder = RoadNetworkEncoder()
    encoder(_graph()).sum().backward()
    assert encoder.node_encoder.weight.grad is not None
    assert torch.isfinite(encoder.node_encoder.weight.grad).all()


def test_custom_dims():
    encoder = RoadNetworkEncoder(hidden_dim=32, output_dim=64, num_heads=2)
    assert encoder(_graph()).shape == (1, 64)


def test_indivisible_heads_rejected():
    with pytest.raises(ValueError):
        RoadNetworkEncoder(hidden_dim=64, num_heads=3)
