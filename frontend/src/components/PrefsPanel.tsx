// Driving preferences — the gear in the top-right corner.
//
// First open (no account yet): one email field, because preferences need
// somewhere to live. After that: four routing switches, your places (home /
// work — context the assistant uses), and how chatty the assistant should
// be. Everything PATCHes the backend; routing switches also re-request the
// current route so the map answers immediately.
import { useEffect, useState } from 'react'

import type { JourneyProfile, LatLon, UserPrefs } from '../lib/api'
import { LOCATION_FAILURE_MESSAGE, requestCurrentLocation } from '../lib/geolocate'
import { describePlace, rememberPlaceLabel } from '../lib/placeLabels'
import { useTripStore } from '../stores/useTripStore'
import { useUserStore } from '../stores/useUserStore'
import { PlaceSearchField } from './PlaceSearchField'

type PlaceKey = 'home_location' | 'work_location'

const PREF_ITEMS: { key: keyof UserPrefs; label: string }[] = [
  { key: 'avoid_highways', label: 'Avoid highways' },
  { key: 'avoid_tolls', label: 'Avoid tolls' },
  { key: 'avoid_left_turns', label: 'Fewer turns' },
  { key: 'prefer_scenic', label: 'Prefer scenic streets' },
]

const PLACES: { key: PlaceKey; label: string }[] = [
  { key: 'home_location', label: 'Home' },
  { key: 'work_location', label: 'Work' },
]

const CONVO_STYLES: JourneyProfile['preferred_convo_style'][] = ['brief', 'chatty', 'silent']

function formatPlace(place: LatLon | null): string {
  if (!place) return 'Not set'
  // The name the user picked, when this browser still remembers it. The
  // backend stores coordinates only.
  return describePlace(place.lat, place.lon)
}

