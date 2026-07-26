"""DB-backed contract tests for build_road_graph_from_db.

Synthetic road_segments rows use negative osm_way_id in a bbox near (0, 0) —
far from the real Arlington data — so these tests never collide with an
ingested dataset and clean up only their own rows.
"""
import socket

import pytest

pytest.importorskip("torch_geometric")  # suite stays green without the gnn group

import torch  # noqa: E402
from sqlalchemy import text  # noqa: E402

from ml.gnn.graph_builder import (  # noqa: E402
    EDGE_FEATURE_DIM,
    HIGHWAY_ONEHOT_TYPES,
    NODE_FEATURE_DIM,
    build_road_graph_from_db,
)


def _reachable(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


requires_db = pytest.mark.skipif(
    not _reachable("localhost", 5432), reason="requires live Postgres"
)

# Test bbox around (0, 0) — no real road data lives there.
TEST_BBOX = (-0.5, -0.5, 0.5, 0.5)  # (min_lat, min_lon, max_lat, max_lon)

_INSERT = text(
    "INSERT INTO road_segments"
    " (osm_way_id, geom, name, highway_type, speed_limit_kph, lanes, one_way)"
    " VALUES (:id, ST_GeogFromText(:wkt), :name, :highway, :speed, :lanes, :one_way)"
)


async def _insert(session, rows):
    for row in rows:
        await session.execute(_INSERT, row)
    await session.commit()


@pytest.fixture
async def db_session():
    from db.session import get_session_factory

    async with get_session_factory()() as session:
        yield session
        await session.execute(text("DELETE FROM road_segments WHERE osm_way_id < 0"))
        await session.commit()


def _row(id_, wkt, highway="residential", speed=None, lanes=None, one_way=False):
    return {"id": id_, "wkt": wkt, "name": None, "highway": highway,
            "speed": speed, "lanes": lanes, "one_way": one_way}


@pytest.mark.integration
@requires_db
async def test_two_way_segment_emits_both_directions(db_session):
    await _insert(db_session, [_row(-1, "LINESTRING(0.1 0.1, 0.2 0.2)")])
    data = await build_road_graph_from_db(db_session, TEST_BBOX)
    assert data.x.shape == (2, NODE_FEATURE_DIM)
    assert data.edge_index.shape == (2, 2)
    assert data.edge_attr.shape == (2, EDGE_FEATURE_DIM)
    # Both directions carry identical features.
    assert torch.equal(data.edge_attr[0], data.edge_attr[1])
    # Reverse edge is the forward edge flipped.
    assert data.edge_index[:, 1].tolist() == data.edge_index[:, 0].flip(0).tolist()


@pytest.mark.integration
@requires_db
async def test_one_way_segment_emits_single_direction(db_session):
    await _insert(db_session, [_row(-2, "LINESTRING(0.1 0.1, 0.2 0.2)", one_way=True)])
    data = await build_road_graph_from_db(db_session, TEST_BBOX)
    assert data.edge_index.shape == (2, 1)
    assert data.edge_attr[0][2] == 1.0  # one_way flag position


@pytest.mark.integration
@requires_db
async def test_shared_endpoint_dedupes_junction_node(db_session):
    await _insert(db_session, [
        _row(-3, "LINESTRING(0.1 0.1, 0.2 0.2)"),
        _row(-4, "LINESTRING(0.2 0.2, 0.3 0.3)"),
    ])
    data = await build_road_graph_from_db(db_session, TEST_BBOX)
    assert data.x.shape[0] == 3  # 4 endpoints, junction (0.2, 0.2) deduped


@pytest.mark.integration
@requires_db
async def test_edge_feature_values(db_session):
    await _insert(db_session, [
        _row(-5, "LINESTRING(0.1 0.1, 0.2 0.2)", speed=65, lanes=3, one_way=True),
    ])
    data = await build_road_graph_from_db(db_session, TEST_BBOX)
    feat = data.edge_attr[0]
    assert feat[0] == pytest.approx(65 / 130.0)
    assert feat[1] == 3.0
    assert feat[2] == 1.0
    onehot = feat[3:].tolist()
    assert onehot[HIGHWAY_ONEHOT_TYPES.index("residential")] == 1.0
    assert sum(onehot) == 1.0


@pytest.mark.integration
@requires_db
async def test_null_speed_and_lanes_defaults(db_session):
    await _insert(db_session, [_row(-6, "LINESTRING(0.1 0.1, 0.2 0.2)")])
    data = await build_road_graph_from_db(db_session, TEST_BBOX)
    assert data.edge_attr[0][0] == pytest.approx(50 / 130.0)
    assert data.edge_attr[0][1] == 1.0


@pytest.mark.integration
@requires_db
async def test_unlisted_highway_type_encodes_all_zero_onehot(db_session):
    await _insert(db_session, [_row(-7, "LINESTRING(0.1 0.1, 0.2 0.2)", highway="trunk")])
    data = await build_road_graph_from_db(db_session, TEST_BBOX)
    assert sum(data.edge_attr[0][3:].tolist()) == 0.0


@pytest.mark.integration
@requires_db
async def test_bbox_excludes_far_segments(db_session):
    await _insert(db_session, [
        _row(-8, "LINESTRING(0.1 0.1, 0.2 0.2)"),
        _row(-9, "LINESTRING(10.1 10.1, 10.2 10.2)"),  # outside TEST_BBOX
    ])
    data = await build_road_graph_from_db(db_session, TEST_BBOX)
    assert data.edge_index.shape[1] == 2  # only the in-bbox two-way segment


@pytest.mark.integration
@requires_db
async def test_empty_bbox_returns_valid_empty_graph(db_session):
    data = await build_road_graph_from_db(db_session, (40.0, 40.0, 40.5, 40.5))
    assert data.x.shape == (0, NODE_FEATURE_DIM)
    assert data.edge_index.shape == (2, 0)
    assert data.edge_attr.shape == (0, EDGE_FEATURE_DIM)
