"""Does the places extract actually cover the region the map draws?

This exists because it silently didn't. `data/region.json` was widened from a
5.6 x 4.9 km box to the full 18 x 24 km of Arlington and every derived artifact
was rebuilt except `data/overture/places.parquet` — so the basemap kept drawing
labels for the whole region while search could only see the middle 6% of it.
81% of the region's labelled POIs were not in the search index at all, and
nothing anywhere reported a problem: the parquet existed, the queries ran, they
just returned nothing for most of the map.

Both ends of the pipeline now check: `scripts/rebuild_region.sh` fails the
build, and `OvertureMapDataSource` logs a warning at startup. The check is
deliberately on the recorded *state* rather than on the data, so it stays true
even for a region with genuinely no places near one edge.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

# Coordinates round-trip through JSON as floats; a tolerance well under any
# meaningful distance (~1 cm) keeps float noise from failing a good build.
_EPSILON = 1e-7


@dataclass(frozen=True)
class CoverageResult:
    ok: bool
    message: str


def check_coverage(state_path: str | Path, region_path: str | Path) -> CoverageResult:
    """Compare a `<extract>.state` bbox against the region it must cover.

    Missing files are reported as not-ok rather than raised: callers are a build
    script that wants a readable failure and a service constructor that must not
    take the process down.
    """
    state_path, region_path = Path(state_path), Path(region_path)
    if not state_path.exists():
        return CoverageResult(False, f"{state_path} is missing — run data/download_overture.sh")
    if not region_path.exists():
        return CoverageResult(False, f"{region_path} is missing")

    try:
        state = json.loads(state_path.read_text())
        region = json.loads(region_path.read_text())["bbox"]
    except (ValueError, KeyError) as exc:
        return CoverageResult(False, f"Could not parse coverage metadata: {exc}")

    have = state.get("bbox")
    if not have:
        return CoverageResult(False, f"{state_path} records no bbox — re-run data/download_overture.sh")

    # Every edge of the region must be inside the extract. Reported together,
    # not on the first failure, because "it's short on two sides" and "it's a
    # completely different area" call for different reactions.
    short = [
        name
        for name, ok in (
            ("west", have["xmin"] <= region["west"] + _EPSILON),
            ("south", have["ymin"] <= region["south"] + _EPSILON),
            ("east", have["xmax"] >= region["east"] - _EPSILON),
            ("north", have["ymax"] >= region["north"] - _EPSILON),
        )
        if not ok
    ]
    if short:
        return CoverageResult(
            False,
            f"Places extract does not cover the region on: {', '.join(short)}. "
            f"Extract {have['xmin']},{have['ymin']},{have['xmax']},{have['ymax']} vs region "
            f"{region['west']},{region['south']},{region['east']},{region['north']}. "
            "Places outside the extract render on the map but cannot be searched — "
            "re-run data/download_overture.sh.",
        )
    return CoverageResult(True, f"Places extract covers the region (release {state.get('last_release', '?')})")
