import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

import { useSystemTheme } from '../hooks/useSystemTheme'
import { getMapStyle, type Theme } from '../lib/mapStyles'
import { MAP_MAX_BOUNDS, REGION_CENTER } from '../lib/region'
import { ALT_LAYER, removeRouteLayers, syncRouteLayers } from '../lib/routeLayers'
import { useTripStore, type Place } from '../stores/useTripStore'

// Camera: flat for planning; buildings + a gentle tilt arrive together at
// street level. Hysteresis (enter 16.5 / leave 15.5) prevents flapping, and
// any user-initiated pitch disables the automation — the map never fights.
const PITCH_IN_ZOOM = 16.5
const PITCH_OUT_ZOOM = 15.5

function makePinElement(kind: 'origin' | 'destination' | 'stop'): HTMLDivElement {
  const el = document.createElement('div')
  el.className = `gw-pin gw-pin-${kind}`
  return el
}

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<{ origin: maplibregl.Marker | null; destination: maplibregl.Marker | null }>(
    { origin: null, destination: null },
  )
  const stopMarkersRef = useRef<maplibregl.Marker[]>([])
  const puckRef = useRef<maplibregl.Marker | null>(null)
  const autoPitchedRef = useRef(false)
  const userPitchedRef = useRef(false)
  const lastRoutesRef = useRef<unknown>(null)
  const themeRef = useRef<Theme>('light')

  const theme = useSystemTheme()
  const origin = useTripStore((s) => s.origin)
  const destination = useTripStore((s) => s.destination)
  const stops = useTripStore((s) => s.stops)
  const routes = useTripStore((s) => s.routes)
  const selectedIndex = useTripStore((s) => s.selectedIndex)
  const currentPosition = useTripStore((s) => s.currentPosition)

  // --- map construction (once) ---
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return
    themeRef.current = theme

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: getMapStyle(theme),
      center: REGION_CENTER,
      zoom: 13.5,
      pitch: 0,
      maxBounds: MAP_MAX_BOUNDS,
      canvasContextAttributes: { antialias: true }, // smoother 3D building edges
      attributionControl: { compact: true },
    })
    mapRef.current = map

    // If the tab is hidden or mid-layout at construction, MapLibre can measure
    // a stale container and skip its own observer's initial callback, leaving
    // the canvas at the 400x300 fallback. Observing ourselves and nudging
    // resize() is idempotent and closes that gap.
    const resizeObserver = new ResizeObserver(() => map.resize())
    resizeObserver.observe(containerRef.current)

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right')

    map.on('moveend', () => {
      const c = map.getCenter()
      useTripStore.getState().setMapCenter({ lng: c.lng, lat: c.lat, label: 'Map center' })
    })

    // User pitch gestures (originalEvent present) switch off auto-pitch.
    map.on('pitchstart', (e) => {
      if ((e as { originalEvent?: unknown }).originalEvent) userPitchedRef.current = true
    })
    map.on('zoomend', () => {
      if (userPitchedRef.current) return
      const zoom = map.getZoom()
      if (zoom >= PITCH_IN_ZOOM && !autoPitchedRef.current) {
        autoPitchedRef.current = true
        map.easeTo({ pitch: 45, duration: 700 })
      } else if (zoom < PITCH_OUT_ZOOM && autoPitchedRef.current) {
        autoPitchedRef.current = false
        map.easeTo({ pitch: 0, duration: 700 })
      }
    })

    // Alternate routes are clickable.
    map.on('click', ALT_LAYER, (e) => {
      const index = e.features?.[0]?.properties?.index
      if (typeof index === 'number') useTripStore.getState().selectRoute(index)
    })
    map.on('mouseenter', ALT_LAYER, () => {
      map.getCanvas().style.cursor = 'pointer'
    })
    map.on('mouseleave', ALT_LAYER, () => {
      map.getCanvas().style.cursor = ''
    })

    return () => {
      resizeObserver.disconnect()
      map.remove()
      mapRef.current = null
      markersRef.current = { origin: null, destination: null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- theme swap: keep gw- sources, rebuild basemap + gw layers ---
  useEffect(() => {
    const map = mapRef.current
    if (!map || themeRef.current === theme) return
    themeRef.current = theme
    map.setStyle(getMapStyle(theme), {
      transformStyle: (prev, next) => ({
        ...next,
        sources: {
          ...next.sources,
          ...Object.fromEntries(
            Object.entries(prev?.sources ?? {}).filter(([id]) => id.startsWith('gw-')),
          ),
        },
      }),
    })
    map.once('styledata', () => {
      const { routes: r, selectedIndex: i } = useTripStore.getState()
      if (r.length > 0) syncRouteLayers(map, r, i, theme)
    })
  }, [theme])

  // --- markers follow store endpoints ---
  useEffect(() => {
    syncMarker('origin', origin)
  }, [origin])
  useEffect(() => {
    syncMarker('destination', destination)
  }, [destination])

  // --- stop pins: rebuild on change (few, cheap; non-draggable v1) ---
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    for (const marker of stopMarkersRef.current) marker.remove()
    stopMarkersRef.current = stops.map((stop) =>
      new maplibregl.Marker({ element: makePinElement('stop') })
        .setLngLat([stop.lng, stop.lat])
        .addTo(map),
    )
  }, [stops])

  // --- live position puck follows currentPosition during navigation ---
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!currentPosition) {
      puckRef.current?.remove()
      puckRef.current = null
      return
    }
    if (!puckRef.current) {
      const el = document.createElement('div')
      el.className = 'gw-puck'
      puckRef.current = new maplibregl.Marker({ element: el })
        .setLngLat([currentPosition.lng, currentPosition.lat])
        .addTo(map)
    } else {
      puckRef.current.setLngLat([currentPosition.lng, currentPosition.lat])
    }
    // Keep the moving puck comfortably in view without wrenching the camera.
    map.easeTo({ center: [currentPosition.lng, currentPosition.lat], duration: 700 })
  }, [currentPosition])

  function syncMarker(kind: 'origin' | 'destination', place: Place | null) {
    const map = mapRef.current
    if (!map) return
    const existing = markersRef.current[kind]
    if (!place) {
      existing?.remove()
      markersRef.current[kind] = null
      return
    }
    if (existing) {
      existing.setLngLat([place.lng, place.lat])
      return
    }
    const marker = new maplibregl.Marker({ element: makePinElement(kind), draggable: true })
      .setLngLat([place.lng, place.lat])
      .addTo(map)
    marker.on('dragend', () => {
      const { lng, lat } = marker.getLngLat()
      useTripStore.getState().moveEndpoint(kind, { lng, lat, label: 'Dropped pin' })
    })
    markersRef.current[kind] = marker
  }

  // --- routes -> glow layers + camera ---
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const apply = () => {
      if (routes.length === 0) {
        lastRoutesRef.current = null
        if (map.getLayer(ALT_LAYER)) {
          // Trip cleared: drop layers, re-enable auto-pitch, settle flat.
          removeRouteLayers(map)
          userPitchedRef.current = false
          if (autoPitchedRef.current) {
            autoPitchedRef.current = false
            map.easeTo({ pitch: 0, duration: 500 })
          }
        }
        return
      }
      syncRouteLayers(map, routes, selectedIndex, themeRef.current)
      if (lastRoutesRef.current !== routes) {
        lastRoutesRef.current = routes
        const coords = routes[selectedIndex]?.coords ?? []
        if (coords.length > 1) {
          const bounds = coords.reduce(
            (b, c) => b.extend(c as [number, number]),
            new maplibregl.LngLatBounds(coords[0], coords[0]),
          )
          map.fitBounds(bounds, {
            padding: { top: 110, bottom: 190, left: 60, right: 60 },
            maxZoom: 15.4, // stay below the auto-pitch band on fit
          })
        }
      }
    }

    if (map.isStyleLoaded()) apply()
    else map.once('load', apply)
  }, [routes, selectedIndex])

  return <div ref={containerRef} className="map-container" />
}
