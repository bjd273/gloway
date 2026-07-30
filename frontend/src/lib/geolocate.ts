// Two ways to ask for the device's location, deliberately behaving differently.
//
// `resolveOrigin` is for routing: the user asked for a route, not for a
// permission dialog, so a denial or a slow fix silently falls back to the map
// centre. Never nags.
//
// `requestCurrentLocation` is for an explicit "use my current location" tap. It
// must report failure, because the silent fallback would quietly save the map
// centre as the user's home address — a worse bug than the one the button
// exists to fix.

import { inRegion } from './region'

export interface Coords {
  lat: number
  lng: number
  label?: string
}

export type LocationFailure = 'unsupported' | 'denied' | 'timeout' | 'out-of-region'

export type LocationResult =
  | { ok: true; place: Coords }
  | { ok: false; reason: LocationFailure }

/** Human-readable text for each failure, so callers don't invent their own. */
export const LOCATION_FAILURE_MESSAGE: Record<LocationFailure, string> = {
  unsupported: "This browser can't share your location.",
  denied: 'Location is blocked — allow it in your browser settings, or search for the address.',
  timeout: "Couldn't get a location fix. Try again, or search for the address.",
  'out-of-region': "You're outside the area Gloway covers right now.",
}

function getPosition(timeout: number): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      timeout,
      maximumAge: 60_000,
    })
  })
}

/**
 * Resolve a starting point: the user's location if allowed *and* inside the
 * routable region, else the current map center. Never nags for permission — a
 * denied or slow geolocation silently falls back.
 *
 * The 3s outer timer is belt-and-braces over the 2.5s geolocation timeout:
 * some browsers never fire either callback when a permission prompt is left
 * hanging, and a trip that never routes is worse than one routed from the map
 * centre.
 */
export function resolveOrigin(mapCenter: Coords): Promise<Coords> {
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

/**
 * Ask for the device location on the user's explicit request, reporting why it
 * failed rather than substituting something else.
 *
 * Gets a longer timeout than `resolveOrigin`: the user pressed a button and is
 * watching a spinner, so waiting is expected rather than an unexplained stall.
 */
export async function requestCurrentLocation(timeout = 8000): Promise<LocationResult> {
  if (!navigator.geolocation) return { ok: false, reason: 'unsupported' }
  let position: GeolocationPosition
  try {
    position = await getPosition(timeout)
  } catch (error) {
    const code = (error as GeolocationPositionError | undefined)?.code
    // PERMISSION_DENIED === 1; everything else (unavailable, timeout) reads as
    // "try again", which is the honest advice for both.
    return { ok: false, reason: code === 1 ? 'denied' : 'timeout' }
  }
  const { latitude, longitude } = position.coords
  if (!inRegion(latitude, longitude)) return { ok: false, reason: 'out-of-region' }
  return { ok: true, place: { lat: latitude, lng: longitude, label: 'Current location' } }
}
