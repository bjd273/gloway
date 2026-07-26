"""Unit tests for the OSM tag parsing and junction-splitting logic.

Pure functions only — no DB, no torch, no osmium. The DB-touching load path
is covered indirectly by test_graph_builder.py's fixtures plus the real
ingestion run documented in the roadmap.
"""
from collections import Counter

import pytest

from ml.gnn.ingest import (
    count_coordinate_occurrences,
    feature_to_rows,
    parse_lanes,
    parse_maxspeed,
    parse_oneway,
    round_pt,
    split_way_at_junctions,
)


@pytest.mark.parametrize(("value", "expected"), [
    ("45", 45),
    ("45 mph", 72),
    ("30mph", 48),
    ("100", 100),
    ("none", None),
    ("walk", None),
    ("signals", None),
    ("50;60", None),
    ("", None),
    (None, None),
])
def test_parse_maxspeed(value, expected):
    assert parse_maxspeed(value) == expected


@pytest.mark.parametrize(("value", "expected"), [
    ("2", 2),
    ("1", 1),
    ("two", None),
    ("0", None),
    ("-1", None),
    (None, None),
])
def test_parse_lanes(value, expected):
    assert parse_lanes(value) == expected


@pytest.mark.parametrize(("tags", "expected"), [
    ({"oneway": "yes"}, (True, False)),
    ({"oneway": "true"}, (True, False)),
    ({"oneway": "1"}, (True, False)),
    ({"oneway": "-1"}, (True, True)),
    ({"oneway": "no"}, (False, False)),
    ({}, (False, False)),
])
def test_parse_oneway(tags, expected):
    assert parse_oneway(tags) == expected


def _counts(*ways):
    return count_coordinate_occurrences(
        iter({"geometry": {"coordinates": list(way)}} for way in ways)
    )


def test_split_no_junction_is_single_piece():
    way = [(-97.1, 32.7), (-97.11, 32.71), (-97.12, 32.72)]
    counts = _counts(way)
    assert split_way_at_junctions(way, counts) == [way]


def test_split_at_interior_junction():
    # Way B crosses way A at A's middle point -> A splits into two pieces
    # that share the junction coordinate.
    a = [(-97.1, 32.7), (-97.11, 32.71), (-97.12, 32.72)]
    b = [(-97.11, 32.71), (-97.11, 32.75)]
    counts = _counts(a, b)
    pieces = split_way_at_junctions(a, counts)
    assert pieces == [
        [(-97.1, 32.7), (-97.11, 32.71)],
        [(-97.11, 32.71), (-97.12, 32.72)],
    ]


def test_endpoint_only_junction_does_not_split():
    # Ways meeting only at endpoints stay whole — graph_builder's endpoint
    # matching links them without any split.
    a = [(-97.1, 32.7), (-97.11, 32.71)]
    b = [(-97.11, 32.71), (-97.12, 32.72)]
    counts = _counts(a, b)
    assert split_way_at_junctions(a, counts) == [a]
    assert split_way_at_junctions(b, counts) == [b]


def test_consecutive_duplicates_collapse():
    way = [(-97.1, 32.7), (-97.1, 32.7), (-97.11, 32.71)]
    counts = _counts(way)
    assert split_way_at_junctions(way, counts) == [[(-97.1, 32.7), (-97.11, 32.71)]]


def test_degenerate_way_dropped():
    way = [(-97.1, 32.7)]
    assert split_way_at_junctions(way, Counter()) == []


def test_round_pt_five_decimals():
    assert round_pt(-97.123456789, 32.987654321) == (-97.12346, 32.98765)


def _feature(tags, coords):
    return {"properties": tags, "geometry": {"type": "LineString", "coordinates": coords}}


def test_feature_to_rows_end_to_end():
    coords = [[-97.1, 32.7], [-97.11, 32.71]]
    feature = _feature(
        {"@id": 42, "highway": "residential", "name": "Elm St",
         "maxspeed": "30 mph", "lanes": "2", "oneway": "no"},
        coords,
    )
    rows = feature_to_rows(feature, Counter())
    assert len(rows) == 1
    row = rows[0]
    assert row["osm_way_id"] == 42
    assert row["name"] == "Elm St"
    assert row["highway_type"] == "residential"
    assert row["speed_limit_kph"] == 48
    assert row["lanes"] == 2
    assert row["one_way"] is False
    assert row["wkt"] == "LINESTRING(-97.1 32.7, -97.11 32.71)"


def test_feature_to_rows_reverses_minus_one_oneway():
    feature = _feature(
        {"@id": 7, "highway": "primary", "oneway": "-1"},
        [[-97.1, 32.7], [-97.11, 32.71]],
    )
    rows = feature_to_rows(feature, Counter())
    assert rows[0]["one_way"] is True
    # Geometry reversed so stored direction == travel direction.
    assert rows[0]["wkt"] == "LINESTRING(-97.11 32.71, -97.1 32.7)"


def test_feature_to_rows_rejects_non_routable():
    feature = _feature({"@id": 9, "highway": "footway"}, [[-97.1, 32.7], [-97.11, 32.71]])
    assert feature_to_rows(feature, Counter()) == []
