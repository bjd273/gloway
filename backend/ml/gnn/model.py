"""RoadNetworkEncoder — GATv2 encoder over the road graph (Week 17-18).

Encodes a road-network subgraph (from graph_builder.build_road_graph_from_db)
into a fixed-size vector: the map half of the RL state. Graph attention
(GATv2) learns which neighboring segments matter for each junction; mean
pooling collapses node embeddings into one graph-level vector; a projection
sizes it to the 128 dims the Week 21-22 environment concatenates with the
user-preference and context features.

Deliberate deviations from the roadmap sample:
- Empty-graph guard: graph_builder intentionally returns valid empty graphs
  for out-of-data bboxes; mean-pooling zero nodes is NaN, so those encode to
  a zero vector instead.
- Per-graph coordinate centering: raw node features are [lon, lat] (~-97,
  ~32 here) — near-constant large values that would swamp the node encoder.
  Subtracting the per-graph mean makes the encoding translation-invariant
  (a neighborhood's structure, not its absolute position on Earth) without
  changing the interface.
- Batch support: accepts a bare Data (batch=None) or a Batch from
  Batch.from_data_list, so the same module serves single-graph inference and
  batched RL training.
"""
from __future__ import annotations

import torch
import torch.nn as nn
from torch_geometric.data import Data
from torch_geometric.nn import GATv2Conv, global_mean_pool

from ml.gnn.graph_builder import EDGE_FEATURE_DIM, NODE_FEATURE_DIM


class RoadNetworkEncoder(nn.Module):
    def __init__(
        self,
        node_features: int = NODE_FEATURE_DIM,   # [lon, lat]
        edge_features: int = EDGE_FEATURE_DIM,   # speed, lanes, one_way + highway onehot
        hidden_dim: int = 64,
        output_dim: int = 128,                   # the state vector the RL agent receives
        num_heads: int = 4,
        num_layers: int = 3,
    ):
        super().__init__()
        if hidden_dim % num_heads != 0:
            raise ValueError(f"hidden_dim ({hidden_dim}) must divide by num_heads ({num_heads})")
        self.output_dim = output_dim

        self.node_encoder = nn.Linear(node_features, hidden_dim)
        self.edge_encoder = nn.Linear(edge_features, hidden_dim)

        self.conv_layers = nn.ModuleList([
            GATv2Conv(
                hidden_dim,
                hidden_dim // num_heads,
                heads=num_heads,
                edge_dim=hidden_dim,
                concat=True,  # heads concatenate back to hidden_dim, enabling the residual
            )
            for _ in range(num_layers)
        ])
        self.layer_norms = nn.ModuleList([nn.LayerNorm(hidden_dim) for _ in range(num_layers)])
        self.output_proj = nn.Linear(hidden_dim, output_dim)
        self.dropout = nn.Dropout(0.1)

    def forward(self, data: Data) -> torch.Tensor:
        """-> (num_graphs, output_dim); (1, output_dim) for a bare Data."""
        batch = getattr(data, "batch", None)

        if data.num_nodes == 0:
            num_graphs = getattr(data, "num_graphs", 1)
            return torch.zeros((num_graphs, self.output_dim), device=data.x.device)

        # Center coordinates per graph (see module docstring).
        if batch is None:
            x = data.x - data.x.mean(dim=0, keepdim=True)
        else:
            x = data.x - global_mean_pool(data.x, batch)[batch]

        x = self.node_encoder(x)
        edge_attr = self.edge_encoder(data.edge_attr)

        for conv, norm in zip(self.conv_layers, self.layer_norms):
            x_new = conv(x, data.edge_index, edge_attr)
            x = norm(x + x_new)  # residual connection
            x = torch.relu(x)
            x = self.dropout(x)

        graph_embedding = global_mean_pool(x, batch)
        return self.output_proj(graph_embedding)