export function PrefsPanel() {
  const [open, setOpen] = useState(false)
  const navPhase = useTripStore((s) => s.navPhase)
  const [emailInput, setEmailInput] = useState('')
  /** Which place row is in edit mode, if any. */
  const [editing, setEditing] = useState<PlaceKey | null>(null)
  /** Row currently being written — setPlace is not optimistic, so without this
   *  the button looks dead for the length of the PATCH. */
  const [savingPlace, setSavingPlace] = useState<PlaceKey | null>(null)
  const [placeError, setPlaceError] = useState<string | null>(null)

  const userId = useUserStore((s) => s.userId)
  const email = useUserStore((s) => s.email)
  const prefs = useUserStore((s) => s.prefs)
  const journey = useUserStore((s) => s.journey)
  const busy = useUserStore((s) => s.busy)
  const errorMessage = useUserStore((s) => s.errorMessage)
  const register = useUserStore((s) => s.register)
  const setPref = useUserStore((s) => s.setPref)
  const loadProfile = useUserStore((s) => s.loadProfile)
  const setPlace = useUserStore((s) => s.setPlace)
  const setConvoStyle = useUserStore((s) => s.setConvoStyle)

  // Fresh journey data every time the panel opens (it changes server-side
  // as conversations extract facts).
  useEffect(() => {
    if (open && userId) void loadProfile()
  }, [open, userId, loadProfile])

  // Preferences is itself a bottom sheet, so while it's open the trip sheet
  // underneath recedes — two stacked sheets read as a mistake. A body attribute
  // rather than lifted state: nothing else needs to know.
  useEffect(() => {
    if (!open) return
    document.body.dataset.prefsOpen = 'true'
    return () => {
      delete document.body.dataset.prefsOpen
    }
  }, [open])

  async function onRegister(e: React.FormEvent) {
    e.preventDefault()
    if (!emailInput.trim()) return
    await register(emailInput)
  }

  /** Write one place and close its editor. Label is remembered locally. */
  async function savePlace(key: PlaceKey, lat: number, lon: number, label?: string) {
    setPlaceError(null)
    setSavingPlace(key)
    if (label) rememberPlaceLabel(lat, lon, label)
    const saved = await setPlace(key, { lat, lon })
    setSavingPlace(null)
    if (saved) setEditing(null)
  }

  /** "Use my current location" — unlike routing, this one reports failure
   *  rather than quietly falling back to the map centre, which would save the
   *  wrong address without saying so.
   *  (Not named use* — that reads as a React hook to the linter.) */
  async function saveCurrentLocation(key: PlaceKey) {
    setPlaceError(null)
    setSavingPlace(key)
    const result = await requestCurrentLocation()
    if (!result.ok) {
      setSavingPlace(null)
      setPlaceError(LOCATION_FAILURE_MESSAGE[result.reason])
      return
    }
    setSavingPlace(null)
    await savePlace(key, result.place.lat, result.place.lng, 'Current location')
  }

  async function onToggle(key: keyof UserPrefs) {
    const saved = await setPref(key, !prefs[key])
    if (saved) useTripStore.getState().refreshRoute()
  }

  return (
    <>
      <button
        // The turn banner claims the top strip during a drive, and this sits
        // above everything at z-index 30 — so without moving it the gear
        // renders on top of the banner and covers its mute button.
        className={'prefs-button' + (navPhase === 'navigating' ? ' prefs-button--below-banner' : '')}
        aria-label="Driving preferences"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
          <path
            fill="currentColor"
            d="M12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Zm7.4-2.6c.04-.3.06-.6.06-.9s-.02-.6-.07-.9l2.03-1.58a.5.5 0 0 0 .12-.63l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.4.96a7.3 7.3 0 0 0-1.55-.9l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.56.23-1.07.54-1.55.9l-2.4-.96a.5.5 0 0 0-.6.22L3.05 8.83a.5.5 0 0 0 .12.63l2.03 1.58c-.05.3-.07.61-.07.91s.02.6.07.9l-2.03 1.58a.5.5 0 0 0-.12.63l1.92 3.32c.13.22.39.31.6.22l2.4-.96c.48.36.99.67 1.55.9l.36 2.54c.04.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54a7.3 7.3 0 0 0 1.55-.9l2.4.96c.21.09.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.63l-2.03-1.58Z"
          />
        </svg>
      </button>

      {open && (
        <div className="prefs-panel" role="dialog" aria-label="Driving preferences">
          {!userId ? (
            <form className="prefs-signup" onSubmit={onRegister}>
              <span className="prefs-title">Make Gloway yours</span>
              <p className="prefs-hint">
                An email is all it takes — your preferences ride along on every route.
              </p>
              <input
                type="email"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                placeholder="you@example.com"
                aria-label="Email"
                autoFocus
              />
              <button type="submit" className="prefs-save" disabled={busy}>
                {busy ? 'Saving…' : "Let's go"}
              </button>
            </form>
          ) : (
            <>
              <span className="prefs-title">How you like to drive</span>
              {PREF_ITEMS.map(({ key, label }) => (
                <label key={key} className="pref-row">
                  <span>{label}</span>
                  <input
                    type="checkbox"
                    checked={prefs[key]}
                    onChange={() => void onToggle(key)}
                  />
                </label>
              ))}

              <span className="prefs-title">Your places</span>
              {PLACES.map(({ key, label }) => {
                const place = journey?.[key] ?? null
                const isEditing = editing === key
                const isSaving = savingPlace === key

                if (!isEditing) {
                  return (
                    <div key={key} className="place-row">
                      <span className="place-label">{label}</span>
                      <span className="place-value">{formatPlace(place)}</span>
                      <button
                        className="place-action"
                        onClick={() => {
                          setPlaceError(null)
                          setEditing(key)
                        }}
                      >
                        {place ? 'Change' : 'Set'}
                      </button>
                      {place && (
                        <button
                          className="place-action place-action--clear"
                          aria-label={`Clear ${label.toLowerCase()}`}
                          onClick={() => void setPlace(key, null)}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  )
                }

                return (
                  <div key={key} className="place-edit">
                    <span className="place-label">{label}</span>
                    <PlaceSearchField
                      placeholder={`Search for your ${label.toLowerCase()} address`}
                      ariaLabel={`Search for your ${label.toLowerCase()} address`}
                      autoFocus
                      onPick={(result, title) =>
                        void savePlace(key, result.lat, result.lon, title)
                      }
                    >
                      <div className="place-edit-actions">
                        <button
                          className="place-action"
                          disabled={isSaving}
                          onClick={() => void saveCurrentLocation(key)}
                        >
                          {isSaving ? 'Locating…' : '📍 Current location'}
                        </button>
                        <button
                          className="place-action"
                          disabled={isSaving}
                          onClick={() => {
                            const c = useTripStore.getState().mapCenter
                            void savePlace(key, c.lat, c.lng)
                          }}
                        >
                          Map center
                        </button>
                        <button
                          className="place-action"
                          onClick={() => {
                            setEditing(null)
                            setPlaceError(null)
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </PlaceSearchField>
                    {placeError && <div className="prefs-error">{placeError}</div>}
                  </div>
                )
              })}

              <span className="prefs-title">How chatty?</span>
              <div className="trip-chips">
                {CONVO_STYLES.map((style) => (
                  <button
                    key={style}
                    className={
                      'trip-chip' +
                      (journey?.preferred_convo_style === style ? ' trip-chip--active' : '')
                    }
                    onClick={() => void setConvoStyle(style)}
                  >
                    {style}
                  </button>
                ))}
              </div>

              <span className="prefs-footer">{email}</span>
            </>
          )}
          {errorMessage && <div className="prefs-error">{errorMessage}</div>}
        </div>
      )}
    </>
  )
}
