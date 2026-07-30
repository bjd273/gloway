#!/bin/bash
set -e

mkdir -p data/osm

# The bounding box lives in data/region.json — the single source of truth every
# region-derived artifact reads (Valhalla tiles, the Martin basemap, Overture
# places, the frontend's coverage gate). It used to be copy-pasted into four
# files, which is four chances for coverage to silently disagree with the tiles.
BBOX=$(python3 -c "
import json
b = json.load(open('data/region.json'))['bbox']
print(f\"{b['west']},{b['south']},{b['east']},{b['north']}\")
")

# Only download the state extract if it isn't already here — it's ~700MB and
# re-cropping to a different bbox does not need a fresh copy.
if [ ! -f data/osm/texas.osm.pbf ]; then
  echo "Downloading Texas OSM extract (~700MB, one time)..."
  curl -L "https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf" -o data/osm/texas.osm.pbf
else
  echo "Reusing cached data/osm/texas.osm.pbf"
fi

echo "Cropping to $BBOX (min_lon,min_lat,max_lon,max_lat)..."
osmium extract -b "$BBOX" data/osm/texas.osm.pbf -o data/osm/region.osm.pbf --overwrite

echo "Verifying the cropped extract..."
osmium fileinfo data/osm/region.osm.pbf
