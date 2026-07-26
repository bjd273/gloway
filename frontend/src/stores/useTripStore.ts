// The whole trip state: endpoints, fetched routes, selection, status.
// Components render this and call actions — no routing logic lives in them.
//
// `submitPrompt` is the Phase 2 seam: today it's satisfied by the PromptBar's
// search flow (type -> suggestions -> setDestination); when the LLM
// conversation layer lands, only this action's body changes — the PromptBar
// surface and layout stay put.
import { create } from 'zustand'

import { FriendlyError, getRoute, type ParsedRoute, type TravelMode } from '../lib/api'
import { DriveController, type DriveMode, resolveDriveMode } from '../lib/navigation'
import { inRegion } from '../lib/region'
import { useUserStore } from './useUserStore'

// The active drive's streaming controller. Non-serializable, so it lives
// outside zustand state — the store just starts/stops it.
let driveController: DriveController | null = null

// Persisted drive-mode choice (Live GPS vs Simulated). A device habit, not
// routing data — same manual-localStorage pattern as useVoiceStore. Order of
// precedence for the initial value: an explicit ?sim=1 (dev override) wins,
// then the user's saved toggle, then the environment default from
// resolveDriveMode (real when geolocation exists, sim otherwise).
const DRIVE_MODE_KEY = 'gloway:driveMode'

function initialDriveMode(): DriveMode {
  if (new URLSearchParams(window.location.search).get('sim') === '1') return 'sim'
  const stored = localStorage.getItem(DRIVE_MODE_KEY)
  if (stored === 'real' || stored === 'sim') return stored
  return resolveDriveMode()
}

// Set by the in-drive voice loop before a command that reroutes, so the drive
// resumes on the new route instead of silently ending. Consumed (and reset)
// by the next requestRoute — see armReroute + requestRoute below.
let reArmAfterReroute = false

export interface Place {
  lng: number
  lat: number
  label?: string
}

export type TripStatus = 'idle' | 'routing' | 'ready' | 'error'
export type NavPhase = 'idle' | 'navigating'

interface TripState {
  origin: Place | null
  destination: Place | null
  /** Stops to route through, in order — added by the conversation layer. */
  stops: Place[]
  routes: ParsedRoute[]
  selectedIndex: number
  tripId: string | null
  status: TripStatus
  errorMessage: string | null
  /** Per-trip intent from the conversation ("hurry" | "explore") — rides on
   * every re-route until the trip is cleared. */
  declaredIntent: string | null
  /** Travel mode — car (auto), bike, or walk. Re-routes on change. */
  mode: TravelMode
  /** How a drive is sourced: 'real' = device GPS (watchPosition), 'sim' =
   * simulated progress along the route (dev/demo, off-region). Persisted. */
  driveMode: DriveMode
  /** ACTIVE_NAVIGATION: streaming GPS along the selected route. */
  navPhase: NavPhase
  /** Live position during navigation (the moving puck). */
  currentPosition: Place | null
  /** Fraction 0..1 driven along the selected route. */
  navProgress: number
  /** Set when a drive reaches its destination — TripPanel opens the debrief. */
  arrived: boolean
  /** Fallback origin when geolocation is unavailable — MapView keeps it fresh. */
  mapCenter: Place

  setMapCenter(p: Place): void
  setDestination(p: Place): void
  setOrigin(p: Place): void
  moveEndpoint(which: 'origin' | 'destination', p: Place): void
  selectRoute(index: number): void
  /** Re-request the current trip (e.g. after a preference change). No-op
   * unless both endpoints are set. */
  refreshRoute(): void
  /** Conversation outcome: set the trip intent and re-route with it. */
  setIntent(intent: string): void
  addStop(p: Place): void
  removeStop(index: number): void
  clearStops(): void
  setMode(mode: TravelMode): void
  /** Switch how the next drive is sourced (Live GPS vs Simulated). */
  setDriveMode(mode: DriveMode): void
  /** Begin streaming the drive along the selected route. */
  startNavigation(): void
  /** Stop streaming (manual "Arrive" or trip cleared). */
  stopNavigation(): void
  /** Voice loop: resume the drive on the next reroute (see reArmAfterReroute). */
  armReroute(): void
  /** TripPanel consumes the `arrived` flag after opening the debrief. */
  clearArrived(): void
  clearTrip(): void
}

/** Resolve a starting point: user's location if allowed *and* inside the
 * routable region, else the current map center. Never nags for permission —
 * a denied/slow geolocation silently falls back. */
function resolveOrigin(mapCenter: Place): Promise<Place> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(mapCenter)
    const fallback = setTimeout(() => resolve(mapCenter), 3000)
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        clearTimeout(fallback)
        if (inRegion(coords.latitude, coords.longitude)) {
          resolve({ lat: coords.latitude, lng: coords.longitude, label: 'Current location' })
        } else {
          resolve(mapCenter)
        }
      },
      () => {
        clearTimeout(fallback)
        resolve(mapCenter)
      },
      { timeout: 2500, maximumAge: 60_000 },
    )
  })
}

