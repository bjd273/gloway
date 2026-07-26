"""Normalized data models shared by every MapDataSource implementation.

Enrichment code (EV charging, delivery, cycling, geocoding, ...) is written
against these types only. Translation from a provider's native schema (OSM
tags, Overture's GERS schema, a future custom feed) happens exactly once,
inside that provider's MapDataSource implementation. This is what makes
adding or blending a second provider a same-day change instead of a rewrite.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class PlaceCategory(str, Enum):
    """Common category taxonomy across all providers.

    Add new members here as new use cases need them (e.g. a ``PLAYGROUND``
    category for a "parent mode"). Never invent a provider-specific string in
    calling code — every MapDataSource implementation is responsible for
    mapping its own vocabulary onto this enum, including an ``OTHER`` fallback
    for anything unmapped.
    """

    EV_CHARGING = "ev_charging"
    FUEL = "fuel"
    PARKING = "parking"
    PARK = "park"
    CAFE = "cafe"
    RESTAURANT = "restaurant"
    GROCERY = "grocery"
    LODGING = "lodging"
    BIKE_PARKING = "bike_parking"
    TRANSIT_STOP = "transit_stop"
    OTHER = "other"


@dataclass(frozen=True)
class BBox:
    min_lat: float
    min_lon: float
    max_lat: float
    max_lon: float


@dataclass(frozen=True)
class Place:
    """A single point of interest, normalized across providers."""

    id: str                        # provider-prefixed, e.g. "osm:node/12345", "overture:place/abc"
    name: str | None
    category: PlaceCategory
    lat: float
    lon: float
    source: str                    # "osm" | "overture" | "custom:<provider>"
    # Raw provider tags/fields, kept for enrichment logic that needs specifics
    # a normalized field can't capture yet (e.g. EV connector type, plug count).
    # Reach for a new typed field on Place before reaching into metadata by hand
    # in more than one call site — that's the signal it should be promoted.
    metadata: dict = field(default_factory=dict)


@dataclass(frozen=True)
class Address:
    id: str
    formatted: str
    lat: float
    lon: float
    source: str
    metadata: dict = field(default_factory=dict)


@dataclass(frozen=True)
class RoutingGraphRef:
    """Pointer to a built routing graph (Valhalla tileset), not the graph itself.

    The routing graph is built offline from OSM only (see Week 1-2) regardless
    of which provider backs get_places/search_addresses. This type exists so
    the interface is complete and callers have one place to ask "which
    tileset/region am I routing against" without reaching into valhalla/
    config directly. ``source`` is expected to always be "osm" today.
    """

    region_id: str
    built_at: str
    source: str
