// "Add a stop" while driving, without typing.
//
// A search field is the wrong control here. The driver has one hand and about
// half a second of attention, and the answer they want is almost always a
// category rather than a name — "gas", not "the Shell on Cooper". So this is
// four fixed chips: tap one, get two or three real places off the route ahead,
// tap the one you want. Two taps, no keyboard, nothing to read while moving.
//
// Everything it shows comes from GET /api/v1/places/along-route, which cuts the
// route at the current position first. That is load-bearing: a corridor search
// around the whole trip returns the gas station you passed ten minutes ago, and
// a stop behind you is worse than no stop at all.
import { useEffect, useRef, useState } from 'react'

import { formatMiles } from '../lib/routeSummary'
import { useTripStore } from '../stores/useTripStore'

/** Backend PlaceCategory values (backend/mapdata/models.py) — never invent one. */
const CATEGORIES = [
  { category: 'fuel', label: 'Gas', icon: '⛽️' },
  { category: 'cafe', label: 'Coffee', icon: '☕️' },
  { category: 'restaurant', label: 'Food', icon: '🍔' },
  { category: 'ev_charging', label: 'Charging', icon: '🔌' },
] as const

type Category = (typeof CATEGORIES)[number]['category']

/** Three fits the sheet without scrolling and is already more choice than a
 *  driver wants to weigh at speed. */
const MAX_RESULTS = 3

const METERS_PER_MILE = 1609.344

interface PlaceHit {
  name: string
  lat: number
  lon: number
  detour_meters: number
  along_meters: number
}

/**
 * The one-line "why this one" under a candidate's name.
 *
 * Distance ahead first, because that is the decision — whether you can wait.
 * The detour is a one-way perpendicular offset from the route, not a routed
 * cost, so it is worded as "off route" and never as "+3 min": claiming minutes
 * we did not compute would be a lie the driver acts on.
 *
 * Under 80m of offset the place is on the road you are already on, and saying
 * "260 ft off route" about a forecourt you drive straight into reads as a
 * warning about nothing.
 *
 * The "right here" case is real and was shipped wrong once: a place beside the
 * car projects onto the route at ~zero metres along, which rendered as the
 * nonsense "0 ft ahead · 382 ft off route".
 */
// Exported for its unit test, which costs this file its fast-refresh purity.
// Worth it: the alternative is an untested string that a driver reads at speed.
// oxlint-disable-next-line react/only-export-components
export function formatStopMeta(hit: PlaceHit): string {
  const ahead =
    hit.along_meters < 60
      ? 'right here'
      : `${formatMiles(hit.along_meters / METERS_PER_MILE)} ahead`
  if (hit.detour_meters < 80) return `${ahead} · on the way`
  return `${ahead} · ${formatMiles(hit.detour_meters / METERS_PER_MILE)} off route`
}

export function AddStopBar() {
  const tripId = useTripStore((s) => s.tripId)
  const rerouting = useTripStore((s) => s.rerouting)
  const addStop = useTripStore((s) => s.addStop)

  const [open, setOpen] = useState<Category | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'error'>('idle')
  const [results, setResults] = useState<PlaceHit[]>([])
  const abortRef = useRef<AbortController | null>(null)

  // One in-flight request at a time. Tapping Gas then Coffee before the first
  // lands used to be a race whose winner was whichever provider answered
  // slower — the wrong list under the wrong heading.
  useEffect(() => {
    abortRef.current?.abort()
    if (!open || !tripId) return
    // Read once, from getState rather than a subscription: the live position
    // changes every second, and a dependency on it would re-fetch the list
    // under the driver's finger and move the row they were reaching for. The
    // snapped puck, not the raw fix — it sits on the route the backend is
    // about to trim. Origin is the fallback for the one degenerate case, a
    // drive whose first fix has not landed yet.
    const trip = useTripStore.getState()
    const from = trip.currentPosition ?? trip.origin
    if (!from) return
    const controller = new AbortController()
    abortRef.current = controller
    setStatus('loading')
    const query = new URLSearchParams({
      trip_id: tripId,
      category: open,
      from_lat: String(from.lat),
      from_lon: String(from.lng),
      limit: String(MAX_RESULTS),
    })
    fetch(`/api/v1/places/along-route?${query}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((data: { places: PlaceHit[] }) => {
        setResults(data.places)
        setStatus(data.places.length ? 'ready' : 'empty')
      })
      .catch((error) => {
        if (controller.signal.aborted || (error as Error)?.name === 'AbortError') return
        setStatus('error')
      })
    return () => controller.abort()
  }, [open, tripId])

  // No snap change on open, deliberately. The drive's peek height is
  // content-sized (see the :has(.trip-driving) rule in index.css), so the sheet
  // grows by exactly the three result rows and shrinks back on cancel. Raising
  // it to `half` instead was worse in both directions: half is a fixed 50dvh,
  // which clipped the third result AND the voice mic below it, and it left the
  // sheet at half after the picked stop rerouted.
  function openCategory(category: Category) {
    setResults([])
    setOpen(category)
  }

  function close() {
    setOpen(null)
    setStatus('idle')
    setResults([])
  }

  function pick(hit: PlaceHit) {
    // Mid-drive addStop reroutes in place rather than ending the trip, so the
    // sheet can collapse straight back to the driving view — `rerouting` is
    // what tells the user it took.
    addStop({ lat: hit.lat, lng: hit.lon, label: hit.name })
    close()
  }

  if (open) {
    const heading = CATEGORIES.find((c) => c.category === open)
    return (
      <div className="trip-addstop trip-addstop--open">
        <div className="trip-addstop-head">
          <span className="trip-addstop-title">
            <span aria-hidden>{heading?.icon}</span> {heading?.label} ahead
          </span>
          <button type="button" className="trip-addstop-close" onClick={close}>
            Cancel
          </button>
        </div>
        {status === 'loading' && <p className="trip-addstop-note">Looking ahead…</p>}
        {/* Not an error dialog: "nothing nearby" is a normal answer on a rural
            leg, and a modal in a moving car is the wrong response to it. */}
        {status === 'empty' && (
          <p className="trip-addstop-note">Nothing on the route ahead.</p>
        )}
        {status === 'error' && (
          <p className="trip-addstop-note">Couldn't look that up — try again.</p>
        )}
        {status === 'ready' && (
          <ul className="trip-addstop-results">
            {results.map((hit) => (
              <li key={`${hit.lat},${hit.lon},${hit.name}`}>
                <button
                  type="button"
                  className="trip-addstop-result"
                  onClick={() => pick(hit)}
                  disabled={rerouting}
                >
                  <span className="trip-addstop-name">{hit.name}</span>
                  <span className="trip-addstop-meta">{formatStopMeta(hit)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  return (
    <div className="trip-addstop" role="group" aria-label="Add a stop">
      {CATEGORIES.map(({ category, label, icon }) => (
        <button
          key={category}
          type="button"
          className="trip-addstop-chip"
          // A reroute is already in flight; a second stop queued behind it would
          // be routed against geometry that is about to be replaced.
          disabled={rerouting || !tripId}
          onClick={() => openCategory(category)}
        >
          <span aria-hidden>{icon}</span>
          <span className="trip-addstop-label">{label}</span>
        </button>
      ))}
    </div>
  )
}
