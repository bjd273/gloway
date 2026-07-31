"""The guard for the failure that started all of this.

data/region.json was widened and every derived artifact was rebuilt except the
places extract, which kept covering the old, much smaller box. Nothing errored:
the file was there, the queries ran, they just found nothing across most of the
map. These tests are the reason that can't happen silently again.
"""
import json

from mapdata.places_coverage import check_coverage

_REGION = {"bbox": {"west": -97.22, "south": 32.60, "east": -97.03, "north": 32.82}}


def _write(tmp_path, region=_REGION, state=None):
    region_path = tmp_path / "region.json"
    region_path.write_text(json.dumps(region))
    state_path = tmp_path / "places.parquet.state"
    if state is not None:
        state_path.write_text(json.dumps(state))
    return str(state_path), str(region_path)


def _state(xmin, ymin, xmax, ymax, release="2026-07-22.0"):
    return {"last_release": release, "bbox": {"xmin": xmin, "ymin": ymin, "xmax": xmax, "ymax": ymax}}


def test_matching_bbox_passes(tmp_path):
    paths = _write(tmp_path, state=_state(-97.22, 32.60, -97.03, 32.82))
    assert check_coverage(*paths).ok


def test_larger_extract_passes(tmp_path):
    paths = _write(tmp_path, state=_state(-97.30, 32.50, -96.90, 32.90))
    assert check_coverage(*paths).ok


def test_the_actual_regression_is_caught(tmp_path):
    # The real numbers: the extract built on Jul 16 against the region as it
    # stood on Jul 27.
    paths = _write(tmp_path, state=_state(-97.14, 32.715, -97.08, 32.76))
    result = check_coverage(*paths)
    assert not result.ok
    for edge in ("west", "south", "east", "north"):
        assert edge in result.message
    assert "download_overture.sh" in result.message


def test_short_on_one_edge_names_only_that_edge(tmp_path):
    paths = _write(tmp_path, state=_state(-97.22, 32.60, -97.10, 32.82))
    result = check_coverage(*paths)
    assert not result.ok
    assert "east" in result.message
    assert "west" not in result.message


def test_float_noise_does_not_fail_a_good_build(tmp_path):
    paths = _write(tmp_path, state=_state(-97.22 + 1e-12, 32.60, -97.03, 32.82))
    assert check_coverage(*paths).ok


def test_missing_state_file_is_reported_not_raised(tmp_path):
    paths = _write(tmp_path, state=None)
    result = check_coverage(*paths)
    assert not result.ok
    assert "missing" in result.message


def test_state_without_a_bbox_is_reported(tmp_path):
    paths = _write(tmp_path, state={"last_release": "2026-07-22.0"})
    assert not check_coverage(*paths).ok


def test_unparseable_metadata_is_reported_not_raised(tmp_path):
    region_path = tmp_path / "region.json"
    region_path.write_text("{not json")
    state_path = tmp_path / "places.parquet.state"
    state_path.write_text(json.dumps(_state(-97.22, 32.60, -97.03, 32.82)))
    assert not check_coverage(str(state_path), str(region_path)).ok
