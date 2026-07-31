// Everything inside the bottom sheet: search before a destination is set, then
// the trip itself. Replaces TripPanel (bottom) and the old prompt shell (top).
//
// One structural rule drives the layout: the content is ALWAYS mounted and the
// snap height only changes what's visible. Nothing is conditionally unmounted
// per snap, because NavVoice holds a WebSocket for the whole drive and
// remounting its parent would tear the socket down mid-trip.
//
//   header + summary   always visible          <- peek stops here
//   scroll region      modes, stops, routes, steps
//   actions            always visible (the primary action must be reachable at peek)
//   footer             ChatBar before a drive, NavVoice during one
import { useEffect, useState } from 'react'

import { completeTrip, FriendlyError, sendFeedback, type TravelMode } from '../lib/api'
import { rememberPlaceLabel } from '../lib/placeLabels'
import { ROUTE_COLORS } from '../lib/routeColors'
import { formatMiles, formatMinutes, routeDisplayOrder, routeLabels } from '../lib/routeSummary'
import { useSystemTheme } from '../hooks/useSystemTheme'
import { useDebriefStore } from '../stores/useDebriefStore'
import { useSheetStore } from '../stores/useSheetStore'
import { SIM_SPEEDS, type SimSpeed, useTripStore } from '../stores/useTripStore'
import { useUserStore } from '../stores/useUserStore'
import { ChatBar } from './ChatBar'
import { Debrief } from './Debrief'
import { NavVoice } from './NavVoice'
import { PlaceSearchField } from './PlaceSearchField'
import { RouteCard } from './RouteCard'

const MODES: { mode: TravelMode; icon: string; label: string }[] = [
  { mode: 'auto', icon: '🚗', label: 'Drive' },
  { mode: 'bicycle', icon: '🚲', label: 'Bike' },
  { mode: 'pedestrian', icon: '🚶', label: 'Walk' },
]

/** Cards shown before "More ways" — the recommendation plus two to weigh it against. */
const COLLAPSED_CARDS = 3

function SimSpeedChips({
  value,
  onChange,
}: {
  value: SimSpeed
  onChange: (speed: SimSpeed) => void
}) {
  return (
    <div className="trip-simspeed" role="group" aria-label="Simulation speed">
      {SIM_SPEEDS.map((speed) => (
        <button
          key={speed}
          type="button"
          className={'trip-chip' + (value === speed ? ' trip-chip--active' : '')}
          aria-pressed={value === speed}
          onClick={() => onChange(speed)}
        >
          {speed}×
        </button>
      ))}
    </div>
  )
}

