import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import polyline from '@mapbox/polyline'
import mapStyle from './mapStyle.json'
import './index.css'

function App() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const [routeSummary, setRouteSummary] = useState<{ time: number; length: number } | null>(null)
  const [instructions, setInstructions] = useState<any[]>([])

  // Arlington Texas default coords
  const initialOrigin = { lng: -97.10, lat: 32.73 }
  const initialDestination = { lng: -97.12, lat: 32.74 }

  const originMarker = useRef<maplibregl.Marker | null>(null)
  const destMarker = useRef<maplibregl.Marker | null>(null)

  useEffect(() => {
    if (map.current || !mapContainer.current) return

    // MapLibre's tile fetches run inside a Blob-URL worker, which can't
    // resolve relative tile URL templates — they must be absolute. The style
    // JSON itself stays environment-agnostic; we resolve against the current
    // origin here so this works unmodified in dev, staging, and prod.
    const style = structuredClone(mapStyle) as maplibregl.StyleSpecification
    const tileSource = style.sources.openmaptiles as maplibregl.VectorSourceSpecification
    tileSource.tiles = tileSource.tiles?.map((t) => `${window.location.origin}${t}`)

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style,
      center: [-97.11, 32.735],
      zoom: 15,
      pitch: 55,      // tilt the camera so extruded buildings are visible
      bearing: -17,
      antialias: true, // smoother edges on 3D building extrusions
    })

    // Let users tilt/rotate to explore the 3D view.
    map.current.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
      'top-right',
    )

    const originEl = document.createElement('div')
    originEl.className = 'marker-origin'
    originMarker.current = new maplibregl.Marker({ element: originEl, draggable: true })
      .setLngLat([initialOrigin.lng, initialOrigin.lat])
      .addTo(map.current)

    const destEl = document.createElement('div')
    destEl.className = 'marker-destination'
    destMarker.current = new maplibregl.Marker({ element: destEl, draggable: true })
      .setLngLat([initialDestination.lng, initialDestination.lat])
      .addTo(map.current)

    originMarker.current.on('dragend', fetchRoute)
    destMarker.current.on('dragend', fetchRoute)

    map.current.on('load', () => {
      fetchRoute()
    })

  }, [])

  const fetchRoute = async () => {
    if (!originMarker.current || !destMarker.current || !map.current) return

    const origin = originMarker.current.getLngLat()
    const dest = destMarker.current.getLngLat()

    const payload = {
      locations: [
        { lat: origin.lat, lon: origin.lng },
        { lat: dest.lat, lon: dest.lng }
      ],
      costing: "auto",
      directions_options: {
        units: "miles"
      }
    }

    try {
      const response = await fetch('/api/valhalla/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        console.error('Routing failed')
        return
      }

      const data = await response.json()
      
      const trip = data.trip
      if (!trip || !trip.legs || trip.legs.length === 0) return

      const leg = trip.legs[0]
      setRouteSummary({
        time: trip.summary.time,
        length: trip.summary.length
      })
      setInstructions(leg.maneuvers)

      const shape = leg.shape
      const decoded = polyline.decode(shape, 6) // Valhalla uses precision 6 by default

      // Convert to GeoJSON coordinates (lon, lat)
      const coordinates = decoded.map((c: any) => [c[1], c[0]])

      const geojson: any = {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: coordinates
        }
      }

      const sourceId = 'route-source'
      const layerId = 'route-layer'

      if (map.current.getSource(sourceId)) {
        ;(map.current.getSource(sourceId) as maplibregl.GeoJSONSource).setData(geojson)
      } else {
        map.current.addSource(sourceId, {
          type: 'geojson',
          data: geojson
        })
        map.current.addLayer({
          id: layerId,
          type: 'line',
          source: sourceId,
          layout: {
            'line-join': 'round',
            'line-cap': 'round'
          },
          paint: {
            'line-color': '#3b82f6',
            'line-width': 6,
            'line-opacity': 0.8
          }
        })
      }

      // Fit bounds to route
      const bounds = coordinates.reduce((b: maplibregl.LngLatBounds, c: any) => {
        return b.extend(c)
      }, new maplibregl.LngLatBounds(coordinates[0], coordinates[0]))

      map.current.fitBounds(bounds, { padding: 50 })

    } catch (err) {
      console.error(err)
    }
  }

  const formatTime = (seconds: number) => {
    const m = Math.round(seconds / 60)
    return `${m} min`
  }

  return (
    <>
      <div ref={mapContainer} className="map-container" />
      <div className="floating-panel">
        <h1>Gloway Route Planner</h1>
        <p className="drag-instruction">Drag the Green (Origin) and Red (Destination) markers to update the route.</p>

        {routeSummary && (
          <div className="summary-card">
            <p><strong>Distance:</strong> {routeSummary.length.toFixed(2)} miles</p>
            <p><strong>Est. Time:</strong> {formatTime(routeSummary.time)}</p>
          </div>
        )}

        {instructions.length > 0 && (
          <ul className="instruction-list">
            {instructions.map((inst, idx) => (
              <li key={idx} className="instruction-item">
                <span className="instruction-text">{inst.instruction}</span>
                <span className="instruction-meta">
                  {inst.length.toFixed(2)} mi &bull; {formatTime(inst.time)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

export default App
