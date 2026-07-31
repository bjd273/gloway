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

/**
 * One painted lane on the approach to a maneuver, left to right as you face it.
 *
 * Grafted onto the native maneuver server-side from an OSRM-shaped response —
 * Valhalla 3.5.1 emits lanes in no other format (see backend/routing/
 * lane_guidance.py). Indications are strings, not the bitmask the API reference
 * describes: "left", "right", "straight", "slight left", "sharp right",
 * "uturn", "merge to left", "none".
 */
export interface LaneInfo {
  /** Every arrow painted in this lane. A lane can serve several turns. */
  indications: string[]
  /** Whether this lane keeps you on the route. */
  valid: boolean
  /** Whether this is the lane to be in — Valhalla singles out at most one. */
  active: boolean
  /** Which of `indications` to follow from here. Absent when `valid` is false. */
  valid_indication?: string
}

/** Motorway signage for a maneuver — exit numbers and what they point at. */
export interface ManeuverSign {
  exitNumbers?: string[]
  exitBranches?: string[]
  exitToward?: string[]
  exitNames?: string[]
}

export interface RouteStep {
  text: string
  miles: number
  seconds: number
  /**
   * Valhalla maneuver type enum (0-43) — what the turn arrow is drawn from.
   * Optional because a backend older than this field omits it; the icon layer
   * falls back to a "continue" arrow rather than parsing the English in `text`,
   * which would break on the first wording change.
   */
  type?: number
  /**
   * Indices into `ParsedRoute.coords`, ALREADY OFFSET for the multi-leg
   * concatenation parseTrip performs. `endShapeIndex` is where the maneuver
   * happens, which is what the drive tracker counts down to.
   */
  beginShapeIndex?: number
  endShapeIndex?: number
  /** Spoken form for the "in half a mile..." warning. */
  verbalAlert?: string
  /** Spoken form for the turn itself. */
  verbalPre?: string
  /** Spoken form for just after the turn ("continue for 2 miles"). */
  verbalPost?: string
  /**
   * True when `verbalPre` already names the FOLLOWING maneuver too ("turn
   * right onto Cooper, then turn left"). The announcer suppresses the next
   * step's alert on this, or the driver hears the same sentence twice.
   */
  verbalMultiCue?: boolean
  /** Terser spoken form, when Valhalla produced one. */
  verbalSuccinct?: string
  /** Which lane to be in. Absent wherever OSM carries no turn:lanes. */
  lanes?: LaneInfo[]
  sign?: ManeuverSign
  /** Which spoke to leave a roundabout by — drawn inside the roundabout icon. */
  roundaboutExitCount?: number
  streetNames?: string[]
}