export function TripSheet() {
  const routes = useTripStore((s) => s.routes)
  const selectedIndex = useTripStore((s) => s.selectedIndex)
  const recommendedIndex = useTripStore((s) => s.recommendedIndex)
  const status = useTripStore((s) => s.status)
  const errorMessage = useTripStore((s) => s.errorMessage)
  const tripId = useTripStore((s) => s.tripId)
  const stops = useTripStore((s) => s.stops)
  const mode = useTripStore((s) => s.mode)
  const origin = useTripStore((s) => s.origin)
  const destination = useTripStore((s) => s.destination)
  const driveMode = useTripStore((s) => s.driveMode)
  const setDriveMode = useTripStore((s) => s.setDriveMode)
  const navPhase = useTripStore((s) => s.navPhase)
  const navProgress = useTripStore((s) => s.navProgress)
  const guidance = useTripStore((s) => s.guidance)
  const simSpeed = useTripStore((s) => s.simSpeed)
  const setSimSpeed = useTripStore((s) => s.setSimSpeed)
  const arrived = useTripStore((s) => s.arrived)
  const selectRoute = useTripStore((s) => s.selectRoute)
  const hoverRoute = useTripStore((s) => s.hoverRoute)
  const removeStop = useTripStore((s) => s.removeStop)
  const setMode = useTripStore((s) => s.setMode)
  const setDestination = useTripStore((s) => s.setDestination)
  const startNavigation = useTripStore((s) => s.startNavigation)
  const stopNavigation = useTripStore((s) => s.stopNavigation)
  const clearArrived = useTripStore((s) => s.clearArrived)
  const clearTrip = useTripStore((s) => s.clearTrip)

  const journey = useUserStore((s) => s.journey)
  const debriefStatus = useDebriefStore((s) => s.status)
  const openDebrief = useDebriefStore((s) => s.open)
  const resetDebrief = useDebriefStore((s) => s.reset)
  const setSnap = useSheetStore((s) => s.setSnap)

  const [wrappingUp, setWrappingUp] = useState(false)
  const [note, setNote] = useState('')
  const [wrapUpError, setWrapUpError] = useState<string | null>(null)
  const [showAllRoutes, setShowAllRoutes] = useState(false)
  const theme = useSystemTheme()

  const savedPlaces = [
    { key: 'home' as const, label: 'Home', icon: '🏠', place: journey?.home_location ?? null },
    { key: 'work' as const, label: 'Work', icon: '💼', place: journey?.work_location ?? null },
  ].filter((p) => p.place)

  // A new trip shouldn't inherit the last one's expanded list.
  useEffect(() => {
    setShowAllRoutes(false)
  }, [tripId])

  // The count, not the array: snap policy only cares whether there is a choice
  // to make, and depending on `routes` would re-run the effect on every
  // identity change — including the ones a drive produces.
  const routeCount = routes.length

  // Snap policy lives here rather than in the trip store: how tall a panel is
  // has nothing to do with what the trip is.
  useEffect(() => {
    if (status === 'idle') setSnap('half')
    if (status !== 'ready') return
    // A fresh route used to always drop to peek, on the reasoning that the map
    // is the actual answer and raising the sheet to compare is one tap away.
    // That holds when there is one way to go. When there are several, the
    // choice IS the answer, and peek buried it: the cards render into the
    // clipped region, so the only route to picking one was noticing the "N
    // ways" button and tapping that first. Mid-drive stays at peek regardless
    // — a reroute while navigating must not throw the sheet over the map.
    if (routeCount > 1 && navPhase !== 'navigating') setSnap('half')
    else setSnap('peek')
  }, [status, routeCount, navPhase, setSnap])
  useEffect(() => {
    if (navPhase === 'navigating') setSnap('peek')
  }, [navPhase, setSnap])

  // Reaching the destination auto-opens the debrief wrap-up. The controller
  // has already flushed its tail before firing `arrived`, so completing here
  // scores against the full trace.
  useEffect(() => {
    if (arrived && !wrappingUp) {
      clearArrived()
      setWrappingUp(true)
      setSnap('half')
      if (tripId) {
        completeTrip(tripId, useTripStore.getState().driveDurationMinutes()).catch(() => {})
        void openDebrief(tripId)
      }
    }
  }, [arrived, wrappingUp, tripId, clearArrived, openDebrief, setSnap])

  // Trip state resets outside this component too (the ✕ in the header) — don't
  // let stale wrap-up UI greet the next trip.
  useEffect(() => {
    if (status === 'idle' && wrappingUp) {
      setWrappingUp(false)
      setNote('')
      setWrapUpError(null)
      resetDebrief()
    }
  }, [status, wrappingUp, resetDebrief])

  async function startWrapUp() {
    setWrappingUp(true)
    setSnap('half')
    if (!tripId) return
    // Stop the drive first and wait for its final GPS flush. This used to only
    // call completeTrip: "Done driving?" left the drive streaming, so the trip
    // was scored against a partial trace while more points were still arriving.
    const duration = useTripStore.getState().driveDurationMinutes()
    await stopNavigation()
    // The debrief/note can still fail separately without un-completing the trip.
    completeTrip(tripId, duration).catch(() => {})
    void openDebrief(tripId)
  }

  function endWrapUp() {
    setWrappingUp(false)
    setNote('')
    setWrapUpError(null)
    resetDebrief()
    clearTrip()
  }

  async function finishNote(withNote: boolean) {
    if (withNote && note.trim() && tripId) {
      try {
        await sendFeedback(tripId, note.trim())
      } catch (error) {
        setWrapUpError(
          error instanceof FriendlyError ? error.message : 'Something went sideways — try again.',
        )
        return
      }
    }
    endWrapUp()
  }

  const selected = routes[selectedIndex]

  // Read, not re-derived. This used to recompute the step from cumulative
  // miles, as did NavVoice, and the two disagreed at leg boundaries; the drive
  // controller now tracks it against the engine's own shape indices.
  const currentStepIndex = guidance?.stepIndex ?? -1

  // No destination yet: the sheet is the search surface.
  if (!destination) {
    return (
      // Raising to full on focus keeps the field above the on-screen keyboard,
      // which now appears right where this sits.
      <div className="sheet-search" onFocusCapture={() => setSnap('full')}>
        <PlaceSearchField
          placeholder="Where to?"
          ariaLabel="Where to?"
          onPick={(result, title) => {
            rememberPlaceLabel(result.lat, result.lon, title)
            setDestination({ lat: result.lat, lng: result.lon, label: title })
          }}
        >
          {savedPlaces.length > 0 && (
            <div className="prompt-shortcuts">
              {savedPlaces.map(({ key, label, icon, place }) => (
                <button
                  key={key}
                  className="prompt-shortcut"
                  onClick={() => setDestination({ lat: place!.lat, lng: place!.lon, label })}
                >
                  <span aria-hidden>{icon}</span> {label}
                </button>
              ))}
            </div>
          )}
        </PlaceSearchField>
      </div>
    )
  }

  const order = routeDisplayOrder(routes.length, recommendedIndex)
  const visibleRoutes = showAllRoutes ? order : order.slice(0, COLLAPSED_CARDS)
  const hiddenCount = order.length - COLLAPSED_CARDS
  const baselineMinutes = routes[recommendedIndex]?.minutes ?? 0
  // Resolved across the whole set, not per card: the de-duplication inside
  // needs to see every route to avoid handing two of them the same name.
  // Indexed by the route's own index, so it survives the display reorder.
  const labels = routeLabels(routes)

  return (
    <>
      <div className="sheet-header">
        <span className="prompt-dest">
          <span className="prompt-dest-dot" />
          {destination.label ?? 'Destination'}
        </span>
        <button className="prompt-clear" onClick={clearTrip} aria-label="Clear trip">
          ✕
        </button>
      </div>

      {selected && (
        <div className="trip-summary">
          <span className="trip-time">{formatMinutes(selected.minutes)}</span>
          <span className="trip-distance">{formatMiles(selected.miles)}</span>
          {routes.length > 1 && (
            <button
              type="button"
              className="trip-summary-more"
              onClick={() => setSnap('half')}
            >
              {routes.length} ways
            </button>
          )}
        </div>
      )}

      <div className="sheet-scroll">
        {errorMessage && <div className="trip-error">{errorMessage}</div>}
        {status === 'routing' && routes.length === 0 && (
          <div className="trip-loading">Finding your way…</div>
        )}

        {selected && (
          <>
            {/* Route cards lead the scroll region: at the half snap the user is
                comparing ways to go, so that has to be the first thing in view.
                Mode, origin and steps sit below as secondary. */}
            {routes.length > 1 && (
              <div className="route-cards">
                <span className="trip-alts-label">Ways to go</span>
                {visibleRoutes.map((i) => (
                  <RouteCard
                    // Index, never label: every Valhalla alternate is called
                    // "Another way", so labels repeat.
                    key={i}
                    route={routes[i]}
                    label={labels[i]}
                    index={i}
                    isSelected={i === selectedIndex}
                    isRecommended={i === recommendedIndex}
                    deltaMinutes={routes[i].minutes - baselineMinutes}
                    lineColor={i === selectedIndex ? ROUTE_COLORS.glowB : ROUTE_COLORS.alt[theme]}
                    onSelect={selectRoute}
                    onHover={hoverRoute}
                  />
                ))}
                {hiddenCount > 0 && (
                  <button
                    type="button"
                    className="route-more"
                    onClick={() => setShowAllRoutes((v) => !v)}
                  >
                    {showAllRoutes ? 'Fewer ways' : `More ways (${hiddenCount})`}
                  </button>
                )}
              </div>
            )}

            {stops.length > 0 && (
              <div className="trip-vias">
                {stops.map((stop, i) => (
                  <span key={i} className="trip-via">
                    via {stop.label ?? 'stop'}
                    <button
                      className="trip-via-remove"
                      aria-label={`Remove ${stop.label ?? 'stop'}`}
                      onClick={() => removeStop(i)}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="trip-modes" role="group" aria-label="Travel mode">
              {MODES.map(({ mode: m, icon, label }) => (
                <button
                  key={m}
                  className={'trip-mode' + (mode === m ? ' trip-mode--active' : '')}
                  aria-pressed={mode === m}
                  title={label}
                  onClick={() => setMode(m)}
                >
                  <span aria-hidden>{icon}</span>
                  <span className="trip-mode-label">{label}</span>
                </button>
              ))}
            </div>

            {origin && (
              <div className="sheet-from">
                from <strong>{origin.label ?? 'Starting point'}</strong> — drag either pin to adjust
              </div>
            )}

            <div className="trip-steps">
              <span className="trip-steps-label">
                {navPhase === 'navigating' ? 'Driving' : 'On the way'}
              </span>
              <ol>
                {selected.steps.map((step, i) => (
                  <li key={i} className={i === currentStepIndex ? 'step--current' : ''}>
                    <span className="step-text">{step.text}</span>
                    {step.miles > 0.01 && (
                      <span className="step-meta">{formatMiles(step.miles)}</span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          </>
        )}
      </div>

      {selected && (
        <div className="sheet-actions">
          {wrappingUp ? (
            debriefStatus !== 'off' ? (
              <Debrief onDone={endWrapUp} />
            ) : (
              <form
                className="trip-wrapup"
                onSubmit={(e) => {
                  e.preventDefault()
                  void finishNote(true)
                }}
              >
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="How was it?"
                  aria-label="How was the drive?"
                  autoFocus
                />
                <button type="submit" className="gw-primary trip-wrapup-send">
                  Send
                </button>
                <button
                  type="button"
                  className="trip-chip"
                  onClick={() => void finishNote(false)}
                >
                  Skip
                </button>
                {wrapUpError && <div className="trip-error trip-wrapup-error">{wrapUpError}</div>}
              </form>
            )
          ) : navPhase === 'navigating' ? (
            <>
              <div className="trip-nav">
                <div
                  className="trip-nav-progress"
                  role="progressbar"
                  aria-label="Drive progress"
                  aria-valuenow={Math.round(navProgress * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="trip-nav-progress-fill"
                    style={{ transform: `scaleX(${navProgress})` }}
                  />
                </div>
                <button
                  className="gw-primary trip-nav-arrive"
                  // startWrapUp stops the drive itself, flush included.
                  onClick={() => void startWrapUp()}
                >
                  Arrive
                </button>
              </div>
              {/* Mid-drive too, not just before it: the whole point of a
                  playback speed is changing it while watching. 1x is the
                  honest pace for judging whether a turn countdown reads
                  right; 8x is for getting to the end of the route. */}
              {driveMode === 'sim' && <SimSpeedChips value={simSpeed} onChange={setSimSpeed} />}
              <NavVoice />
            </>
          ) : (
            <>
              <div className="trip-drivemode" role="group" aria-label="How to drive">
                <button
                  className={'trip-chip' + (driveMode === 'real' ? ' trip-chip--active' : '')}
                  aria-pressed={driveMode === 'real'}
                  onClick={() => setDriveMode('real')}
                >
                  🛰️ Live GPS
                </button>
                <button
                  className={'trip-chip' + (driveMode === 'sim' ? ' trip-chip--active' : '')}
                  aria-pressed={driveMode === 'sim'}
                  onClick={() => setDriveMode('sim')}
                >
                  ▶︎ Simulate
                </button>
              </div>
              {driveMode === 'sim' && <SimSpeedChips value={simSpeed} onChange={setSimSpeed} />}
              <div className="trip-actions">
                <button className="gw-primary trip-start" onClick={startNavigation}>
                  Start drive
                </button>
                <button className="trip-done" onClick={() => void startWrapUp()}>
                  Done driving?
                </button>
              </div>
              <ChatBar />
            </>
          )}
        </div>
      )}
    </>
  )
}
