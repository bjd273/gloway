"""What "findable" means, pinned down.

These cover the three reasons a place a driver could see on the map came back
with no search results: it was outside the extract (test_places_coverage.py),
its name was not the word they typed (brand/category/alt-name matching here),
or a better match existed but was truncated away before ranking (ranking here).
"""
import pytest

from mapdata.models import Address
from mapdata.osm_places_source import OsmPlacesSource
from mapdata.overture_source import OvertureMapDataSource
from mapdata.ranking import match_score, normalize, rank_addresses


def _addr(name: str, lat: float = 32.71, lon: float = -97.125, **meta) -> Address:
    return Address(
        id=name, formatted=name, lat=lat, lon=lon, source="test",
        metadata={"name": name, **meta},
    )


# --- normalization ---------------------------------------------------------

@pytest.mark.parametrize(
    "raw, expected",
    [
        ("AT&T Stadium", "at t stadium"),
        ("  Loft  Coffee  ", "loft coffee"),
        ("Café Móntaña", "cafe montana"),
        ("Walmart Supercenter #4471", "walmart supercenter 4471"),
    ],
)
def test_normalize_folds_case_accents_and_punctuation(raw, expected):
    assert normalize(raw) == expected


# --- scoring ---------------------------------------------------------------

def test_match_bands_are_ordered_most_specific_first():
    exact = match_score("parks mall", "Parks Mall")
    prefix = match_score("parks mall", "Parks Mall at Arlington")
    word_start = match_score("mall", "Parks Mall")
    substring = match_score("all", "Parks Mall")
    assert exact > prefix > word_start > substring > 0


def test_word_start_beats_mid_word_match():
    # "park" should find Parks Mall before Sparkle Cleaners.
    assert match_score("park", "Parks Mall") > match_score("park", "Sparkle Cleaners")


def test_non_match_scores_zero():
    assert match_score("stadium", "Loft Coffee") == 0.0


def test_ranking_puts_exact_match_first_despite_input_order():
    ranked = rank_addresses(
        "parks mall",
        [_addr("Parks Mall Dental Suite"), _addr("Sparks Mallory Realty"), _addr("Parks Mall")],
        centre=(32.71, -97.125),
    )
    assert ranked[0].metadata["name"] == "Parks Mall"


def test_distance_breaks_ties_but_never_crosses_a_band():
    centre = (32.71, -97.125)
    far_exact = _addr("Walmart", lat=32.82, lon=-97.03)
    near_prefix = _addr("Walmart Supercenter", lat=32.711, lon=-97.126)
    ranked = rank_addresses("walmart", [near_prefix, far_exact], centre)
    # The exact match wins even though the prefix match is right on top of us.
    assert ranked[0] is far_exact


def test_the_place_itself_outranks_things_named_after_it():
    # The mall's own name and every tenant's name contain "Parks Mall", so all
    # of them land in the same match band. Without a specificity tiebreak the
    # mall sorted below its own food court.
    mall = _addr("The Parks Mall at Arlington")
    tenants = [
        _addr("Candy Crave N More Parks Mall"),
        _addr("Yummy Cup Corn & Wassup Dog The Parks mall at Arlington"),
        _addr("The B12 Store @ The Parks Mall at Arlington"),
    ]
    assert rank_addresses("parks mall", [*tenants, mall], (32.71, -97.125))[0] is mall


def test_a_shop_on_a_street_named_after_a_place_ranks_below_it():
    mall = _addr("The Parks Mall at Arlington")
    on_that_street = Address(
        id="tenant", formatted="Body Play, 3811 Parks Mall Dr, Arlington",
        lat=32.71, lon=-97.125, source="test", metadata={"name": "Body Play"},
    )
    assert rank_addresses("parks mall", [on_that_street, mall], None)[0] is mall


def test_nearer_of_two_equal_matches_wins():
    centre = (32.71, -97.125)
    near = _addr("Walmart", lat=32.712, lon=-97.126)
    far = _addr("Walmart", lat=32.82, lon=-97.03)
    assert rank_addresses("walmart", [far, near], centre)[0] is near


def test_a_name_match_outranks_the_same_query_hitting_a_brand():
    branded = _addr("Store #4471", brand="Wallmart")
    named = _addr("Wallmart")
    assert rank_addresses("wallmart", [branded, named], None)[0] is named


def test_a_brand_match_outranks_a_category_match():
    # Someone typing "grocery" more likely means the chain called Grocery
    # Outlet than an arbitrary shop Overture happens to file under grocery_store.
    branded = _addr("Store #12", brand="Grocery Outlet")
    by_category = _addr("Pham Market", category="grocery_store")
    assert rank_addresses("grocery", [by_category, branded], None)[0] is branded


# --- the queries themselves ------------------------------------------------

async def test_overture_search_finds_a_place_by_brand(tiny_places_parquet):
    # "Store #4471" contains none of the query; only brand.names.primary does.
    source = OvertureMapDataSource(places_path=tiny_places_parquet)
    results = await source.search_addresses("wallmart", limit=5)
    assert [r.id for r in results] == ["overture:place/p-branded"]


async def test_overture_search_matches_category_words_with_spaces(tiny_places_parquet):
    # Overture spells the category "gas_station"; nobody types the underscore.
    source = OvertureMapDataSource(places_path=tiny_places_parquet)
    results = await source.search_addresses("gas station", limit=5)
    assert "overture:place/p-fuel" in [r.id for r in results]


async def test_overture_search_matches_an_alternate_language_name(tiny_places_parquet):
    source = OvertureMapDataSource(places_path=tiny_places_parquet)
    results = await source.search_addresses("Cafe Loft", limit=5)
    assert "overture:place/p-coffee" in [r.id for r in results]


async def test_overture_search_matches_the_street_line(tiny_places_parquet):
    source = OvertureMapDataSource(places_path=tiny_places_parquet)
    results = await source.search_addresses("Ballpark Way", limit=5)
    assert "overture:place/p-branded" in [r.id for r in results]


async def test_osm_index_finds_a_place_absent_from_overture(tiny_osm_places_parquet):
    # The whole reason this index exists: the basemap labels it, so search has
    # to be able to find it, whether or not Overture happens to carry it.
    source = OsmPlacesSource(places_path=tiny_osm_places_parquet)
    results = await source.search_addresses("Levitt", limit=5)
    assert [r.id for r in results] == ["osmpoi:w2"]


async def test_osm_index_matches_alt_names_and_brand(tiny_osm_places_parquet):
    source = OsmPlacesSource(places_path=tiny_osm_places_parquet)
    assert await source.search_addresses("Levitt Pavilion Arlington", limit=5)
    branded = await source.search_addresses("wallmart", limit=5)
    assert [r.id for r in branded] == ["osmpoi:n3"]


async def test_missing_osm_index_degrades_to_empty_not_error(tmp_path):
    source = OsmPlacesSource(places_path=str(tmp_path / "nope.parquet"))
    assert await source.search_addresses("anything", limit=5) == []
