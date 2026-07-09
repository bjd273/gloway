"""Constructs the configured MapDataSource. This is the ONLY place in the
codebase that decides which provider(s) are active — everywhere else imports
the interface and calls this factory, never a concrete class directly.
"""
from __future__ import annotations

from mapdata.base import MapDataSource
from mapdata.hybrid_source import HybridMapDataSource
from mapdata.osm_source import OSMMapDataSource
from mapdata.overture_source import OvertureMapDataSource


def get_map_data_source() -> MapDataSource:
    from config import settings

    if settings.map_data_source == "osm":
        return OSMMapDataSource()
    if settings.map_data_source == "overture":
        return OvertureMapDataSource()
    if settings.map_data_source == "hybrid":
        return HybridMapDataSource(
            routing_source=OSMMapDataSource(), places_source=OvertureMapDataSource()
        )
    raise ValueError(f"Unknown map_data_source: {settings.map_data_source!r}")
