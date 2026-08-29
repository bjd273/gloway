// Which waypoints a reroute should still route through.
//
// A reroute starts from where the car is now, and the naive version re-sends
// every waypoint the trip had. That is how a driver who has already filled up
// gets sent back to the petrol station, and it gets worse each time: the stop
// stays in the list, so every subsequent reroute points at it again.
//
// Separate from the store because it is pure geometry with an obvious right
// answer, and the store cannot be imported without a browser.
import { cumulativeMeters } from './routeProgress'
import { projectToRoute } from './snapToRoute'

/**
 * A stop this close ahead counts as reached.
 *
 * Not noise insurance — the opposite. The commonest reason a reroute fires near
 * a stop is that the driver pulled into its car park, which reads as leaving the
 * route. Re-inserting a waypoint they are standing in would route them back out
 * of the lot and round the block to re-enter it, which is the single most
 * ridiculous thing a nav app can do.
 */
const ARRIVED_PAD_METERS = 30

/**
 * Past this distance from the route, "ahead or behind?" has no answer.
 *
 * Every stop is a waypoint the route was built through, so an unvisited one
 * projects within a few metres of the line. Something far off it projects onto
 * whichever end happens to be nearest, and that number means nothing — but it
 * still compares against the odometer, and on a route mostly driven it compares
 * as "behind". That silently deleted stops nowhere near the driver.
 */
const CORRIDOR_METERS = 100

export interface StopPoint {
  lng: number
  lat: number
}

/**
 * The stops still ahead, given how far along `coords` the driver is.
 *
 * `progress` is the 0..1 fraction of route LENGTH — the same number the drive
 * controller reports, not a fraction of the coordinate count.
 *
 * A full-scan projection, deliberately: a stop has no previous position to
 * search around, and a window anchored on the driver would be looking in the
 * wrong place entirely.
 */
export function stopsAhead<T extends StopPoint>(
  stops: T[],
  coords: [number, number][],
  progress: number,
): T[] {
  if (stops.length === 0 || coords.length < 2) return stops
  const cumulative = cumulativeMeters(coords)
  const driven = (cumulative[cumulative.length - 1] ?? 0) * progress
  return stops.filter((stop) => {
    const projection = projectToRoute(coords, cumulative, [stop.lng, stop.lat])
    // Dropping a stop is the destructive answer, so it takes positive evidence:
    // the stop has to be genuinely on this route, and genuinely behind us.
    if (projection === null) return true
    if (projection.distanceMeters > CORRIDOR_METERS) return true
    return projection.meters > driven + ARRIVED_PAD_METERS
  })
}
