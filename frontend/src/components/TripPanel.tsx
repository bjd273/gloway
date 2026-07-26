// Trip summary + step list. Bottom sheet on small screens, left card on
// desktop (pure CSS — same markup). Copy stays human: minutes and miles,
// "Other ways to go", never "maneuvers" or "alternates".
//
// The wrap-up at the bottom ("Done driving?") completes the trip and opens the
// post-trip debrief (Debrief.tsx) — a one-question LLM chat that writes the
// reward signal. When no LLM is configured the debrief reports 'off' and we
// fall back to the plain note form (stored as explicit_feedback).
import { useEffect, useState } from 'react'

import { completeTrip, FriendlyError, sendFeedback, type TravelMode } from '../lib/api'
import { useDebriefStore } from '../stores/useDebriefStore'
import { useTripStore } from '../stores/useTripStore'
import { Debrief } from './Debrief'
import { NavVoice } from './NavVoice'

const MODES: { mode: TravelMode; icon: string; label: string }[] = [
  { mode: 'auto', icon: '🚗', label: 'Drive' },
  { mode: 'bicycle', icon: '🚲', label: 'Bike' },
  { mode: 'pedestrian', icon: '🚶', label: 'Walk' },
]

function formatMinutes(minutes: number): string {
  const m = Math.max(1, Math.round(minutes))
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} hr ${m % 60} min`
}

function formatMiles(miles: number): string {
  return miles < 0.2 ? `${Math.round(miles * 5280)} ft` : `${miles.toFixed(1)} mi`
}

export function TripPanel() {
  const routes = useTripStore((s) => s.routes)
  const selectedIndex = useTripStore((s) => s.selectedIndex)
  const status = useTripStore((s) => s.status)
  const errorMessage = useTripStore((s) => s.errorMessage)
  const tripId = useTripStore((s) => s.tripId)
  const stops = useTripStore((s) => s.stops)
  const mode = useTripStore((s) => s.mode)
  const driveMode = useTripStore((s) => s.driveMode)
  const setDriveMode = useTripStore((s) => s.setDriveMode)
  const navPhase = useTripStore((s) => s.navPhase)
  const navProgress = useTripStore((s) => s.navProgress)
  const arrived = useTripStore((s) => s.arrived)
  const selectRoute = useTripStore((s) => s.selectRoute)
  const removeStop = useTripStore((s) => s.removeStop)
  const setMode = useTripStore((s) => s.setMode)
  const startNavigation = useTripStore((s) => s.startNavigation)
  const stopNavigation = useTripStore((s) => s.stopNavigation)
  const clearArrived = useTripStore((s) => s.clearArrived)
  const clearTrip = useTripStore((s) => s.clearTrip)

  const debriefStatus = useDebriefStore((s) => s.status)
  const openDebrief = useDebriefStore((s) => s.open)
  const resetDebrief = useDebriefStore((s) => s.reset)

  const [wrappingUp, setWrappingUp] = useState(false)
  const [note, setNote] = useState('')
  const [wrapUpError, setWrapUpError] = useState<string | null>(null)

  // Reaching the destination auto-opens the debrief wrap-up.
  useEffect(() => {
    if (arrived && !wrappingUp) {
      clearArrived()
      setWrappingUp(true)
      if (tripId) {
        completeTrip(tripId).catch(() => {})
        void openDebrief(tripId)
      }
    }
  }, [arrived, wrappingUp, tripId, clearArrived, openDebrief])

  if (status === 'idle') {
    // Trip state resets outside this component too (Clear trip in the prompt
    // bar) — don't let stale wrap-up UI greet the next trip.
    if (wrappingUp) {
      setWrappingUp(false)
      setNote('')
      setWrapUpError(null)
      resetDebrief()
    }
    return null
  }

  function startWrapUp() {
    setWrappingUp(true)
    if (tripId) {
      // Mark it done right away; the debrief/note can still fail separately
      // without un-completing the trip.
      completeTrip(tripId).catch(() => {})
      void openDebrief(tripId)
    }
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

  // Which step the driver is on, from progress along the route's total
  // distance. Only meaningful while navigating.
  let currentStepIndex = -1
  if (navPhase === 'navigating' && selected) {
    const drivenMiles = navProgress * selected.miles
    let cumulative = 0
    for (let i = 0; i < selected.steps.length; i += 1) {
      cumulative += selected.steps[i].miles
      if (drivenMiles <= cumulative) {
        currentStepIndex = i
        break
      }
    }
    if (currentStepIndex === -1) currentStepIndex = selected.steps.length - 1
  }

  return (
    <div className="trip-panel">
      {errorMessage && <div className="trip-error">{errorMessage}</div>}

      {status === 'routing' && routes.length === 0 && (
        <div className="trip-loading">Finding your way…</div>
      )}

      {selected && (
        <>
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

          <div className="trip-summary">
            <span className="trip-time">{formatMinutes(selected.minutes)}</span>
            <span className="trip-distance">{formatMiles(selected.miles)}</span>
          </div>

          {stops.length > 0 && (
            <div className="trip-vias">
              {stops.map((stop, i) => (
                <span key={`${stop.lat},${stop.lng}`} className="trip-via">
                  via {stop.label ?? 'stop'}
                  <button
                    className="trip-via-remove"
                    aria-label={`Remove stop ${stop.label ?? ''}`}
                    onClick={() => removeStop(i)}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          {routes.length > 1 && (
            <div className="trip-alts">
              <span className="trip-alts-label">Other ways to go</span>
              <div className="trip-chips">
                {routes.map((route, i) => (
                  <button
                    key={i}
                    className={'trip-chip' + (i === selectedIndex ? ' trip-chip--active' : '')}
                    onClick={() => selectRoute(i)}
                  >
                    {formatMinutes(route.minutes)}
                  </button>
                ))}
              </div>
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

          {wrappingUp ? null : navPhase === 'navigating' ? (
            <>
              <div className="trip-nav">
                <div className="trip-nav-progress">
                  <div
                    className="trip-nav-progress-fill"
                    style={{ width: `${Math.round(navProgress * 100)}%` }}
                  />
                </div>
                <button
                  className="trip-chip trip-chip--active trip-nav-arrive"
                  onClick={() => {
                    stopNavigation()
                    startWrapUp()
                  }}
                >
                  Arrive
                </button>
              </div>
              <NavVoice />
            </>
          ) : (
            <>
              <div className="trip-drivemode" role="group" aria-label="How to drive">
                <button
                  className={'trip-chip' + (driveMode === 'real' ? ' trip-chip--active' : '')}
                  aria-pressed={driveMode === 'real'}
                  title="Record your real drive using your phone's GPS"
                  onClick={() => setDriveMode('real')}
                >
                  🛰️ Live GPS
                </button>
                <button
                  className={'trip-chip' + (driveMode === 'sim' ? ' trip-chip--active' : '')}
                  aria-pressed={driveMode === 'sim'}
                  title="Simulate driving the route (for testing off the road)"
                  onClick={() => setDriveMode('sim')}
                >
                  ▶︎ Simulate
                </button>
              </div>
              <div className="trip-actions">
                <button className="trip-start" onClick={startNavigation}>
                  Start drive
                </button>
                <button className="trip-done" onClick={startWrapUp}>
                  Done driving?
                </button>
              </div>
            </>
          )}

          {wrappingUp && (debriefStatus !== 'off' ? (
            // LLM debrief — the question→reply→ack flow lives in Debrief.
            <Debrief onDone={endWrapUp} />
          ) : (
            // No LLM configured: fall back to the plain one-line note.
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
              <button type="submit" className="trip-chip trip-chip--active">
                Send
              </button>
              <button type="button" className="trip-chip" onClick={() => void finishNote(false)}>
                Skip
              </button>
              {wrapUpError && <div className="trip-error trip-wrapup-error">{wrapUpError}</div>}
            </form>
          ))}
        </>
      )}
    </div>
  )
}
