// Pre-journey conversation state.
//
// Anchored to the FIRST trip of a session: re-routes (preference toggles,
// intent changes) create new trip rows server-side, but the conversation
// stays attached to the trip it opened on — continuity beats bookkeeping.
// 'off' means the backend has no LLM configured (open returned null); the
// UI renders nothing and never surfaces an error for it.
import { create } from 'zustand'

import {
  FriendlyError,
  openConversation,
  replyConversation,
  type ConvoMessage,
  type ReplyResult,
  type RouteOption,
} from '../lib/api'
import { useTripStore } from './useTripStore'
import { useUserStore } from './useUserStore'

export type ConvoStatus = 'idle' | 'opening' | 'ready' | 'thinking' | 'off'

/** Apply a reply's side-effects to the trip + user stores. Shared by the
 * pre-trip conversation (this store's `reply`) and the in-drive voice loop
 * (`navVoice`), so both interpret a route switch / stop / destination / mode /
 * intent / prefs identically.
 *
 * `reArmDrive` (set by the voice loop) asks the trip store to restart the
 * drive once a reroute lands, so a mid-drive command doesn't silently end
 * navigation. It has no effect pre-trip. Returns whether a reroute was
 * initiated (the caller may want to know the drive is being re-armed). */
export function applyReplyResult(
  result: ReplyResult,
  opts: { reArmDrive?: boolean } = {},
): { rerouted: boolean } {
  if (result.prefs) useUserStore.getState().applyServerPrefs(result.prefs)

  const trip = useTripStore.getState()

  // A route switch targets the options CURRENTLY on screen. Any re-routing
  // side-effect (intent, prefs, stop, mode, destination) rebuilds the route
  // set and resets the selection, which would silently undo the switch — so
  // when the reply picks a route, honor only that. Prefs were still persisted
  // server-side.
  if (result.switchToRoute !== null) {
    trip.selectRoute(result.switchToRoute)
    // Mid-drive, follow the newly selected alternate: re-arm onto it now
    // (routes are already loaded, so this is synchronous).
    if (opts.reArmDrive && trip.navPhase === 'navigating') {
      trip.stopNavigation()
      trip.startNavigation()
    }
    return { rerouted: false }
  }

  if (result.setDestination) {
    // "Take me home / to work": resolve against the profile and start a fresh
    // route there. Supersedes other outcomes in the same reply.
    const journey = useUserStore.getState().journey
    const place =
      result.setDestination === 'home' ? journey?.home_location : journey?.work_location
    if (place) {
      if (opts.reArmDrive) trip.armReroute()
      trip.setDestination({
        lat: place.lat,
        lng: place.lon,
        label: result.setDestination === 'home' ? 'Home' : 'Work',
      })
      return { rerouted: true }
    }
    return { rerouted: false }
  }

  // Each of these can independently trigger a reroute; arm once up front so
  // whichever re-request completes re-arms the drive.
  let rerouted = false
  const willReroute =
    (result.travelMode !== null && result.travelMode !== trip.mode) ||
    (result.stopsCleared && trip.stops.length > 0) ||
    result.stop !== null ||
    result.intent !== null ||
    (result.prefs !== null && result.travelMode === null && !!trip.origin && !!trip.destination)
  if (opts.reArmDrive && willReroute) trip.armReroute()

  if (result.travelMode) {
    trip.setMode(result.travelMode)
    rerouted = rerouted || result.travelMode !== trip.mode
  }
  if (result.stopsCleared) {
    const had = trip.stops.length > 0
    trip.clearStops()
    rerouted = rerouted || had
  }
  if (result.stop) {
    trip.addStop({ lat: result.stop.lat, lng: result.stop.lon, label: result.stop.name })
    rerouted = true
  }
  if (result.intent) {
    trip.setIntent(result.intent)
    rerouted = true
  } else if (result.prefs && !result.travelMode) {
    trip.refreshRoute()
    rerouted = rerouted || (!!trip.origin && !!trip.destination)
  }
  return { rerouted }
}

interface ConvoState {
  status: ConvoStatus
  tripId: string | null
  messages: ConvoMessage[]

  open(tripId: string): Promise<void>
  reply(text: string): Promise<void>
  reset(): void
}

export const useConvoStore = create<ConvoState>((set, get) => ({
  status: 'idle',
  tripId: null,
  messages: [],

  async open(tripId) {
    if (get().status !== 'idle') return
    set({ status: 'opening', tripId })
    const messages = await openConversation(tripId)
    if (messages === null) {
      set({ status: 'off' })
      return
    }
    set({ status: 'ready', messages })
  },

  async reply(text) {
    const { tripId, status, messages } = get()
    if (!tripId || status !== 'ready') return
    set({ status: 'thinking', messages: [...messages, { role: 'user', content: text }] })
    try {
      const trip = useTripStore.getState()
      const routeOptions: RouteOption[] = trip.routes.map((route, index) => ({
        index,
        minutes: route.minutes,
        selected: index === trip.selectedIndex,
        label: route.label,
      }))
      const result = await replyConversation(tripId, text, routeOptions)
      set((s) => ({
        status: 'ready',
        messages: [...s.messages, { role: 'assistant', content: result.message }],
      }))
      applyReplyResult(result)
    } catch (error) {
      set((s) => ({
        status: 'ready',
        messages: [
          ...s.messages,
          {
            role: 'assistant',
            content:
              error instanceof FriendlyError ? error.message : 'Something went sideways — try again.',
          },
        ],
      }))
    }
  },

  reset() {
    set({ status: 'idle', tripId: null, messages: [] })
  },
}))
