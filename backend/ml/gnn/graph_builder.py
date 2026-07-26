"""road_segments -> PyTorch Geometric graph (Week 17-18).

Nodes are road junctions, edges are the junction-to-junction segments the
ingestion pass produced (see ingest.py — splitting there is what makes the
endpoint matching here yield a connected graph). This is the graph the
RoadNetworkEncoder GNN consumes and the Week 21-22 RL environment builds its
state from, so the output shapes are a contract:

    node features: 2-dim  [lon, lat]
    edge features: 11-dim [speed_limit/130, lanes, one_way] + 8-type onehot

Deliberate deviations from the roadmap sample: async (this codebase's
sessions are AsyncSession); endpoint coordinates come back as ST_X/ST_Y
floats in SQL rather than `.x` attribute access, because asyncpg returns raw
WKB for geometry columns; the sample's docstring promised junction-type and
traffic-signal node features it never computed — the real contract is the
2/11 dims above, matching RoadNetworkEncoder's defaults.

Scaling caveat: this loads every segment inside a single ST_MakeEnvelope bbox
into one in-memory graph — fine for a local metro (Central Arlington: ~10k
segments), but it is local-trip-shaped. A long or cross-region trip (say
Texas -> California) would balloon the bbox toward the whole dataset, which is
infeasible to build and would mean-pool to mush anyway. The intended fix is
route-windowing — sliding a local subgraph along the candidate route and
encoding only where routing choices actually exist — not one giant box.
Valhalla still does the actual pathfinding; this graph only feeds preference
scoring, so it never needs the whole corridor at once.
"""
from __future__ import annotations

import torch
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from torch_geometric.data import Data

from ml.gnn.ingest import round_pt

# Onehot vocabulary per the roadmap. Types outside the list (trunk, *_link,
# living_street, track variants...) encode as all-zeros — deliberately, so the
# vector length is stable while rarer classes still carry speed/lanes signal.
HIGHWAY_ONEHOT_TYPES = [
    "motorway", "primary", "secondary", "tertiary",
    "residential", "unclassified", "service", "track",
]

NODE_FEATURE_DIM = 2   # [lon, lat]
EDGE_FEATURE_DIM = 3 + len(HIGHWAY_ONEHOT_TYPES)  # 11

_SEGMENTS_SQL = text("""
    SELECT osm_way_id, highway_type, speed_limit_kph, lanes, one_way,
           ST_X(ST_StartPoint(geom::geometry)) AS start_lon,
           ST_Y(ST_StartPoint(geom::geometry)) AS start_lat,
           ST_X(ST_EndPoint(geom::geometry))   AS end_lon,
           ST_Y(ST_EndPoint(geom::geometry))   AS end_lat
    FROM road_segments
    WHERE ST_Intersects(
        geom::geometry,
        ST_MakeEnvelope(:min_lon, :min_lat, :max_lon, :max_lat, 4326)
    )
""")


def _edge_features(highway_type: str | None, speed_kph: int | None,
                   lanes: int | None, one_way: bool) -> list[float]:
    onehot = [1.0 if h == highway_type else 0.0 for h in HIGHWAY_ONEHOT_TYPES]
    return [(speed_kph or 50) / 130.0, float(lanes or 1), float(one_way)] + onehot


async def build_road_graph_from_db(
    db: AsyncSession,
    bbox: tuple[float, float, float, float],
) -> Data:
    """Build the road graph for a bounding box.

    ``bbox`` is ``(min_lat, min_lon, max_lat, max_lon)`` — roadmap order.
    Two-way segments emit both directions (duplicated edge features); one-way
    segments emit only start->end (ingest already normalized oneway=-1 by
    reversing the geometry). Returns a valid empty graph when no segments
    intersect the box, so callers never special-case it.
    """
    min_lat, min_lon, max_lat, max_lon = bbox
    result = await db.execute(_SEGMENTS_SQL, {
        "min_lat": min_lat, "min_lon": min_lon,
        "max_lat": max_lat, "max_lon": max_lon,
    })
    segments = result.fetchall()

    if not segments:
        return Data(
            x=torch.zeros((0, NODE_FEATURE_DIM), dtype=torch.float),
            edge_index=torch.zeros((2, 0), dtype=torch.long),
            edge_attr=torch.zeros((0, EDGE_FEATURE_DIM), dtype=torch.float),
        )

    node_ids: dict[tuple[float, float], int] = {}
    edges: list[list[int]] = []
    edge_features: list[list[float]] = []

    for seg in segments:
        start = round_pt(seg.start_lon, seg.start_lat)
        end = round_pt(seg.end_lon, seg.end_lat)
        for coord in (start, end):
            if coord not in node_ids:
                node_ids[coord] = len(node_ids)

        feat = _edge_features(seg.highway_type, seg.speed_limit_kph, seg.lanes, seg.one_way)
        edges.append([node_ids[start], node_ids[end]])
        edge_features.append(feat)
        if not seg.one_way:
            edges.append([node_ids[end], node_ids[start]])
            edge_features.append(feat)

    # node_ids preserves insertion order == id order, so keys line up with ids.
    x = torch.tensor([[lon, lat] for lon, lat in node_ids], dtype=torch.float)
    edge_index = torch.tensor(edges, dtype=torch.long).t().contiguous()
    edge_attr = torch.tensor(edge_features, dtype=torch.float)
    return Data(x=x, edge_index=edge_index, edge_attr=edge_attr)
