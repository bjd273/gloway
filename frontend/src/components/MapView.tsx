import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

import { useSystemTheme } from '../hooks/useSystemTheme'
import { LOCATION_FAILURE_MESSAGE, requestCurrentLocation } from '../lib/geolocate'
import { getMapStyle, type Theme } from '../lib/mapStyles'
import { MAP_MAX_BOUNDS, REGION_CENTER } from '../lib/region'
import { ALT_LAYER, removeRouteLayers, setRouteProgress, syncRouteLayers } from '../lib/routeLayers'
import { bearingAtFraction, lengthFractions } from '../lib/routeProgress'
import { useSheetStore } from '../stores/useSheetStore'
import { useTripStore, type Place } from '../stores/useTripStore'

// Camera: flat for planning; buildings + a gentle tilt arrive together at
// street level. Hysteresis (enter 16.5 / leave 15.5) prevents flapping, and
// any user-initiated pitch disables the automation — the map never fights.
const PITCH_IN_ZOOM = 16.5
const PITCH_OUT_ZOOM = 15.5

// Driving camera. Deliberately a different mode, not a nudge of the planning
// one: planning is a flat overview you read, driving is a forward-looking shot
// down the road you're on. Zoom is close enough to distinguish a turn lane;
// pitch pushes the horizon up so the next junction is on screen before you
// reach it; bearing tracks the route so "ahead" is always up.
const NAV_ZOOM = 16.8
const NAV_PITCH = 55

// The basemap's POI label layers, from mapStyle{Light,Dark}.json. Tapping one
// sets it as the destination. Kept in sync by hand with the style — if a layer
// is renamed there, the click silently stops working for that rank, so the
// names are asserted at map load (see the warning below).
const POI_LAYERS = ['poi_r20', 'poi_r7', 'poi_r1', 'poi_transit']
// Shorter than the tightest gap between position updates (sim ticks at 800ms,
// real fixes are throttled to 1000ms) so each ease lands before the next one
// starts. Overlapping eases read as the camera drifting rather than tracking.
const NAV_EASE_MS = 650

// The locate crosshair, as a path so the two places that draw it — the JSX
// pill and the imperative MapLibre control — cannot drift apart.
const CROSSHAIR_PATH =
  'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm8.94 2.5a9.01 9.01 0 0 0-7.94-7.94V1h-2v2.06A9.01 9.01 0 0 0 3.06 11H1v2h2.06A9.01 9.01 0 0 0 11 20.94V23h2v-2.06A9.01 9.01 0 0 0 20.94 13H23v-2h-2.06ZM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z'

/**
 * Keep the fitted route clear of the chrome that's actually on screen.
 *
 * The old fixed {top:110, bottom:190} was tuned to a top search bar and a
 * bottom trip panel, neither of which exists now. Top only has to clear the
 * corner-anchored wordmark and gear; bottom tracks the sheet's measured height.
 */
function fitPadding(map: maplibregl.Map): maplibregl.PaddingOptions {
  const height = map.getContainer().clientHeight
  if (window.matchMedia('(min-width: 768px)').matches) {
    // Desktop puts the sheet in the LEFT corner. The old code applied phone
    // padding here, so routes fitted behind the panel.
    return { top: 76, bottom: 40, left: 390, right: 60 }
  }
  const sheet = useSheetStore.getState().heightPx
  return {
    top: 76,
    // Clamped: at 'full' the sheet is 88dvh and an unclamped bottom padding
    // would leave no room to fit anything into.
    bottom: Math.min(sheet + 24, Math.round(height * 0.45)),
    left: 60,
    right: 60,
  }
}

/**
 * Where the puck sits while driving.
 *
 * Padding shifts the point the camera centres on within the viewport, so a
 * large TOP padding drops the puck into the lower part of the screen and
 * spends the rest on the road ahead — the whole reason to tilt the camera.
 * Centring the puck instead wastes half the screen on road already driven.
 * Bottom padding still tracks the sheet so the puck never hides under it, and
 * the top adds the turn banner's measured height — without that the banner
 * covers the road ahead, which is the part of the map the tilt exists for.
 */