export interface ParsedRoute {
  coords: [number, number][] // [lng, lat], legs concatenated
  minutes: number
  miles: number
  steps: RouteStep[]
  /**
   * Display name from the backend — "Fastest", "No highways", "Another way".
   * NOT unique: every Valhalla alternate is labelled "Another way", so this is
   * never a React key and never a dedupe key. Use the array index.
   */
  label: string
  /**
   * Machine key — "avoid_highways", "fewest_turns". Optional because a backend
   * older than the route_strategies field omits it. Prefer this over matching
   * `label`, which is display copy and expected to get reworded.
   */
  strategy?: string
  /**
   * Valhalla emits these on the trip summary only on some builds and costings,
   * so `undefined` means "not known", which is NOT the same as `false`. Only
   * ever use them to add a claim, never to deny one.
   */
  hasHighway?: boolean
  hasToll?: boolean
  /**
   * Whether a routing strategy purpose-built this route, or it is one of the
   * alternates Valhalla returned alongside one. False means `label` is the
   * generic "Another way" and carries no information — see `routeLabels`.
   * Optional because a backend older than the `route_primary` field omits it;
   * treat missing as true, which reproduces the previous behaviour.
   */
  isPrimary?: boolean
  /**
   * The road this route spends the most distance on — "Cooper St", "I-30".
   * Undefined when Valhalla emitted no street names for this costing.
   */
  viaRoad?: string
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

interface ValhallaSignElement {
  text: string
}

interface ValhallaManeuver {
  instruction: string
  length: number
  time: number
  // Present only when Valhalla knows the road's name — unnamed service roads
  // and slip lanes have none, so this is routinely absent mid-route.
  street_names?: string[]
  type?: number
  // Per LEG, not per route — see the offsetting in parseTrip.
  begin_shape_index?: number
  end_shape_index?: number
  verbal_transition_alert_instruction?: string
  verbal_pre_transition_instruction?: string
  verbal_post_transition_instruction?: string
  verbal_succinct_transition_instruction?: string
  verbal_multi_cue?: boolean
  // Grafted on server-side from the OSRM response; absent wherever OSM has no
  // turn:lanes for the approach.
  lanes?: LaneInfo[]
  roundabout_exit_count?: number
  sign?: {
    exit_number_elements?: ValhallaSignElement[]
    exit_branch_elements?: ValhallaSignElement[]
    exit_toward_elements?: ValhallaSignElement[]
    exit_name_elements?: ValhallaSignElement[]
  }
}

/**
 * The road a route mostly runs on, for a "via Cooper St" style name.
 *
 * Weighted by distance, not by maneuver count: a route with eight fiddly turns
 * through a neighbourhood and one long run down a highway is "via the highway"
 * to any driver looking at it, but counting maneuvers would name a side street.
 *
 * The first and last maneuvers are excluded deliberately. Every candidate for
 * the same trip leaves from the same street and arrives on the same street, so
 * those two contribute nothing that distinguishes one route from another — and
 * on a short trip they are often the longest legs, which is exactly when they'd
 * win and make every card read the same.
 */
export function dominantStreet(maneuvers: ValhallaManeuver[]): string | undefined {
  const middle = maneuvers.slice(1, -1)
  const byStreet = new Map<string, number>()
  for (const m of middle) {
    // A maneuver can carry several names for one road (a street name plus its
    // route number). Crediting each with the full length is fine — they're
    // alternatives for the same stretch, competing with other roads, not with
    // each other.
    for (const name of m.street_names ?? []) {
      byStreet.set(name, (byStreet.get(name) ?? 0) + m.length)
    }
  }
  let best: string | undefined
  let bestLength = 0
  for (const [name, length] of byStreet) {
    if (length > bestLength) {
      bestLength = length
      best = name
    }
  }
  return best
}

interface ValhallaTrip {
  legs: { shape: string; maneuvers: ValhallaManeuver[] }[]
  summary: { time: number; length: number; has_highway?: boolean; has_toll?: boolean }
}

/** Sign elements carry more than text; the banner only ever shows the text. */
function signText(elements?: ValhallaSignElement[]): string[] | undefined {
  return elements?.length ? elements.map((e) => e.text) : undefined
}

/**
 * Shift a per-leg shape index into the concatenated coordinate array.
 *
 * Explicitly checked against undefined rather than `?? ` or a truthiness test:
 * index 0 is both falsy and by far the commonest value here (every leg's first
 * maneuver has it), so `if (i)` would drop exactly the indices that matter.
 */
function offsetIndex(index: number | undefined, by: number): number | undefined {
  return index === undefined ? undefined : index + by
}

function toStep(m: ValhallaManeuver, legOffset: number): RouteStep {
  return {
    text: m.instruction,
    miles: m.length,
    seconds: m.time,
    type: m.type,
    beginShapeIndex: offsetIndex(m.begin_shape_index, legOffset),
    endShapeIndex: offsetIndex(m.end_shape_index, legOffset),
    verbalAlert: m.verbal_transition_alert_instruction,
    verbalPre: m.verbal_pre_transition_instruction,
    verbalPost: m.verbal_post_transition_instruction,
    verbalSuccinct: m.verbal_succinct_transition_instruction,
    verbalMultiCue: m.verbal_multi_cue,
    lanes: m.lanes,
    roundaboutExitCount: m.roundabout_exit_count,
    streetNames: m.street_names,
    sign: m.sign && {
      exitNumbers: signText(m.sign.exit_number_elements),
      exitBranches: signText(m.sign.exit_branch_elements),
      exitToward: signText(m.sign.exit_toward_elements),
      exitNames: signText(m.sign.exit_name_elements),
    },
  }
}

export function parseTrip(
  trip: ValhallaTrip,
  label: string,
  strategy?: string,
  isPrimary?: boolean,
): ParsedRoute {
  const coords: [number, number][] = []
  const steps: RouteStep[] = []
  const maneuvers: ValhallaManeuver[] = []
  for (const leg of trip.legs) {
    // Valhalla numbers shape indices PER LEG, and this loop concatenates every
    // leg's points into one array — so each leg's indices have to shift by how
    // many points are already in it. Without this, every maneuver after the
    // first stop addresses the wrong place on the line, and it gets worse with
    // each leg.
    //
    // No -1, deliberately: consecutive legs SHARE their junction point and the
    // decode below pushes BOTH copies, so `coords.length` is exactly right for
    // the concatenation as actually performed. If that duplicate is ever
    // removed, this has to change with it or every post-stop maneuver slides
    // one point per leg, silently.
    const legOffset = coords.length
    // Valhalla encodes shapes at polyline precision 6.
    for (const [lat, lng] of polyline.decode(leg.shape, 6)) {
      coords.push([lng, lat])
    }
    for (const m of leg.maneuvers) {
      steps.push(toStep(m, legOffset))
      maneuvers.push(m)
    }
  }
  return {
    coords,
    minutes: trip.summary.time / 60,
    miles: trip.summary.length,
    steps,
    label,
    strategy,
    isPrimary,
    viaRoad: dominantStreet(maneuvers),
    // Passed through as-is: undefined must stay undefined so callers can tell
    // "no highway" from "don't know".
    hasHighway: trip.summary.has_highway,
    hasToll: trip.summary.has_toll,
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
  // route_labels / route_strategies / route_primary are index-parallel to
  // routes. All are additive fields, so fall back rather than assuming they
  // arrived.
  const labels = (data.route_labels as string[] | undefined) ?? []
  const strategies = (data.route_strategies as string[] | undefined) ?? []
  const primary = (data.route_primary as boolean[] | undefined) ?? []
  return {
    tripId: data.trip_id,
    routes: (data.routes as ValhallaTrip[]).map((trip, i) =>
      parseTrip(
        trip,
        labels[i] ?? (i === 0 ? 'Fastest' : 'Another way'),
        strategies[i],
        // Missing means an older backend: treat every route as purpose-built,
        // which reproduces the pre-route_primary behaviour exactly.
        primary[i] ?? true,
      ),
    ),
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
  /** The name shown on the card, so "avoid the highway" can resolve to an index. */
  label?: string
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

export async function completeTrip(
  tripId: string,
  durationMinutes?: number | null,
): Promise<void> {
  let response: Response
  try {
    response = await fetch(`/api/v1/trips/${tripId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // duration_minutes feeds the reward's "arrived early/late" term; omitted
      // when we have nothing truthful to report (see driveDurationMinutes).
      body: JSON.stringify(
        durationMinutes != null ? { duration_minutes: durationMinutes } : {},
      ),
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
