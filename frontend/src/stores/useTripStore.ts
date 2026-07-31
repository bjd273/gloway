// The whole trip state: endpoints, fetched routes, selection, status.
// Components render this and call actions — no routing logic lives in them.
//
// `submitPrompt` is the Phase 2 seam: today it's satisfied by the PromptBar's
// search flow (type -> suggestions -> setDestination); when the LLM
// conversation layer lands, only this action's body changes — the PromptBar
// surface and layout stay put.
import { create } from 'zustand'

import { FriendlyError, getRoute, type ParsedRoute, type TravelMode } from '../lib/api'
import { resolveOrigin } from '../lib/geolocate'
import { ManeuverTracker, type ManeuverProgress, stepBoundaries } from '../lib/maneuvers'
import { TurnAnnouncer } from '../lib/navAnnounce'
import { DriveController, type DriveMode, resolveDriveMode } from '../lib/navigation'
import { cumulativeMeters } from '../lib/routeProgress'
import { primeSpeech, speak } from '../lib/voice'
import { useUserStore } from './useUserStore'
import { useVoiceStore } from './useVoiceStore'

const METERS_PER_MILE = 1609.344

// The active drive's streaming controller. Non-serializable, so it lives
// outside zustand state — the store just starts/stops it.
let driveController: DriveController | null = null

// Turn guidance for the drive in progress. Module-scoped for the same reason as
// the controller: both are mutable machines, not rendered state. They are
// created together in startNavigation and MUST be torn down together — a
// tracker outliving its drive would hand the next trip a step index from the
// last one.
let maneuverTracker: ManeuverTracker | null = null
let turnAnnouncer: TurnAnnouncer | null = null
let routeMeters = 0

// How fast a simulated drive plays back. 4x by default: 1x is the honest
// speed and the right setting for checking that a turn countdown looks
// believable, but sitting through a 25-minute route in real time is not a
// development loop.
const SIM_SPEED_KEY = 'gloway:simSpeed'
export const SIM_SPEEDS = [1, 4, 8] as const
export type SimSpeed = (typeof SIM_SPEEDS)[number]

function initialSimSpeed(): SimSpeed {
  const stored = Number(localStorage.getItem(SIM_SPEED_KEY))
  return (SIM_SPEEDS as readonly number[]).includes(stored) ? (stored as SimSpeed) : 4
}

/**
 * Release everything belonging to the drive that just ended.
 *
 * One function rather than four copies, because these three have to die
 * together: a tracker that outlived its drive would report a step index from
 * the previous trip, and an announcer would think every turn had already been
 * spoken. There are four ways a drive ends (arrival, GPS failure, manual stop,
 * clearing the trip) and getting three of them right is the same bug.
 *
 * Callers set their own navPhase/position afterwards — this only owns the
 * machinery, not what the UI shows next.
 */
function endDrive(): void {
  driveController = null
  maneuverTracker = null
  turnAnnouncer = null
  routeMeters = 0
}

/** The route's average pace, for a sim that takes about as long as the drive
 * would. Falls back to the controller's own default on a route that reported
 * no usable duration. */
function simSpeedFor(route: ParsedRoute): number | undefined {
  const seconds = route.minutes * 60
  if (!(seconds > 0) || !(route.miles > 0)) return undefined
  return (route.miles * METERS_PER_MILE) / seconds
}

/**
 * Per-step speeds, so a simulated drive crawls through a neighbourhood and
 * opens up on an arterial instead of gliding at one average that matches
 * neither — which is what makes a turn countdown look plausible.
 *
 * Steps with no time (Valhalla emits zero-duration maneuvers at junctions) are
 * left out; the controller falls back to the route average for those stretches.
 */
