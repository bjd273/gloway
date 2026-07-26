// Typed client for the Gloway backend (FastAPI, proxied under /api/v1).
// All user-facing error text lives here so components never surface raw
// HTTP details.
import polyline from '@mapbox/polyline'

import { OUT_OF_AREA_MESSAGE } from './region'

export interface SearchResult {
  lat: number
  lon: number
  display_name: string
}

export interface RouteStep {
  text: string
  miles: number
  seconds: number
}

export interface ParsedRoute {
  coords: [number, number][] // [lng, lat], legs concatenated
  minutes: number
  miles: number
  steps: RouteStep[]
}

export interface TripResult {
  tripId: string
  routes: ParsedRoute[] // primary first, then alternates
  recommendedIndex: number
}

export interface UserPrefs {
  avoid_highways: boolean
  avoid_tolls: boolean
  avoid_left_turns: boolean
  prefer_scenic: boolean
}

export interface LatLon {
  lat: number
  lon: number
}

export interface JourneyProfile {
  home_location: LatLon | null
  work_location: LatLon | null
  preferred_convo_style: 'brief' | 'chatty' | 'silent'
  typical_use_cases: string[] | null
  stated_dislikes: string[] | null
}

export interface RegisteredUser {
  userId: string
  email: string
  prefs: UserPrefs
  journey: JourneyProfile
}

export interface ConvoMessage {
  role: 'assistant' | 'user'
  content: string
}

export class FriendlyError extends Error {}

const ENGINE_DOWN_MESSAGE = "Can't reach the road network right now — try again in a moment."
const PROFILE_DOWN_MESSAGE = "Couldn't reach your profile right now — try again in a moment."

interface ValhallaManeuver {
  instruction: string
  length: number
  time: number
}

interface ValhallaTrip {
  legs: { shape: string; maneuvers: ValhallaManeuver[] }[]
  summary: { time: number; length: number }
}

function parseTrip(trip: ValhallaTrip): ParsedRoute {
  const coords: [number, number][] = []
  const steps: RouteStep[] = []
  for (const leg of trip.legs) {
    // Valhalla encodes shapes at polyline precision 6.
    for (const [lat, lng] of polyline.decode(leg.shape, 6)) {
      coords.push([lng, lat])
    }
    for (const m of leg.maneuvers) {
      steps.push({ text: m.instruction, miles: m.length, seconds: m.time })
    }
  }
  return {
    coords,
    minutes: trip.summary.time / 60,
    miles: trip.summary.length,
    steps,
  }
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const response = await fetch(
    `/api/v1/routing/search?q=${encodeURIComponent(query)}`,
    { signal },
  )
  if (!response.ok) throw new FriendlyError(ENGINE_DOWN_MESSAGE)
  const data = await response.json()
  return data.results
}

export type TravelMode = 'auto' | 'bicycle' | 'pedestrian'

export async function getRoute(request: {
  origin: { lat: number; lng: number; label?: string }
  destination: { lat: number; lng: number; label?: string }
  userId?: string | null
  intent?: string | null
  waypoints?: { lat: number; lng: number }[]
  mode?: TravelMode
}): Promise<TripResult> {
  let response: Response
  try {
    response = await fetch('/api/v1/routing/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin_lat: request.origin.lat,
        origin_lon: request.origin.lng,
        dest_lat: request.destination.lat,
        dest_lon: request.destination.lng,
        user_id: request.userId ?? null,
        declared_intent: request.intent ?? null,
        origin_label: request.origin.label ?? null,
        dest_label: request.destination.label ?? null,
        waypoints: (request.waypoints ?? []).map((wp) => ({ lat: wp.lat, lon: wp.lng })),
        mode: request.mode ?? 'auto',
      }),
    })
  } catch {
    throw new FriendlyError(ENGINE_DOWN_MESSAGE)
  }
  if (response.status === 503) throw new FriendlyError(ENGINE_DOWN_MESSAGE)
  if (!response.ok) {
    // Valhalla 400s pass through for points it can't route (outside the
    // tiled region, or not near a road).
    throw new FriendlyError(OUT_OF_AREA_MESSAGE)
  }
  const data = await response.json()
  return {
    tripId: data.trip_id,
    routes: (data.routes as ValhallaTrip[]).map(parseTrip),
    recommendedIndex: data.recommended_index,
  }
}

