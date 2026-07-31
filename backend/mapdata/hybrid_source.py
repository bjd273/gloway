"""Composes several MapDataSource implementations, one method at a time.

Active policy (see factory.py): OSM backs routing metadata (the only mature
routing pipeline) and address geocoding via Nominatim. Places come from two
local indexes at once — Overture for volume, and an OSM POI index built from
the same extract the basemap's labels come from, so anything visible on the map
is findable by name. Free-text search unions all three, ranks the union, and
truncates; any source failing degrades to the others rather than erroring.

Ranking after the merge is load-bearing. The previous version concatenated
"Overture first, Nominatim second" and cut to five, so five weak Overture
substring matches could discard an exact match another source had found before
anything compared them. See ranking.py.
"""
from __future__ import annotations

import asyncio

from mapdata.base import MapDataSource
from mapdata.models import Address, BBox, Place, PlaceCategory, RoutingGraphRef
from mapdata.ranking import display_name, normalize, rank_addresses

# Two results closer than this (~50 m) are the same real-world place...
_DEDUPE_DEGREES = 0.0005
# ...but only if the names also agree. Overture and OSM often hold the same shop
# under slightly different spellings, while a mall food court packs a dozen
# genuinely different places inside 50 m — position alone would collapse those
# into one and hide most of a shopping centre from search.
_NAME_PREFIX_CHARS = 6

# Identical names get a much wider radius (~1 km). A large site — a theme park,
# a stadium, a mall — is a polygon in OSM and a point in Nominatim, and the
# polygon's centroid can sit hundreds of metres from the point, so 50 m does not
# catch it: "Six Flags Over Texas" came back twice. Two genuinely different
# places sharing an exact full name within a kilometre is rare enough that
# collapsing them is the better trade.
_SAME_NAME_DEDUPE_DEGREES = 0.009

# Each source is asked for more than the caller wants so ranking has real
# candidates to choose between instead of re-ordering an already-truncated list.
_CANDIDATE_MULTIPLIER = 4


def _name_of(address: Address) -> str:
    # Same notion of "the place's own name" the ranker scores on, so dedupe and
    # ranking can't disagree about what two results are called.
    return normalize(display_name(address))


def _within(a: Address, b: Address, degrees: float) -> bool:
    return abs(a.lat - b.lat) < degrees and abs(a.lon - b.lon) < degrees


def _is_duplicate(candidate: Address, existing: list[Address]) -> bool:
    cand_name = _name_of(candidate)
    for other in existing:
        other_name = _name_of(other)
        if cand_name and cand_name == other_name:
            if _within(candidate, other, _SAME_NAME_DEDUPE_DEGREES):
                return True
            continue
        if not _within(candidate, other, _DEDUPE_DEGREES):
            continue
        if not cand_name or not other_name:
            return True
        head = min(_NAME_PREFIX_CHARS, len(cand_name), len(other_name))
        if cand_name[:head] == other_name[:head]:
            return True
    return False


class HybridMapDataSource(MapDataSource):
    def __init__(self, routing_source: MapDataSource, places_sources: list[MapDataSource]):
        self._routing_source = routing_source        # e.g. OSMMapDataSource
        self._places_sources = places_sources        # e.g. [Overture, OsmPlaces]

    async def get_places(self, category: PlaceCategory, bbox: BBox) -> list[Place]:
        results = await asyncio.gather(
            *(s.get_places(category, bbox) for s in self._places_sources),
            return_exceptions=True,
        )
        places: list[Place] = []
        for result in results:
            if not isinstance(result, BaseException):
                places.extend(result)
        return places

    async def get_place_by_id(self, place_id: str) -> Place | None:
        # Each source answers only for its own id prefix, so trying all of them
        # is cheap — the wrong ones return None immediately.
        for source in (*self._places_sources, self._routing_source):
            place = await source.get_place_by_id(place_id)
            if place is not None:
                return place
        return None

    async def search_addresses(self, query: str, limit: int = 5) -> list[Address]:
        from mapdata.region_config import centre

        want = limit * _CANDIDATE_MULTIPLIER
        results = await asyncio.gather(
            *(s.search_addresses(query, want) for s in self._places_sources),
            self._routing_source.search_addresses(query, want),
            return_exceptions=True,
        )
        candidates: list[Address] = []
        for result in results:
            if not isinstance(result, BaseException):
                candidates.extend(result)

        # Rank first, dedupe second: when two sources hold the same place, the
        # copy that survives should be the better-scoring one rather than
        # whichever source happened to be listed first.
        merged: list[Address] = []
        for address in rank_addresses(query, candidates, centre()):
            if not _is_duplicate(address, merged):
                merged.append(address)
            if len(merged) >= limit:
                break
        return merged

    async def get_routing_graph_ref(self, bbox: BBox) -> RoutingGraphRef:
        return await self._routing_source.get_routing_graph_ref(bbox)
