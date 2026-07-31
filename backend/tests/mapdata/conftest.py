"""Shared mapdata fixtures.

`tiny_places_parquet` is a stand-in for the real Overture places extract,
written by duckdb with the same struct shapes the source reads
(names/categories/brand/bbox/addresses/confidence). `tiny_osm_places_parquet`
does the same for the OSM POI index. Both keep every test fully offline — the
real extracts are gitignored and machine-local.

The Overture fixture carries `names.common` and `brand` because search matches
them: a store named "Store #4471" with brand "Walmart" is the case that made
broadening the query worth doing, so a fixture without a brand column would
test the wrong shape.
"""
import duckdb
import pytest

_FIXTURE_SQL = """
COPY (
    SELECT 'p-coffee' AS id,
           {'primary': 'Loft Coffee', 'common': MAP{'es': 'Cafe Loft'}} AS names,
           {'primary': 'coffee_shop', 'alternate': ['cafe']} AS categories,
           0.95 AS confidence,
           -- "primary" is reserved in duckdb's struct *type* syntax, so the
           -- typed NULL has to quote it; the struct literals below don't.
           NULL::STRUCT(names STRUCT("primary" VARCHAR)) AS brand,
           {'xmin': -97.110, 'xmax': -97.110, 'ymin': 32.730, 'ymax': 32.730} AS bbox,
           [{'freeform': '201 E Front St', 'locality': 'Arlington'}] AS addresses
    UNION ALL
    SELECT 'p-fuel',
           {'primary': 'QuickGas', 'common': NULL},
           {'primary': 'gas_station', 'alternate': []},
           0.90,
           NULL,
           {'xmin': -97.100, 'xmax': -97.100, 'ymin': 32.740, 'ymax': 32.740},
           []
    UNION ALL
    -- Taxonomy leaf: only reachable through the *_restaurant suffix rule.
    SELECT 'p-italian',
           {'primary': 'Trattoria Nona', 'common': NULL},
           {'primary': 'italian_restaurant', 'alternate': []},
           0.85,
           NULL,
           {'xmin': -97.120, 'xmax': -97.120, 'ymin': 32.725, 'ymax': 32.725},
           [{'freeform': NULL, 'locality': 'Arlington'}]
    UNION ALL
    -- Unmapped category: must come back as OTHER / stay out of category queries.
    SELECT 'p-tattoo',
           {'primary': 'Ink Loft', 'common': NULL},
           {'primary': 'tattoo_and_piercing', 'alternate': []},
           0.80,
           NULL,
           {'xmin': -97.105, 'xmax': -97.105, 'ymin': 32.735, 'ymax': 32.735},
           []
    UNION ALL
    -- The reason search matches brand: nothing in this row's name says "Wallmart".
    SELECT 'p-branded',
           {'primary': 'Store #4471', 'common': NULL},
           {'primary': 'department_store', 'alternate': []},
           0.70,
           {'names': {'primary': 'Wallmart'}},
           {'xmin': -97.115, 'xmax': -97.115, 'ymin': 32.745, 'ymax': 32.745},
           [{'freeform': '900 Ballpark Way', 'locality': 'Arlington'}]
) TO '{path}' (FORMAT PARQUET)
"""

_OSM_FIXTURE_SQL = """
COPY (
    SELECT 'n1' AS id, 'Loft Coffee' AS name, NULL AS alt_names,
           'amenity=cafe' AS category, NULL AS brand,
           '201 E Front St, Arlington' AS addr,
           -97.1101 AS lon, 32.7301 AS lat
    UNION ALL
    -- Only in OSM, and it is the kind of thing the basemap labels: the case
    -- this index exists for.
    SELECT 'w2', 'Levitt Pavilion', 'Levitt Pavilion Arlington',
           'amenity=theatre', NULL, '100 W Abram St, Arlington', -97.1085, 32.7355
    UNION ALL
    SELECT 'n3', 'Green Market', NULL, 'shop=supermarket', 'Wallmart',
           '500 W Park Row Dr, Arlington', -97.1300, 32.7400
) TO '{path}' (FORMAT PARQUET)
"""


@pytest.fixture(scope="session")
def tiny_places_parquet(tmp_path_factory) -> str:
    path = str(tmp_path_factory.mktemp("overture") / "places.parquet")
    with duckdb.connect() as con:
        con.execute(_FIXTURE_SQL.replace("{path}", path))
    return path


@pytest.fixture(scope="session")
def tiny_osm_places_parquet(tmp_path_factory) -> str:
    path = str(tmp_path_factory.mktemp("osmpoi") / "places.parquet")
    with duckdb.connect() as con:
        con.execute(_OSM_FIXTURE_SQL.replace("{path}", path))
    return path
