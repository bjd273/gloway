"""Places along the route ahead — the backing store for the in-drive "add a stop" bar.

The pre-trip conversation already resolves a stop by name or category
(conversation.py::_find_stop), but it searches a bbox around origin/destination
and picks the candidate nearest the O-D midpoint. That is the right answer for
"stop for coffee on the way" asked before leaving, and the wrong one for a
driver who is 80% of the way there: the midpoint is behind them, so the winner
is a cafe they passed ten minutes ago.

This endpoint answers the in-drive question instead. It takes the route the
trip is actually following, cuts it at the driver's current position, and only
ever considers what is left. Candidates are then ranked by how far off that
remaining line they sit, which is the closest thing to a detour cost we can
compute without spending a Valhalla call per candidate.

Failure mode is deliberately quiet: a provider outage (public Overpass 5xx, a
timeout) resolves to an empty list, not a 5xx. A driver at 60 mph gets "nothing
nearby" and moves on; an error dialog would be worse than useless.
"""
from __future__ import annotations

import uuid

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from shapely.geometry import LineString, Point
from sqlalchemy.ext.asyncio import AsyncSession

from db.models import Trip
from db.session import get_db
from mapdata.factory import get_map_data_source
from mapdata.models import BBox, Place, PlaceCategory
from services.signal_processor import _to_meters, route_coords_from_suggested

router = APIRouter()

# Padding on the bbox around the remaining route, in degrees (~1.1 km of
# latitude). Sized to match MAX_DETOUR_METERS below: a wider box only fetches
# places the ranking will immediately throw away, and every extra square
# kilometre is provider latency the driver waits through.
_BBOX_PAD_DEGREES = 0.01

# Anything further off the remaining route than this is not a stop "on the
# way", it is a separate errand. One kilometre of perpendicular offset is
# already a couple of minutes each way on surface streets.
_MAX_DETOUR_METERS = 1000.0

# Detour distances are bucketed to this before sorting so the "how soon does it
# come up" tiebreak actually fires. Raw float distances essentially never tie,
# which would make the secondary key dead code — and a driver cannot tell 180 m
# off-route from 240 m anyway, while "in 1 mile" versus "in 6 miles" is the
# whole decision.
_DETOUR_BUCKET_METERS = 100.0


class PlaceAlongRoute(BaseModel):
    name: str
    lat: float
    lon: float
    # One-way perpendicular offset from the remaining route line, NOT a routed
    # detour — we do not spend a Valhalla call per candidate. The UI words it
    # as "off route" rather than "+N min" for exactly that reason.
    detour_meters: float
    # How far along the remaining route the place comes up. Lets the UI say
    # "in 2.4 mi", which is what tells a driver whether they can wait.
    along_meters: float


class PlacesAlongRouteResponse(BaseModel):
    places: list[PlaceAlongRoute]


def _remaining_route_meters(
    coords: list[tuple[float, float]], from_lat: float, from_lon: float
) -> tuple[LineString, list[tuple[float, float]], float, float] | None:
    """Cut the route at (from_lat, from_lon) and project what's left to meters.

    Returns (line_in_meters, remaining_lonlat, lat0, lon0), or None when there
    is not enough geometry left to be worth searching.

    Meters, not degrees: a degree of longitude is ~cos(lat) shorter than a
    degree of latitude, so flat degree math ranks candidates north/south of the
    route as closer than they are (the same bug signal_processor.py's module
    docstring calls out). `_to_meters` is that module's local equirectangular
    projection, which is accurate over a metro-sized area.
    """
    if len(coords) < 2:
        return None

    lat0 = float(np.mean([lat for _, lat in coords]))
    lon0 = float(np.mean([lon for lon, _ in coords]))
    projected = _to_meters(coords, lat0, lon0)
    line = LineString(projected)

    # Where the driver is, as a distance along the whole route. shapely's
    # project handles the perpendicular-foot case, so a fix between two
    # vertices cuts between them rather than snapping back to the last one.
    here_x, here_y = _to_meters([(from_lon, from_lat)], lat0, lon0)[0]
    cut = line.project(Point(here_x, here_y))

    # Cumulative distance at each vertex, so we can keep only the ones past the
    # cut. Anything at or behind the driver must not produce a candidate —
    # that is the entire reason this endpoint exists rather than reusing
    # conversation.py's corridor search.
    deltas = np.hypot(np.diff([x for x, _ in projected]), np.diff([y for _, y in projected]))
    cumulative = np.concatenate([[0.0], np.cumsum(deltas)])
    ahead = [i for i, d in enumerate(cumulative) if d > cut]
    if not ahead:
        return None

    # Start the remaining line at the driver, not at the next vertex: on a long
    # highway leg the next vertex can be a mile away, which would report every
    # candidate as further ahead than it is.
    head = line.interpolate(cut)
    remaining_m = [(head.x, head.y)] + [projected[i] for i in ahead]
    if len(remaining_m) < 2:
        return None
    remaining_lonlat = [coords[i] for i in ahead]
    return LineString(remaining_m), remaining_lonlat, lat0, lon0


