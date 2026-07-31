"""One scorer for search results from every source.

Before this, ordering was "whatever Overture returned, then whatever Nominatim
returned" and the merged list was truncated to five. Overture could therefore
starve every other source: five weak substring matches would push out the exact
match another source had found. Ranking has to happen after the merge, on the
union, or the best result is discarded before anything compares it to anything.

Deliberately lexical, not fuzzy. A driver typing into a destination bar is
naming a place they already have in mind, so an exact or prefix hit is almost
always the one they want, and typo tolerance mostly buys wrong answers with
confident scores. Distance breaks ties, because two places with the same name
in one metro are a real case and the nearer one usually wins.
"""
from __future__ import annotations

import math
import re
import unicodedata

from mapdata.models import Address

_PUNCT = re.compile(r"[^a-z0-9]+")

# Score bands, most to least specific. Gaps are wide enough that no distance
# tiebreak can lift a weaker band above a stronger one.
_EXACT = 100.0
_PREFIX = 75.0
_WORD_START = 50.0
_SUBSTRING = 25.0

# Bonuses that break ties within a band. Their sum stays under the 25-point gap
# between bands, so no amount of being near or being short can promote a weaker
# kind of match over a stronger one.
_MAX_DISTANCE_BONUS = 10.0
# Beyond this the bonus is flat: everything outside the region is equally far.
_DISTANCE_SCALE_KM = 25.0

# How much of the name the query accounts for. Without it, "parks mall" ties
# "The Parks Mall at Arlington" with every tenant that has the mall's name
# inside its own ("Candy Crave N More Parks Mall"), and the mall itself lands
# below its own food court. A name that is mostly the query is the place being
# named; a name that merely contains it is something at that place.
_MAX_COVERAGE_BONUS = 12.0

# What a hit on each field is worth relative to a hit on the name. A brand match
# is nearly as good as a name match ("walmart" -> "Store #4471"); a category
# match is a weak signal ("coffee" -> some cafe) and must never outrank a real
# name hit.
_FIELD_WEIGHTS = (("brand", 0.9), ("category", 0.35))

# The formatted string is "Name, street, city", so a query can match it via the
# address alone. That has to score below a name hit or every tenant on Parks
# Mall Drive ties with The Parks Mall itself — which is what happened.
_FORMATTED_WEIGHT = 0.5


def normalize(text: str) -> str:
    """Casefold, strip accents, reduce punctuation to single spaces.

    So "AT&T Stadium" and "at t stadium" compare equal, and "Bar Louie -
    Arlington Highlands" word-starts on "arlington".
    """
    decomposed = unicodedata.normalize("NFKD", text)
    ascii_only = "".join(c for c in decomposed if not unicodedata.combining(c))
    return _PUNCT.sub(" ", ascii_only.lower()).strip()


def match_score(query: str, text: str | None) -> float:
    """How well one field answers the query. 0 means it doesn't."""
    if not text:
        return 0.0
    q, t = normalize(query), normalize(text)
    if not q or not t:
        return 0.0
    if t == q:
        return _EXACT
    if t.startswith(q):
        return _PREFIX
    # Word-start beats a mid-word hit: "park" should rank "Parks Mall" above
    # "Sparkle Cleaners".
    if f" {q}" in f" {t}":
        return _WORD_START
    if q in t:
        return _SUBSTRING
    return 0.0


def _distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    # Equirectangular, same approximation the frontend's routeProgress.ts uses.
    # Exact enough to order results inside one metro area.
    mean_lat = math.radians((lat1 + lat2) / 2)
    dx = (lon2 - lon1) * 111.32 * math.cos(mean_lat)
    dy = (lat2 - lat1) * 110.54
    return math.hypot(dx, dy)


def display_name(address: Address) -> str:
    """The place's own name, without the address trailing it.

    Sources that have a name field say so in metadata. Nominatim doesn't, but
    its display_name leads with the place, so the first comma-separated part is
    the closest equivalent.
    """
    name = address.metadata.get("name") if address.metadata else None
    if isinstance(name, str) and name:
        return name
    return address.formatted.split(",")[0]


def score_address(query: str, address: Address, centre: tuple[float, float] | None) -> float:
    """Best field score for this result, plus a bonus for being nearby."""
    best = match_score(query, display_name(address))
    best = max(best, match_score(query, address.formatted) * _FORMATTED_WEIGHT)
    for field, weight in _FIELD_WEIGHTS:
        value = address.metadata.get(field) if address.metadata else None
        if isinstance(value, str):
            best = max(best, match_score(query, value) * weight)
    if best == 0.0:
        # The source matched on something not scored here (an address line, an
        # alternate name). Keep it — it is still a real hit — but below
        # everything that matched a scored field.
        return 1.0

    name = normalize(display_name(address))
    coverage = len(normalize(query)) / len(name) if name else 0.0
    best += _MAX_COVERAGE_BONUS * min(coverage, 1.0)

    if centre is None:
        return best
    km = _distance_km(centre[0], centre[1], address.lat, address.lon)
    return best + _MAX_DISTANCE_BONUS * math.exp(-km / _DISTANCE_SCALE_KM)


def rank_addresses(
    query: str, addresses: list[Address], centre: tuple[float, float] | None = None
) -> list[Address]:
    """Highest score first. Stable, so a source's own order survives a tie."""
    return sorted(addresses, key=lambda a: -score_address(query, a, centre))
