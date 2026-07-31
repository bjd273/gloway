"""Reads data/region.json — the one declaration of where this app works.

The same file drives the routing tiles, the basemap extract, the places
extracts and the frontend's coverage gate. Anything server-side that needs to
know the region reads it through here rather than hardcoding a bbox, because a
second copy of these numbers is how the places extract came to cover a
different area than the map (see places_coverage.py).
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from mapdata.models import BBox


@lru_cache(maxsize=4)
def load_bbox(region_path: str | None = None) -> BBox | None:
    """The region's bounding box, or None if it can't be read.

    None rather than an exception: callers use this to bias search toward the
    region, which is a nicety — an unreadable region file should degrade the
    ranking, not take down destination search.
    """
    from config import settings

    path = Path(region_path or settings.region_json_path)
    try:
        b = json.loads(path.read_text())["bbox"]
    except (OSError, ValueError, KeyError):
        return None
    return BBox(min_lat=b["south"], min_lon=b["west"], max_lat=b["north"], max_lon=b["east"])


def centre(region_path: str | None = None) -> tuple[float, float] | None:
    """(lat, lon) of the region's middle — the origin distance is measured from."""
    bbox = load_bbox(region_path)
    if bbox is None:
        return None
    return ((bbox.min_lat + bbox.max_lat) / 2, (bbox.min_lon + bbox.max_lon) / 2)