function speedProfile(
  route: ParsedRoute,
  boundaries: number[],
): { endMeters: number; metersPerSecond: number }[] {
  return route.steps
    .map((step, i) => ({
      endMeters: boundaries[i] ?? 0,
      metersPerSecond: step.seconds > 0 ? (step.miles * METERS_PER_MILE) / step.seconds : 0,
    }))
    .filter((band) => band.metersPerSecond > 0)
}

// Persisted drive-mode choice (Live GPS vs Simulated). A device habit, not
// routing data — same manual-localStorage pattern as useVoiceStore. Order of
// precedence for the initial value: an explicit ?sim=1 (dev override) wins,
// then the user's saved toggle, then the environment default from
// resolveDriveMode (real when geolocation exists, sim otherwise).
const DRIVE_MODE_KEY = 'gloway:driveMode'

// Wall-clock start of the current drive, for the duration the completion
// endpoint scores the reward's time term against. Module-scoped like
// driveController — it's a timestamp, not rendered state.
let navStartedAt: number | null = null

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
  /** Which route the backend recommended. Kept separate from selectedIndex so
   * the per-route time delta always reads against a fixed baseline — using the
   * selection instead would reshuffle every number on every tap. */
  recommendedIndex: number
  /** Route the user is previewing (pointer/focus on its card), highlighted on
   * the map without committing the selection. Null when nothing is hovered. */
  hoveredRouteIndex: number | null
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
  /**
   * Which turn is next and how far to it. Null outside navigation.
   *
   * The single source of truth for step position. TripSheet's step highlight
   * and NavVoice's assistant context each used to re-derive this from
   * cumulative miles, in duplicated loops that disagreed at leg boundaries, and
   * neither could detect a step *transition* — so nothing could fire on one.
   */
  guidance: ManeuverProgress | null
  /** Playback speed for a simulated drive (1x, 4x, 8x). Persisted. */
  simSpeed: SimSpeed
  /** Set when a drive reaches its destination — TripPanel opens the debrief. */
  arrived: boolean
  /** Fallback origin when geolocation is unavailable — MapView keeps it fresh. */
  mapCenter: Place

  setMapCenter(p: Place): void
  setDestination(p: Place): void
  setOrigin(p: Place): void
  moveEndpoint(which: 'origin' | 'destination', p: Place): void
  selectRoute(index: number): void
  /** Preview a route without committing to it. Pass null to clear. */
  hoverRoute(index: number | null): void
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
  /** Change simulated playback speed. Takes effect mid-drive. */
  setSimSpeed(speed: SimSpeed): void
  /** Minutes elapsed on the drive just finished, for the completion endpoint's
   * time term — or null when there's nothing honest to report. */
  driveDurationMinutes(): number | null
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
        recommendedIndex: result.recommendedIndex,
        hoveredRouteIndex: null,
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
    recommendedIndex: 0,
    hoveredRouteIndex: null,
    tripId: null,
    status: 'idle',
    errorMessage: null,
    declaredIntent: null,
    mode: 'auto',
    driveMode: initialDriveMode(),
    navPhase: 'idle',
    currentPosition: null,
    navProgress: 0,
    guidance: null,
    simSpeed: initialSimSpeed(),
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

    hoverRoute(index) {
      if (index === null || (index >= 0 && index < get().routes.length)) {
        set({ hoveredRouteIndex: index })
      }
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

    setSimSpeed(speed) {
      if (get().simSpeed === speed) return
      localStorage.setItem(SIM_SPEED_KEY, String(speed))
      // The controller reads this through a closure on every tick, so a change
      // mid-drive takes hold on the next one — no restart, no lost progress.
      set({ simSpeed: speed })
    },

    driveDurationMinutes() {
      // A simulated drive runs at whatever the speed multiplier says, so its
      // wall-clock duration measures the playback setting rather than the
      // route. Reporting it would feed the reward's time term a number about
      // the UI. Only a real drive's clock means anything; sim leaves the time
      // term at its neutral default.
      if (navStartedAt === null || get().driveMode !== 'real') return null
      return (Date.now() - navStartedAt) / 60_000
    },

    startNavigation() {
      const { routes, selectedIndex, tripId, origin, navPhase } = get()
      if (navPhase === 'navigating' || !tripId) return
      const route = routes[selectedIndex]
      const coords = route?.coords ?? []
      if (coords.length < 2) return

      void driveController?.stop()
      navStartedAt = Date.now()

      // iOS Safari won't speak until speechSynthesis has been used inside a
      // user gesture, and it fails silently. This runs in the Start-drive
      // click, the one tap every drive begins with.
      primeSpeech()

      const cumulative = cumulativeMeters(coords)
      routeMeters = cumulative[cumulative.length - 1] ?? 0
      const boundaries = stepBoundaries(route.steps, cumulative)
      maneuverTracker = new ManeuverTracker(boundaries)
      turnAnnouncer = new TurnAnnouncer(route.steps, speak, () =>
        useVoiceStore.getState().voiceGuidance,
      )

      set({
        navPhase: 'navigating',
        navProgress: 0,
        guidance: null,
        arrived: false,
        currentPosition: origin,
      })
      driveController = new DriveController(
        tripId,
        coords,
        {
          onPosition: (p) => set({ currentPosition: { lng: p.lng, lat: p.lat, label: 'You' } }),
          onProgress: (fraction) => {
            // No separate handler for guidance: `fraction * routeMeters` IS the
            // distance driven, in both modes, by construction. A parallel
            // channel would be a second source for one number, free to drift.
            const guidance = maneuverTracker?.update(fraction * routeMeters) ?? null
            // Announcing here rather than in a React effect keyed on
            // `guidance`: this runs exactly once per position update, with no
            // dependence on render timing, StrictMode double-invocation or
            // subscriber ordering.
            if (guidance) turnAnnouncer?.update(guidance)
            set({ navProgress: fraction, guidance })
          },
          onArrive: () => {
            endDrive()
            set({ navPhase: 'idle', navProgress: 1, arrived: true })
          },
          // Real mode only: no fixes means no drive (and no trace to learn
          // from) — end navigation and say why instead of showing a frozen puck.
          onGpsError: (message) => {
            endDrive()
            set({
              navPhase: 'idle',
              currentPosition: null,
              navProgress: 0,
              errorMessage: message,
            })
          },
        },
        get().driveMode,
        undefined,
        {
          // The route's own average pace, so a simulated drive takes about as
          // long as the real one would at 1x.
          metersPerSecond: simSpeedFor(route),
          speedProfile: speedProfile(route, boundaries),
          speedMultiplier: () => get().simSpeed,
        },
      )
      driveController.start()
      // Note on reroutes: in real mode a post-reroute restart naturally
      // resumes from the live GPS fix (the device is the source of truth) and
      // the first fix's nearest-point projection lands navProgress mid-route
      // correctly. Only the sim replays from the route's start.
    },

    async stopNavigation() {
      const controller = driveController
      endDrive()
      if (get().navPhase === 'navigating') {
        set({ navPhase: 'idle', currentPosition: null, navProgress: 0, guidance: null })
      }
      // Await the final flush so a caller that completes the trip next does so
      // with the whole trace already server-side (see DriveController.stop).
      await controller?.stop()
    },

    armReroute() {
      reArmAfterReroute = true
    },

    clearArrived() {
      set({ arrived: false })
    },

    clearTrip() {
      driveController?.stop()
      endDrive()
      set({
        origin: null,
        destination: null,
        stops: [],
        routes: [],
        selectedIndex: 0,
        recommendedIndex: 0,
        hoveredRouteIndex: null,
        tripId: null,
        status: 'idle',
        errorMessage: null,
        declaredIntent: null,
        mode: 'auto',
        navPhase: 'idle',
        currentPosition: null,
        navProgress: 0,
        guidance: null,
        arrived: false,
      })
    },
  }
})