function navPadding(map: maplibregl.Map): maplibregl.PaddingOptions {
  const height = map.getContainer().clientHeight
  const banner = useSheetStore.getState().bannerPx
  // Clamped so a tall banner on a short viewport can't push top + bottom past
  // the screen, which MapLibre resolves by ignoring the padding entirely.
  const ahead = Math.min(Math.round(height * 0.42) + banner, Math.round(height * 0.6))
  if (window.matchMedia('(min-width: 768px)').matches) {
    return { top: ahead, bottom: 40, left: 390, right: 60 }
  }
  const sheet = useSheetStore.getState().heightPx
  return { top: ahead, bottom: Math.min(sheet + 24, ahead), left: 24, right: 24 }
}

function makePinElement(kind: 'origin' | 'destination' | 'stop'): HTMLDivElement {
  const el = document.createElement('div')
  el.className = `gw-pin gw-pin-${kind}`
  return el
}

/** The live-position marker: a dot, with an arrow that appears once we know
 * which way the driver is pointing. */
function makePuckElement(): HTMLDivElement {
  const el = document.createElement('div')
  el.className = 'gw-puck'
  el.appendChild(document.createElement('i')).className = 'gw-puck-arrow'
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
  const deviceMarkerRef = useRef<maplibregl.Marker | null>(null)
  const autoPitchedRef = useRef(false)
  const userPitchedRef = useRef(false)
  const lastRoutesRef = useRef<unknown>(null)
  const themeRef = useRef<Theme>('light')
  // Whether the driving camera is currently tracking the puck. A ref, not
  // state, because the position effect reads it every fix and must see the
  // value the gesture handler just wrote, not the one from last render.
  const followRef = useRef(false)
  const navigatingRef = useRef(false)
  // The locate control is built once, imperatively, and outlives every render —
  // so the two directions of traffic go through refs. The handler ref is
  // reassigned each render so the control's listener always calls the current
  // closure; the button ref lets an effect push label/busy state back out.
  const locateHandlerRef = useRef<() => void>(() => {})
  const locateButtonRef = useRef<HTMLButtonElement | null>(null)

  // Mirrors followRef for rendering the re-centre button only.
  const [followSuspended, setFollowSuspended] = useState(false)
  // Where the device says it is, when the user has asked. Deliberately local
  // rather than in the trip store: `currentPosition` there means "live position
  // during a drive", and a browsing fix written into it would drive the nav
  // camera and the heading puck off a position that isn't from a drive at all.
  const [deviceLocation, setDeviceLocation] = useState<{ lng: number; lat: number } | null>(null)
  const [locating, setLocating] = useState(false)
  const [locateError, setLocateError] = useState<string | null>(null)

  const theme = useSystemTheme()
  const origin = useTripStore((s) => s.origin)
  const destination = useTripStore((s) => s.destination)
  const stops = useTripStore((s) => s.stops)
  const routes = useTripStore((s) => s.routes)
  const selectedIndex = useTripStore((s) => s.selectedIndex)
  const hoveredRouteIndex = useTripStore((s) => s.hoveredRouteIndex)
  const snap = useSheetStore((s) => s.snap)
  const currentPosition = useTripStore((s) => s.currentPosition)
  const navPhase = useTripStore((s) => s.navPhase)
  const navProgress = useTripStore((s) => s.navProgress)

  // Cumulative length fractions for the selected route, rebuilt only when the
  // geometry itself changes — not on every fix, which is when they're read.
  const selectedCoords = routes[selectedIndex]?.coords
  const fractions = useMemo(() => lengthFractions(selectedCoords ?? []), [selectedCoords])

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

    // Locate joins the same corner as its own group. Order is free: MapLibre
    // does `insertBefore(el, firstChild)` for bottom corners, and the corner
    // stacks floated blocks top-to-bottom, so adding this AFTER the navigation
    // control is what puts it above the zoom buttons. CSS then closes the gap
    // between the two groups so they read as one toolbar.
    map.addControl(
      {
        onAdd: () => {
          const group = document.createElement('div')
          group.className = 'maplibregl-ctrl maplibregl-ctrl-group gw-ctrl-locate'
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'gw-locate-button'
          // Static literal, no interpolation — the same path the pill renders.
          button.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="${CROSSHAIR_PATH}"/></svg>`
          button.addEventListener('click', () => locateHandlerRef.current())
          group.appendChild(button)
          locateButtonRef.current = button
          return group
        },
        onRemove: () => {
          locateButtonRef.current = null
        },
      },
      'bottom-right',
    )

    map.on('moveend', () => {
      const c = map.getCenter()
      useTripStore.getState().setMapCenter({ lng: c.lng, lat: c.lat, label: 'Map center' })
    })

    // User pitch gestures (originalEvent present) switch off auto-pitch.
    map.on('pitchstart', (e) => {
      if ((e as { originalEvent?: unknown }).originalEvent) userPitchedRef.current = true
    })
    map.on('zoomend', () => {
      // The driving camera owns pitch while a drive is running. Without this
      // the two automations fight: easing to NAV_ZOOM crosses PITCH_IN_ZOOM,
      // which would fire this handler and yank pitch to 45 mid-drive.
      if (navigatingRef.current || userPitchedRef.current) return
      const zoom = map.getZoom()
      if (zoom >= PITCH_IN_ZOOM && !autoPitchedRef.current) {
        autoPitchedRef.current = true
        map.easeTo({ pitch: 45, duration: 700 })
      } else if (zoom < PITCH_OUT_ZOOM && autoPitchedRef.current) {
        autoPitchedRef.current = false
        map.easeTo({ pitch: 0, duration: 700 })
      }
    })

    // Touching the map mid-drive hands the camera back to the driver — a
    // passenger checking what's two blocks over should not be fought for it.
    // `originalEvent` is the tell: our own easeTo fires the same events
    // without one, so this can't trip on the camera we're driving ourselves.
    const releaseFollow = (e: { originalEvent?: unknown }) => {
      if (!navigatingRef.current || !followRef.current || !e.originalEvent) return
      followRef.current = false
      setFollowSuspended(true)
    }
    map.on('dragstart', releaseFollow)
    map.on('zoomstart', releaseFollow)
    map.on('rotatestart', releaseFollow)

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

    // Tapping a place label routes to it. The map draws thousands of labels
    // the search index may spell differently or not carry at all, and until now
    // the only way to pick one was to type its name and hope — a driver hit
    // exactly that. Reading the destination straight off the feature under the
    // finger sidesteps the question of whether the two datasets agree.
    map.on('click', POI_LAYERS, (e) => {
      // Not mid-drive: the map is the road ahead then, and a stray thumb should
      // not replace where you're going.
      if (navigatingRef.current) return
      const feature = e.features?.[0]
      if (!feature || feature.geometry.type !== 'Point') return
      const [lng, lat] = feature.geometry.coordinates as [number, number]
      const name = feature.properties?.name
      useTripStore.getState().setDestination({
        lng,
        lat,
        label: typeof name === 'string' && name ? name : 'Dropped pin',
      })
    })
    map.on('mouseenter', POI_LAYERS, () => {
      if (!navigatingRef.current) map.getCanvas().style.cursor = 'pointer'
    })
    map.on('mouseleave', POI_LAYERS, () => {
      map.getCanvas().style.cursor = ''
    })

    // A renamed layer in the style would make tap-to-route quietly stop working
    // for that rank, with nothing to see. Say so once at load instead.
    map.once('load', () => {
      const missing = POI_LAYERS.filter((id) => !map.getLayer(id))
      if (missing.length) {
        console.warn(`[MapView] POI layers missing from the style: ${missing.join(', ')} — tapping those labels will not set a destination.`)
      }
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
      const { routes: r, selectedIndex: i, hoveredRouteIndex: h, navProgress: p } =
        useTripStore.getState()
      if (r.length > 0) syncRouteLayers(map, r, i, theme, h, p)
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

  // --- the driven part of the route greys out behind the puck ---
  // Its own effect, deliberately: progress changes ~1Hz for the whole drive,
  // and this is a paint-property write on three layers — no source updates, no
  // layer rebuilds, nothing that would make that rate expensive.
  useEffect(() => {
    const map = mapRef.current
    if (map) setRouteProgress(map, themeRef.current, navProgress)
  }, [navProgress])

  // --- live position puck + driving camera ---
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!currentPosition) {
      puckRef.current?.remove()
      puckRef.current = null
      return
    }

    const heading = bearingAtFraction(selectedCoords ?? [], fractions, navProgress)

    if (!puckRef.current) {
      puckRef.current = new maplibregl.Marker({
        element: makePuckElement(),
        // Both aligned to the map so the arrow lies flat on the road surface
        // under a tilted camera, the way a painted lane arrow would, instead
        // of standing up like a sticker on the screen.
        rotationAlignment: 'map',
        pitchAlignment: 'map',
      })
        .setLngLat([currentPosition.lng, currentPosition.lat])
        .addTo(map)
    } else {
      puckRef.current.setLngLat([currentPosition.lng, currentPosition.lat])
    }
    // Until there's a direction to show, it stays a plain dot — an arrow
    // pointing an arbitrary way is worse than no arrow.
    puckRef.current.getElement().classList.toggle('gw-puck-heading', heading !== null)
    puckRef.current.setRotation(heading ?? 0)

    if (navPhase !== 'navigating' || !followRef.current) return
    map.easeTo({
      center: [currentPosition.lng, currentPosition.lat],
      bearing: heading ?? map.getBearing(),
      zoom: NAV_ZOOM,
      pitch: NAV_PITCH,
      padding: navPadding(map),
      duration: NAV_EASE_MS,
    })
  }, [currentPosition, navPhase, navProgress, selectedCoords, fractions])

  // --- entering / leaving the drive ---
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const wasNavigating = navigatingRef.current
    navigatingRef.current = navPhase === 'navigating'
    if (navPhase === 'navigating') {
      followRef.current = true
      setFollowSuspended(false)
      return
    }
    // Nothing to unwind if no drive ever started — this effect also runs on
    // mount, and refitting there would fight the routes effect's own fit.
    if (!wasNavigating) return
    // Drive over. Unwind the driving camera and frame the whole trip again:
    // the debrief opens onto "here's the drive you just did", not onto a
    // rooftop at 16.8 with the map rotated to whatever the last turn was.
    followRef.current = false
    setFollowSuspended(false)
    autoPitchedRef.current = false
    userPitchedRef.current = false
    const coords = useTripStore.getState().routes[useTripStore.getState().selectedIndex]?.coords
    if (coords && coords.length > 1) {
      const bounds = coords.reduce(
        (b, c) => b.extend(c as [number, number]),
        new maplibregl.LngLatBounds(coords[0], coords[0]),
      )
      map.fitBounds(bounds, {
        padding: fitPadding(map),
        maxZoom: 15.4,
        bearing: 0,
        pitch: 0,
        duration: 900,
      })
    } else {
      map.easeTo({ bearing: 0, pitch: 0, duration: 700 })
    }
  }, [navPhase])

  function recenter() {
    const map = mapRef.current
    const position = useTripStore.getState().currentPosition
    if (!map || !position) return
    followRef.current = true
    setFollowSuspended(false)
    map.easeTo({
      center: [position.lng, position.lat],
      bearing: bearingAtFraction(selectedCoords ?? [], fractions, navProgress) ?? map.getBearing(),
      zoom: NAV_ZOOM,
      pitch: NAV_PITCH,
      padding: navPadding(map),
      duration: 600,
    })
  }

  // --- "you are here" dot, outside navigation ---
  // Hidden during a drive: the heading puck is the authority then, and two dots
  // on the same road is a question the user has to stop and answer.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!deviceLocation || navPhase === 'navigating') {
      deviceMarkerRef.current?.remove()
      deviceMarkerRef.current = null
      return
    }
    if (!deviceMarkerRef.current) {
      const el = document.createElement('div')
      // The drive puck's element, minus the gw-puck-heading class that reveals
      // its arrow — the same dot, making no claim about which way you face.
      el.className = 'gw-puck'
      deviceMarkerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat([deviceLocation.lng, deviceLocation.lat])
        .addTo(map)
    } else {
      deviceMarkerRef.current.setLngLat([deviceLocation.lng, deviceLocation.lat])
    }
  }, [deviceLocation, navPhase])

  // A failed locate is worth saying once, not until dismissed — the map is
  // still usable and a permanent banner over it would be the bigger problem.
  useEffect(() => {
    if (!locateError) return
    const timer = setTimeout(() => setLocateError(null), 5000)
    return () => clearTimeout(timer)
  }, [locateError])

  // The control's button lives outside React's tree, so its state is pushed
  // rather than rendered. Cheap, and only on the two things that change.
  useEffect(() => {
    const button = locateButtonRef.current
    if (!button) return
    button.setAttribute(
      'aria-label',
      navPhase === 'navigating' ? 'Re-center on the drive' : 'Show my location',
    )
    button.setAttribute('aria-busy', String(locating))
    button.classList.toggle('gw-locate-button--busy', locating)
  }, [navPhase, locating])

  /**
   * The persistent locate control.
   *
   * Mid-drive it does exactly what the "Re-center" pill does, so the button is
   * never a dead control while the thing it names is precisely what the user
   * wants. Otherwise it asks the device where it is and goes there.
   */
  async function locateMe() {
    const map = mapRef.current
    if (!map || locating) return
    if (navigatingRef.current) {
      recenter()
      return
    }
    setLocating(true)
    setLocateError(null)
    // requestCurrentLocation, not resolveOrigin: this is an explicit tap, so a
    // denial has to be reported rather than silently substituting the map
    // centre — which would send the camera to where it already is and look
    // like the button was broken.
    const result = await requestCurrentLocation()
    setLocating(false)
    if (!result.ok) {
      setLocateError(LOCATION_FAILURE_MESSAGE[result.reason])
      return
    }
    setDeviceLocation({ lng: result.place.lng, lat: result.place.lat })
    map.easeTo({
      center: [result.place.lng, result.place.lat],
      // Zoom in to street level if we're further out, but never pull a
      // closer view back out — the user may have zoomed in deliberately.
      zoom: Math.max(map.getZoom(), 15.5),
      padding: fitPadding(map),
      duration: 700,
    })
  }

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
      syncRouteLayers(
        map,
        routes,
        selectedIndex,
        themeRef.current,
        hoveredRouteIndex,
        // Read live rather than taken as a dep: a rebuild triggered by
        // selection or hover must not relight a route being driven, but this
        // effect must not re-run (and re-fit) on every GPS fix either.
        useTripStore.getState().navProgress,
      )
      if (lastRoutesRef.current !== routes) {
        lastRoutesRef.current = routes
        const coords = routes[selectedIndex]?.coords ?? []
        // A mid-drive reroute lands here; refitting to the whole route would
        // rip the camera off the driver at the exact moment they need it.
        if (coords.length > 1 && !navigatingRef.current) {
          const bounds = coords.reduce(
            (b, c) => b.extend(c as [number, number]),
            new maplibregl.LngLatBounds(coords[0], coords[0]),
          )
          map.fitBounds(bounds, {
            padding: fitPadding(map),
            maxZoom: 15.4, // stay below the auto-pitch band on fit
          })
        }
      }
    }

    if (map.isStyleLoaded()) apply()
    else map.once('load', apply)
    // hoveredRouteIndex repaints in place inside syncRouteLayers; the fitBounds
    // below is gated on the routes identity, so previewing never moves the camera.
  }, [routes, selectedIndex, hoveredRouteIndex])

  // --- keep the route clear of the sheet as it resizes ---
  // Deliberately a nudge, not a refit: refitting on every snap would wrench the
  // camera, and dragging the sheet is not a request to reframe the trip.
  useEffect(() => {
    const map = mapRef.current
    if (!map || routes.length === 0) return
    const timer = setTimeout(() => {
      // Mid-drive the puck, not the whole route, is what has to stay clear of
      // the sheet — so the nudge follows whichever camera mode is active.
      map.easeTo({
        padding: navigatingRef.current ? navPadding(map) : fitPadding(map),
        duration: 300,
      })
      // After the height transition settles, so the padding matches where the
      // sheet actually ended up.
    }, 300)
    return () => clearTimeout(timer)
  }, [snap, routes.length])

  // Kept fresh every render so the control's one-time click listener always
  // reaches the current closure over `locating` and the nav refs.
  locateHandlerRef.current = () => void locateMe()

  return (
    <>
      <div ref={containerRef} className="map-container" />

      {followSuspended && navPhase === 'navigating' && (
        // Always modified, not conditionally: this pill only exists during a
        // drive, which is exactly when the turn banner occupies the top strip.
        <button className="map-recenter map-recenter--below-banner" onClick={recenter}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
            <path fill="currentColor" d={CROSSHAIR_PATH} />
          </svg>
          Re-center
        </button>
      )}

      {/* Shares the pill's slot: that one is navigation-only and this one can
          only happen outside navigation, so they can never both be present. */}
      {locateError && (
        <div className="map-recenter map-notice" role="status">
          {locateError}
        </div>
      )}
    </>
  )
}
