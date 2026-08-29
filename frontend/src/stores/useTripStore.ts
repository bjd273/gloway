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
import {
  DriveController,
  type DriveMode,
  type DrivePosition,
  resolveDriveMode,
  resolveSimDetour,
  resolveSimJitter,
} from '../lib/navigation'
import { OffRouteDetector } from '../lib/offRoute'
import { cumulativeMeters } from '../lib/routeProgress'
import { stopsAhead } from '../lib/stops'
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

// Watches how far the driver is from the route and says when to reroute. Unlike
// the tracker and the announcer this one SURVIVES a reroute — it carries the
// cooldown and the rolling "how many reroutes lately" window, which is the whole
// mechanism keeping reroutes rare. Rebuilding it per route would reset the cap
// on every use of the cap.
let offRouteDetector: OffRouteDetector | null = null

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
  offRouteDetector = null
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
  /**
   * The full detail behind `currentPosition`: raw vs snapped coordinates,
   * course over ground, speed, accuracy, snap confidence.
   *
   * A sibling field rather than fatter `Place` because `Place` is also an
   * origin, a destination and a saved home — none of which have a heading.
   * Written in the same `set()` as `currentPosition`, so the two can never
   * describe different moments.
   */
  navFix: DrivePosition | null
  /** Real mode: fixes have stopped arriving (tunnel, garage). The drive is
   * still live — the puck just freezes until the signal comes back. */
  gpsSignalLost: boolean
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
  /** A reroute request is in flight. The old route is still being driven and
   * still being guided — this only says a better one has been asked for. */
  rerouting: boolean
  /** Reroutes on this trip so far. */
  rerouteCount: number
  /**
   * Automatic rerouting has stood down — too many reroutes (or failures) in too
   * short a window, which means we are either fighting the driver or the routing
   * engine is unwell. The UI offers a manual Reroute button instead of silently
   * doing nothing. Clears itself once the window slides on.
   */
  rerouteExhausted: boolean
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
  /**
   * Re-route from where the car is now, without ending the drive.
   *
   * `from` is the point to route from; omit it to use the live GPS fix, which
   * is what a manual "Reroute" button wants. Keeps the trip, the tripId and the
   * GPS trace intact, preserves the costing strategy behind the route the
   * driver chose, and leaves the old route in place if the request fails.
   */
  reroute(from?: Place): Promise<void>
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

  /**
   * Re-route after the stop list changed.
   *
   * Mid-drive this must NOT go through refreshRoute: requestRoute ends the drive
   * by design (it is replacing the geometry the puck follows), which was fine
   * when the only way to add a stop was to ask the assistant before setting off.
   * A "stop for gas" button that ends the trip is not a button anyone can use,
   * so during a drive the change goes through the reroute path instead — same
   * trip, same trace, drive uninterrupted.
   */
  function applyStopChange(): void {
    if (get().navPhase === 'navigating') void get().reroute()
    else get().refreshRoute()
  }

  /**
   * Build and start the machinery for a drive along `route`.
   *
   * One function for both the ways a drive begins — the Start button and a
   * mid-drive reroute — for exactly the reason endDrive() is one function for
   * the four ways one ends. The tracker, the announcer and the controller must
   * be built against the SAME geometry; a second copy of this is how one of them
   * ends up holding the old route's boundaries and every turn comes a step late.
   *
   * `fresh` is what separates the two callers: a new drive gets a new off-route
   * detector and arms the sim's ?detour= affordance, a reroute keeps the
   * detector (it carries the cooldown and the rate cap) and must not detour
   * again on the route it was just given.
   */
  function beginDrive(route: ParsedRoute, tripId: string, fresh: boolean): void {
    const coords = route.coords
    const cumulative = cumulativeMeters(coords)
    routeMeters = cumulative[cumulative.length - 1] ?? 0
    const boundaries = stepBoundaries(route.steps, cumulative)
    maneuverTracker = new ManeuverTracker(boundaries)
    turnAnnouncer = new TurnAnnouncer(route.steps, speak, () =>
      useVoiceStore.getState().voiceGuidance,
    )
    if (fresh || !offRouteDetector) offRouteDetector = new OffRouteDetector(Date.now())

    driveController = new DriveController(
      tripId,
      coords,
      {
        // Both written in one set(): `currentPosition` stays the simple
        // {lng,lat} compatibility surface everything already reads, and
        // `navFix` carries what the camera and the puck arrow need. Writing
        // them together is what stops the two describing different moments.
        onPosition: (p) => {
          set({ currentPosition: { lng: p.lng, lat: p.lat, label: 'You' }, navFix: p })
          // Off-route detection rides the position channel because that is where
          // the projection already happened — no second pass over the geometry,
          // and no second opinion about where the driver is. `p.fraction *
          // routeMeters` is the distance driven by construction, the same
          // identity onProgress relies on below.
          const verdict = offRouteDetector?.update({
            offRouteMeters: p.offRouteMeters,
            snapConfidence: p.snapConfidence,
            rawLng: p.rawLng,
            rawLat: p.rawLat,
            metersDriven: p.fraction * routeMeters,
            routeMeters,
            gpsSignalLost: get().gpsSignalLost,
            at: p.at,
          })
          if (verdict) void get().reroute(verdict)
        },
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
          set({ navPhase: 'idle', navProgress: 1, arrived: true, rerouting: false })
        },
        // Real mode only: no fixes means no drive (and no trace to learn
        // from) — end navigation and say why instead of showing a frozen puck.
        onGpsError: (message) => {
          endDrive()
          set({
            navPhase: 'idle',
            currentPosition: null,
            navFix: null,
            navProgress: 0,
            rerouting: false,
            errorMessage: message,
          })
        },
        // A tunnel or a parking garage, not a dead drive. The puck freezes
        // where it was and the banner says so; the watch keeps retrying and
        // this flips back on the next good fix.
        onGpsSignal: (lost) => set({ gpsSignalLost: lost }),
      },
      get().driveMode,
      undefined,
      {
        // The route's own average pace, so a simulated drive takes about as
        // long as the real one would at 1x.
        metersPerSecond: simSpeedFor(route),
        speedProfile: speedProfile(route, boundaries),
        speedMultiplier: () => get().simSpeed,
        jitterMeters: resolveSimJitter(),
        // Only on a fresh drive. ?detour= exists to produce one wrong turn to
        // reroute away from; re-arming it on the replacement route would leave
        // at the same mark again and loop forever.
        detourMeters: fresh ? resolveSimDetour() : 0,
      },
    )
    driveController.start()
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
    navFix: null,
    gpsSignalLost: false,
    navProgress: 0,
    guidance: null,
    rerouting: false,
    rerouteCount: 0,
    rerouteExhausted: false,
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
      applyStopChange()
    },

    removeStop(index) {
      set({ stops: get().stops.filter((_, i) => i !== index) })
      applyStopChange()
    },

    clearStops() {
      if (get().stops.length === 0) return
      set({ stops: [] })
      applyStopChange()
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

      set({
        navPhase: 'navigating',
        navProgress: 0,
        navFix: null,
        gpsSignalLost: false,
        guidance: null,
        arrived: false,
        rerouting: false,
        rerouteCount: 0,
        rerouteExhausted: false,
        currentPosition: origin,
      })
      beginDrive(route, tripId, true)
    },

    async reroute(from) {
      const { destination, tripId, routes, selectedIndex, navPhase, rerouting, navFix } = get()
      if (navPhase !== 'navigating' || !tripId || !destination || rerouting) return
      // The raw fix, never the snapped one. The whole premise of a reroute is
      // that the two have diverged and the raw one is the truth.
      const start =
        from ??
        (navFix ? { lng: navFix.rawLng, lat: navFix.rawLat } : null) ??
        get().currentPosition ??
        get().origin
      if (!start) return

      set({ rerouting: true })
      // speak() doesn't consult the mute — TurnAnnouncer does, through its own
      // enabled() closure — so this has to check it here.
      if (useVoiceStore.getState().voiceGuidance) speak('Rerouting', 'turn')

      const current = routes[selectedIndex]
      // Without this, a reroute sends the driver back to the coffee shop they
      // already stopped at — and keeps doing it on every subsequent reroute.
      const remaining = stopsAhead(get().stops, current?.coords ?? [], get().navProgress)

      try {
        const result = await getRoute({
          origin: start,
          destination,
          userId: useUserStore.getState().userId,
          intent: get().declaredIntent,
          waypoints: remaining,
          mode: get().mode,
          // What preserves the driver's choice. Someone who picked "Calmer
          // roads" over the fastest way did not change their mind by missing a
          // turn, and silently putting them back on the highway is the app
          // overruling them at the moment they are least able to argue.
          strategy: current?.strategy,
          // Which route we were actually driving. Selection never reached the
          // server, so without this it would score the trace up to here against
          // whichever route it recommended rather than the one we took.
          selectedIndex,
          rerouteOf: tripId,
        })

        // The drive can end while the request is in flight — arrival, the
        // Arrive button, a cleared trip. Landing a fresh route on a finished
        // drive would restart one the user just stopped.
        if (get().navPhase !== 'navigating' || get().tripId !== tripId) {
          set({ rerouting: false })
          return
        }
        const route = result.routes[result.recommendedIndex]
        if (!route || route.coords.length < 2) {
          throw new FriendlyError('No usable way from here — still on the old route.')
        }

        // Stop the old controller (and flush its tail) before the new one
        // starts, so two of them never stream to the same trip at once.
        await driveController?.stop()

        // navPhase and currentPosition are deliberately untouched: the car has
        // not moved and the drive has not ended, so the banner must not blank
        // and the puck must not jump. MapView's routes effect already refuses to
        // refit the camera while navigatingRef is set, which is what keeps this
        // from ripping the view off the driver.
        set({
          routes: result.routes,
          selectedIndex: result.recommendedIndex,
          recommendedIndex: result.recommendedIndex,
          hoveredRouteIndex: null,
          stops: remaining,
          navProgress: 0,
          guidance: null,
          errorMessage: null,
          rerouting: false,
          rerouteCount: get().rerouteCount + 1,
        })
        beginDrive(route, tripId, false)
        offRouteDetector?.noteRerouted(Date.now())
        set({ rerouteExhausted: offRouteDetector?.exhausted ?? false })
      } catch (error) {
        // Keep driving the old route. It is stale, but it is guidance, and a
        // failed request is no reason to leave someone mid-drive with none.
        offRouteDetector?.noteFailed(Date.now())
        set({
          rerouting: false,
          rerouteExhausted: offRouteDetector?.exhausted ?? false,
          errorMessage:
            error instanceof FriendlyError
              ? error.message
              : "Couldn't find a new way — still on the old route.",
        })
      }
    },

    async stopNavigation() {
      const controller = driveController
      endDrive()
      if (get().navPhase === 'navigating') {
        set({
          navPhase: 'idle',
          currentPosition: null,
          navFix: null,
          gpsSignalLost: false,
          navProgress: 0,
          guidance: null,
          rerouting: false,
        })
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
        navFix: null,
        gpsSignalLost: false,
        navProgress: 0,
        guidance: null,
        rerouting: false,
        rerouteCount: 0,
        rerouteExhausted: false,
        arrived: false,
      })
    },
  }
})
