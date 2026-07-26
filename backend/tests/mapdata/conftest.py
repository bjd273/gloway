"""Shared mapdata fixtures.

`tiny_places_parquet` is a four-row stand-in for the real Overture places
extract, written by duckdb with the same struct shapes the source reads
(names/categories/bbox/addresses/confidence). It keeps every Overture test
fully offline — the real parquet is gitignored and machine-local.
"""
import duckdb
import pytest

_FIXTURE_SQL = """
COPY (
    SELECT 'p-coffee' AS id,
           {'primary': 'Loft Coffee'} AS names,
           {'primary': 'coffee_shop', 'alternate': ['cafe']} AS categories,
           0.95 AS confidence,
           {'xmin': -97.110, 'xmax': -97.110, 'ymin': 32.730, 'ymax': 32.730} AS bbox,
           [{'freeform': '201 E Front St', 'locality': 'Arlington'}] AS addresses
    UNION ALL
    SELECT 'p-fuel',
           {'primary': 'QuickGas'},
           {'primary': 'gas_station', 'alternate': []},
           0.90,
           {'xmin': -97.100, 'xmax': -97.100, 'ymin': 32.740, 'ymax': 32.740},
           []
    UNION ALL
    -- Taxonomy leaf: only reachable through the *_restaurant suffix rule.
    SELECT 'p-italian',
           {'primary': 'Trattoria Nona'},
           {'primary': 'italian_restaurant', 'alternate': []},
           0.85,
           {'xmin': -97.120, 'xmax': -97.120, 'ymin': 32.725, 'ymax': 32.725},
           [{'freeform': NULL, 'locality': 'Arlington'}]
    UNION ALL
    -- Unmapped category: must come back as OTHER / stay out of category queries.
    SELECT 'p-tattoo',
           {'primary': 'Ink Loft'},
           {'primary': 'tattoo_and_piercing', 'alternate': []},
           0.80,
           {'xmin': -97.105, 'xmax': -97.105, 'ymin': 32.735, 'ymax': 32.735},
           []
) TO '{path}' (FORMAT PARQUET)
"""


@pytest.fixture(scope="session")
def tiny_places_parquet(tmp_path_factory) -> str:
    path = str(tmp_path_factory.mktemp("overture") / "places.parquet")
    with duckdb.connect() as con:
        con.execute(_FIXTURE_SQL.replace("{path}", path))
    return path