export const useTripStore = create<TripState>((set, get) => {
  async function requestRoute(): Promise<void> {
    const { origin, destination } = get()
    if (!origin || !destination) return
    // A re-route replaces the geometry the drive is following — end any live
    // navigation rather than let the puck track a stale line.
    const wasNavigating = get().navPhase === 'navigating'
    if (wasNavigating) get().stopNavigation()
    set({ status: 'routing', errorMessage: null })
    try {
      const result = await getRoute({
        origin,
        destination,
        userId: useUserStore.getState().userId,
        intent: get().declaredIntent,
        waypoints: get().stops,
        mode: get().mode,
      })
      set({
        routes: result.routes,
        selectedIndex: result.recommendedIndex,
        tripId: result.tripId,
        status: 'ready',
      })
      // If a mid-drive voice command triggered this reroute, pick the drive
      // back up on the fresh route. (With the simulated DriveController this
      // replays from the route's start; real watchPosition GPS would resume
      // from the live position instead.)
      if (wasNavigating && reArmAfterReroute) get().startNavigation()
    } catch (error) {
      set({
        status: 'error',
        errorMessage:
          error instanceof FriendlyError ? error.message : 'Something went sideways — try again.',
        // Keep any previously drawn routes on screen; the error banner
        // explains why the latest change didn't take.
      })
    } finally {
      reArmAfterReroute = false
    }
  }

  return {
    origin: null,
    destination: null,
    stops: [],
    routes: [],
    selectedIndex: 0,
    tripId: null,
    status: 'idle',
    errorMessage: null,
    declaredIntent: null,
    mode: 'auto',
    driveMode: initialDriveMode(),
    navPhase: 'idle',
    currentPosition: null,
    navProgress: 0,
    arrived: false,
    mapCenter: { lng: -97.11, lat: 32.735, label: 'Map center' },

    setMapCenter(p) {
      set({ mapCenter: p })
    },

    setDestination(p) {
      set({ destination: p })
      const { origin, mapCenter } = get()
      if (origin) {
        void requestRoute()
      } else {
        void resolveOrigin(mapCenter).then((resolved) => {
          set({ origin: resolved })
          void requestRoute()
        })
      }
    },

    setOrigin(p) {
      set({ origin: p })
      if (get().destination) void requestRoute()
    },

    moveEndpoint(which, p) {
      set(which === 'origin' ? { origin: p } : { destination: p })
      void requestRoute()
    },

    selectRoute(index) {
      if (index >= 0 && index < get().routes.length) set({ selectedIndex: index })
    },

    refreshRoute() {
      if (get().origin && get().destination) void requestRoute()
    },

    setIntent(intent) {
      set({ declaredIntent: intent })
      get().refreshRoute()
    },

    addStop(p) {
      set({ stops: [...get().stops, p] })
      get().refreshRoute()
    },

    removeStop(index) {
      set({ stops: get().stops.filter((_, i) => i !== index) })
      get().refreshRoute()
    },

    clearStops() {
      if (get().stops.length === 0) return
      set({ stops: [] })
      get().refreshRoute()
    },

    setMode(mode) {
      if (get().mode === mode) return
      set({ mode })
      get().refreshRoute()
    },

    setDriveMode(mode) {
      if (get().driveMode === mode) return
      localStorage.setItem(DRIVE_MODE_KEY, mode)
      set({ driveMode: mode })
    },

    startNavigation() {
      const { routes, selectedIndex, tripId, origin, navPhase } = get()
      if (navPhase === 'navigating' || !tripId) return
      const coords = routes[selectedIndex]?.coords ?? []
      if (coords.length < 2) return

      driveController?.stop()
      set({ navPhase: 'navigating', navProgress: 0, arrived: false, currentPosition: origin })
      driveController = new DriveController(tripId, coords, {
        onPosition: (p) => set({ currentPosition: { lng: p.lng, lat: p.lat, label: 'You' } }),
        onProgress: (fraction) => set({ navProgress: fraction }),
        onArrive: () => {
          driveController = null
          set({ navPhase: 'idle', navProgress: 1, arrived: true })
        },
        // Real mode only: no fixes means no drive (and no trace to learn
        // from) — end navigation and say why instead of showing a frozen puck.
        onGpsError: (message) => {
          driveController = null
          set({ navPhase: 'idle', currentPosition: null, navProgress: 0, errorMessage: message })
        },
      },
      get().driveMode)
      driveController.start()
      // Note on reroutes: in real mode a post-reroute restart naturally
      // resumes from the live GPS fix (the device is the source of truth) and
      // the first fix's nearest-point projection lands navProgress mid-route
      // correctly. Only the sim replays from the route's start.
    },

    stopNavigation() {
      driveController?.stop()
      driveController = null
      if (get().navPhase === 'navigating') {
        set({ navPhase: 'idle', currentPosition: null, navProgress: 0 })
      }
    },

    armReroute() {
      reArmAfterReroute = true
    },

    clearArrived() {
      set({ arrived: false })
    },

    clearTrip() {
      driveController?.stop()
      driveController = null
      set({
        origin: null,
        destination: null,
        stops: [],
        routes: [],
        selectedIndex: 0,
        tripId: null,
        status: 'idle',
        errorMessage: null,
        declaredIntent: null,
        mode: 'auto',
        navPhase: 'idle',
        currentPosition: null,
        navProgress: 0,
        arrived: false,
      })
    },
  }
})
