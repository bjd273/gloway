#!/bin/bash
set -e

mkdir -p data/osm

echo "Downloading Texas OSM extract..."
curl -L "https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf" -o data/osm/texas.osm.pbf || true

echo "Cropping to Central Arlington bounding box..."
# Bounding box: I-30, W Park Row Dr, Fielder Rd, Collins St
# BBox format: min_lon,min_lat,max_lon,max_lat
osmium extract -b -97.140,32.715,-97.080,32.760 data/osm/texas.osm.pbf -o data/osm/region.osm.pbf --overwrite

echo "Verifying the cropped extract..."
osmium fileinfo data/osm/region.osm.pbf