function pickPrefs(preferences: Record<string, unknown>): UserPrefs {
  return {
    avoid_highways: Boolean(preferences.avoid_highways),
    avoid_tolls: Boolean(preferences.avoid_tolls),
    avoid_left_turns: Boolean(preferences.avoid_left_turns),
    prefer_scenic: Boolean(preferences.prefer_scenic),
  }
}

function pickJourney(journey: Record<string, unknown>): JourneyProfile {
  return {
    home_location: (journey.home_location as LatLon | null) ?? null,
    work_location: (journey.work_location as LatLon | null) ?? null,
    preferred_convo_style:
      (journey.preferred_convo_style as JourneyProfile['preferred_convo_style']) ?? 'brief',
    typical_use_cases: (journey.typical_use_cases as string[] | null) ?? null,
    stated_dislikes: (journey.stated_dislikes as string[] | null) ?? null,
  }
}

function parseUser(data: Record<string, unknown>): RegisteredUser {
  return {
    userId: data.user_id as string,
    email: data.email as string,
    prefs: pickPrefs(data.preferences as Record<string, unknown>),
    journey: pickJourney(data.journey as Record<string, unknown>),
  }
}

export async function registerUser(email: string): Promise<RegisteredUser> {
  let response: Response
  try {
    response = await fetch('/api/v1/users/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
  } catch {
    throw new FriendlyError(PROFILE_DOWN_MESSAGE)
  }
  if (response.status === 422) {
    throw new FriendlyError("That email doesn't look right — check it and try again.")
  }
  if (!response.ok) throw new FriendlyError(PROFILE_DOWN_MESSAGE)
  return parseUser(await response.json())
}

export async function getProfile(userId: string): Promise<RegisteredUser> {
  let response: Response
  try {
    response = await fetch(`/api/v1/users/${userId}/profile`)
  } catch {
    throw new FriendlyError(PROFILE_DOWN_MESSAGE)
  }
  if (!response.ok) throw new FriendlyError(PROFILE_DOWN_MESSAGE)
  return parseUser(await response.json())
}

export async function updateJourney(
  userId: string,
  patch: Partial<Pick<JourneyProfile, 'home_location' | 'work_location' | 'preferred_convo_style'>>,
): Promise<JourneyProfile> {
  let response: Response
  try {
    response = await fetch(`/api/v1/users/${userId}/journey`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  } catch {
    throw new FriendlyError(PROFILE_DOWN_MESSAGE)
  }
  if (!response.ok) throw new FriendlyError(PROFILE_DOWN_MESSAGE)
  return pickJourney(await response.json())
}

/** Opens the pre-journey conversation. Null means the feature is off
 * (no LLM configured server-side) — callers hide the UI, never an error. */
export async function openConversation(tripId: string): Promise<ConvoMessage[] | null> {
  let response: Response
  try {
    response = await fetch(`/api/v1/trips/${tripId}/conversation/open`, { method: 'POST' })
  } catch {
    return null
  }
  if (!response.ok) return null
  const data = await response.json()
  return (data.messages as ConvoMessage[]).map((m) => ({ role: m.role, content: m.content }))
}

export interface RouteOption {
  index: number
  minutes: number
  selected: boolean
}

export interface ReplyResult {
  message: string
  intent: string | null
  prefs: UserPrefs | null
  switchToRoute: number | null
  stop: { name: string; lat: number; lon: number } | null
  stopsCleared: boolean
  setDestination: 'home' | 'work' | null
  travelMode: TravelMode | null
}

/** Maps the backend's (snake_case) reply/action payload into a ReplyResult.
 * Shared by the HTTP pre-trip reply and the in-drive voice socket, which send
 * the identical shape — so both apply side-effects through one parser. */
export function toReplyResult(data: Record<string, unknown>): ReplyResult {
  return {
    message: (data.message as string) ?? '',
    intent: (data.intent as string | null) ?? null,
    prefs: data.preferences ? pickPrefs(data.preferences as Record<string, unknown>) : null,
    switchToRoute: (data.switch_to_route as number | null) ?? null,
    stop: (data.stop as ReplyResult['stop']) ?? null,
    stopsCleared: Boolean(data.stops_cleared),
    setDestination: (data.set_destination as 'home' | 'work' | null) ?? null,
    travelMode: (data.travel_mode as TravelMode | null) ?? null,
  }
}

export async function replyConversation(
  tripId: string,
  text: string,
  routeOptions?: RouteOption[],
): Promise<ReplyResult> {
  let response: Response
  try {
    response = await fetch(`/api/v1/trips/${tripId}/conversation/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, route_options: routeOptions ?? null }),
    })
  } catch {
    throw new FriendlyError("Didn't catch that — try again in a moment.")
  }
  if (!response.ok) throw new FriendlyError("Didn't catch that — try again in a moment.")
  return toReplyResult(await response.json())
}

/** WebSocket URL for the in-drive voice loop. Same-origin under /api/v1 (the
 * Vite dev proxy forwards the upgrade to FastAPI), ws/wss chosen from the
 * page protocol. */
export function voiceSocketUrl(tripId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/api/v1/trips/${tripId}/voice`
}

/** Opens the post-trip debrief. Null means the feature is off (no LLM) — the
 * caller falls back to the plain note form. */
export async function openDebrief(tripId: string): Promise<string | null> {
  let response: Response
  try {
    response = await fetch(`/api/v1/trips/${tripId}/debrief/open`, { method: 'POST' })
  } catch {
    return null
  }
  if (!response.ok) return null
  const data = await response.json()
  return data.message as string
}

export async function replyDebrief(
  tripId: string,
  text: string,
): Promise<{ message: string; reward: number; prefs: UserPrefs | null }> {
  let response: Response
  try {
    response = await fetch(`/api/v1/trips/${tripId}/debrief/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
  } catch {
    throw new FriendlyError("Didn't catch that — try again in a moment.")
  }
  if (!response.ok) throw new FriendlyError("Didn't catch that — try again in a moment.")
  const data = await response.json()
  return {
    message: data.message,
    reward: data.reward ?? 0,
    prefs: data.preferences ? pickPrefs(data.preferences) : null,
  }
}

export async function updatePreferences(
  userId: string,
  patch: Partial<UserPrefs>,
): Promise<UserPrefs> {
  let response: Response
  try {
    response = await fetch(`/api/v1/users/${userId}/preferences`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  } catch {
    throw new FriendlyError(PROFILE_DOWN_MESSAGE)
  }
  if (!response.ok) throw new FriendlyError(PROFILE_DOWN_MESSAGE)
  return pickPrefs(await response.json())
}

/** Flush a batch of GPS points for a live drive. Best-effort — a dropped
 * flush during navigation shouldn't interrupt the drive, so failures are
 * swallowed (the next flush carries on). */
export async function streamGpsPoints(
  tripId: string,
  points: { lat: number; lon: number; timestamp?: string }[],
): Promise<void> {
  if (points.length === 0) return
  try {
    await fetch(`/api/v1/trips/${tripId}/gps-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points }),
    })
  } catch {
    // Swallowed on purpose — see docstring.
  }
}

export async function completeTrip(tripId: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(`/api/v1/trips/${tripId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
  } catch {
    throw new FriendlyError(ENGINE_DOWN_MESSAGE)
  }
  if (!response.ok) throw new FriendlyError(ENGINE_DOWN_MESSAGE)
}

export async function sendFeedback(tripId: string, text: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(`/api/v1/feedback/${tripId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
  } catch {
    throw new FriendlyError("Couldn't send that right now — try again in a moment.")
  }
  if (!response.ok) {
    throw new FriendlyError("Couldn't send that right now — try again in a moment.")
  }
}

/** Server-side STT fallback: transcribes recorded audio via the backend's
 * LLM. Empty string means the server heard no speech. The blob goes up as
 * the raw body — its type header tells the backend the audio format. */
export async function transcribeAudio(blob: Blob): Promise<string> {
  let response: Response
  try {
    response = await fetch('/api/v1/speech/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    })
  } catch {
    throw new FriendlyError("Didn't catch that — try again in a moment.")
  }
  if (!response.ok) throw new FriendlyError("Didn't catch that — try again in a moment.")
  const data = await response.json()
  return typeof data.text === 'string' ? data.text : ''
}