async def _fetch_places(category: PlaceCategory, bbox: BBox) -> list[Place]:
    """Provider call, degraded to [] on any failure.

    Same lifecycle as conversation.py::_find_stop — the source owns a client
    session, so aclose runs in a `finally` whether the query succeeded or not.
    """
    source = get_map_data_source()
    try:
        return await source.get_places(category, bbox)
    except Exception:
        return []
    finally:
        if hasattr(source, "aclose"):
            await source.aclose()


@router.get("/along-route", response_model=PlacesAlongRouteResponse)
async def places_along_route(
    trip_id: str = Query(...),
    category: PlaceCategory = Query(...),
    from_lat: float = Query(..., ge=-90, le=90),
    from_lon: float = Query(..., ge=-180, le=180),
    limit: int = Query(3, ge=1, le=10),
    db: AsyncSession = Depends(get_db),
) -> PlacesAlongRouteResponse:
    """Named places of `category` on the part of the trip's route still ahead."""
    try:
        tid = uuid.UUID(trip_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="trip_id must be a UUID")
    trip = await db.get(Trip, tid)
    if trip is None:
        raise HTTPException(status_code=404, detail="trip not found")

    # The route currently being driven. A mid-drive reroute rewrites this row in
    # place (routing.py's reroute_of_trip_id path), so reading it here always
    # gets the geometry the puck is actually on.
    coords = route_coords_from_suggested(trip.suggested_route or {})
    remaining = _remaining_route_meters(coords, from_lat, from_lon)
    # Already at the destination, or a trip with no decodable geometry. Both are
    # "nothing ahead", which is an empty list rather than an error.
    if remaining is None:
        return PlacesAlongRouteResponse(places=[])
    line, remaining_lonlat, lat0, lon0 = remaining

    lats = [lat for _, lat in remaining_lonlat]
    lons = [lon for lon, _ in remaining_lonlat]
    bbox = BBox(
        min_lat=min(lats) - _BBOX_PAD_DEGREES,
        min_lon=min(lons) - _BBOX_PAD_DEGREES,
        max_lat=max(lats) + _BBOX_PAD_DEGREES,
        max_lon=max(lons) + _BBOX_PAD_DEGREES,
    )

    ranked: list[tuple[float, float, PlaceAlongRoute]] = []
    for place in await _fetch_places(category, bbox):
        # A nameless node makes a useless "via ..." label — the same filter
        # conversation.py applies, for the same reason.
        if not place.name:
            continue
        x, y = _to_meters([(place.lon, place.lat)], lat0, lon0)[0]
        point = Point(x, y)
        detour = line.distance(point)
        if detour > _MAX_DETOUR_METERS:
            continue
        ranked.append((
            round(detour / _DETOUR_BUCKET_METERS),
            line.project(point),
            PlaceAlongRoute(
                name=place.name,
                lat=place.lat,
                lon=place.lon,
                detour_meters=round(detour, 1),
                along_meters=round(line.project(point), 1),
            ),
        ))

    ranked.sort(key=lambda entry: (entry[0], entry[1]))

    # De-duplicate before slicing. The hybrid source blends Overture and OSM and
    # routinely carries the same restaurant in both, a few metres apart — three
    # slots is already a tight budget and spending two of them on one
    # "Mama Deluca's" (observed on the Arlington extract) is the worst outcome
    # here. Three decimal places is ~110 m, which merges two records of one
    # place and still keeps two genuinely different branches of a chain apart.
    seen: set[tuple[str, float, float]] = set()
    out: list[PlaceAlongRoute] = []
    for _, _, place_out in ranked:
        key = (place_out.name.strip().lower(), round(place_out.lat, 3), round(place_out.lon, 3))
        if key in seen:
            continue
        seen.add(key)
        out.append(place_out)
        if len(out) == limit:
            break
    return PlacesAlongRouteResponse(places=out)
