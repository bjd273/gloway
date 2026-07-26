// Hands-free voice while driving. Mounts only during active navigation; holds
// a NavVoiceController (WebSocket + push-to-talk) open for the drive, speaks
// each reply aloud, and applies the returned action live (full command parity
// with the pre-trip conversation).
//
// Nav context and route options are read fresh from the trip store at send
// time (not closed over) so every utterance carries the current ETA, next
// maneuver, and alternates.
import { useEffect, useRef, useState } from 'react'

import type { RouteOption } from '../lib/api'
import { NavVoiceController, type NavContext, type NavVoiceState } from '../lib/navVoice'
import { speak } from '../lib/voice'
import { applyReplyResult } from '../stores/useConvoStore'
import { useTripStore } from '../stores/useTripStore'

function computeNavContext(): NavContext {
  const s = useTripStore.getState()
  const selected = s.routes[s.selectedIndex]
  const destLabel = s.destination?.label ?? null
  if (!selected) {
    return { destLabel, progress: s.navProgress, minutesRemaining: null, nextManeuver: null }
  }
  const minutesRemaining = Math.max(0, selected.minutes * (1 - s.navProgress))
  // Next maneuver from progress along total distance — same derivation TripPanel
  // uses to highlight the current step.
  const drivenMiles = s.navProgress * selected.miles
  let cumulative = 0
  let stepIndex = selected.steps.length - 1
  for (let i = 0; i < selected.steps.length; i += 1) {
    cumulative += selected.steps[i].miles
    if (drivenMiles <= cumulative) {
      stepIndex = i
      break
    }
  }
  return {
    destLabel,
    progress: s.navProgress,
    minutesRemaining,
    nextManeuver: selected.steps[stepIndex]?.text ?? null,
  }
}

function computeRouteOptions(): RouteOption[] {
  const s = useTripStore.getState()
  return s.routes.map((route, index) => ({
    index,
    minutes: route.minutes,
    selected: index === s.selectedIndex,
  }))
}

const LABELS: Record<NavVoiceState, string> = {
  connecting: 'Connecting…',
  idle: 'Tap to talk',
  listening: 'Listening… tap to send',
  thinking: 'Thinking…',
  error: 'Voice unavailable',
  closed: 'Voice off',
}

export function NavVoice() {
  const navPhase = useTripStore((s) => s.navPhase)
  const tripId = useTripStore((s) => s.tripId)
  const [state, setState] = useState<NavVoiceState>('connecting')
  const [transcript, setTranscript] = useState('')
  const [reply, setReply] = useState('')
  const controllerRef = useRef<NavVoiceController | null>(null)

  useEffect(() => {
    if (navPhase !== 'navigating' || !tripId) return
    const controller = new NavVoiceController(tripId, {
      onTranscript: (t) => setTranscript(t),
      onReply: (result) => {
        setReply(result.message)
        speak(result.message)
        applyReplyResult(result, { reArmDrive: true })
      },
      onState: (st) => setState(st),
      getNavContext: computeNavContext,
      getRouteOptions: computeRouteOptions,
    })
    controllerRef.current = controller
    controller.start()
    return () => {
      controller.stop()
      controllerRef.current = null
    }
  }, [navPhase, tripId])

  if (navPhase !== 'navigating') return null

  const listening = state === 'listening'
  // While listening the button must stay live (to send); otherwise it's only
  // tappable when the socket is idle/ready.
  const tappable = listening || state === 'idle'

  return (
    <div className="nav-voice">
      <button
        className={'nav-voice-mic' + (listening ? ' nav-voice-mic--live' : '')}
        onClick={() => void controllerRef.current?.toggle()}
        disabled={!tappable}
        aria-pressed={listening}
        aria-label={LABELS[state]}
      >
        <span aria-hidden>{listening ? '⏺' : '🎙'}</span>
      </button>
      <div className="nav-voice-status">
        <span className="nav-voice-label">{LABELS[state]}</span>
        {transcript && <span className="nav-voice-transcript">“{transcript}”</span>}
        {reply && <span className="nav-voice-reply">{reply}</span>}
      </div>
    </div>
  )
}
