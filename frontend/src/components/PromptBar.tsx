// The "Where to?" bar — Gloway's front door. It geocodes while you're
// choosing a destination; once a trip is set, the same shell hosts the
// Phase 2 conversation layer (see Conversation.tsx) — the surface never
// had to move, as designed.
import { useEffect, useRef, useState } from 'react'

import { searchPlaces, type SearchResult } from '../lib/api'
import { inRegion, OUT_OF_AREA_MESSAGE } from '../lib/region'
import { useTripStore } from '../stores/useTripStore'
import { useUserStore } from '../stores/useUserStore'
import { Conversation } from './Conversation'

interface Suggestion extends SearchResult {
  pickable: boolean
}

/** "AT&T Stadium, 1, AT&T Way, Arlington, …" -> "AT&T Stadium" + the rest. */
function splitName(displayName: string): { title: string; detail: string } {
  const [title, ...rest] = displayName.split(', ')
  return { title, detail: rest.slice(0, 3).join(', ') }
}

export function PromptBar() {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

  const destination = useTripStore((s) => s.destination)
  const origin = useTripStore((s) => s.origin)
  const setDestination = useTripStore((s) => s.setDestination)
  const clearTrip = useTripStore((s) => s.clearTrip)
  const journey = useUserStore((s) => s.journey)

  const savedPlaces = [
    { key: 'home' as const, label: 'Home', icon: '🏠', place: journey?.home_location ?? null },
    { key: 'work' as const, label: 'Work', icon: '💼', place: journey?.work_location ?? null },
  ].filter((p) => p.place)

  // Debounced search-as-you-type.
  useEffect(() => {
    abortRef.current?.abort()
    if (query.trim().length < 3) {
      setSuggestions([])
      setIsSearching(false)
      return
    }
    setIsSearching(true)
    const controller = new AbortController()
    abortRef.current = controller
    const timer = setTimeout(async () => {
      try {
        const results = await searchPlaces(query.trim(), controller.signal)
        setSuggestions(
          results.map((r) => ({ ...r, pickable: inRegion(r.lat, r.lon) })),
        )
        setHighlighted(0)
      } catch {
        if (!controller.signal.aborted) setSuggestions([])
      } finally {
        if (!controller.signal.aborted) setIsSearching(false)
      }
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  function pick(s: Suggestion) {
    if (!s.pickable) return
    setDestination({ lat: s.lat, lng: s.lon, label: splitName(s.display_name).title })
    setQuery('')
    setSuggestions([])
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((h) => Math.min(h + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const firstPickable = suggestions[highlighted]?.pickable
        ? suggestions[highlighted]
        : suggestions.find((s) => s.pickable)
      if (firstPickable) pick(firstPickable)
    } else if (e.key === 'Escape') {
      setSuggestions([])
    }
  }

  const anyPickable = suggestions.some((s) => s.pickable)
  const showDropdown = query.trim().length >= 3 && (suggestions.length > 0 || !isSearching)

  // Destination set: collapse to a trip header.
  if (destination) {
    return (
      <div className="prompt-shell">
        <div className="prompt-bar prompt-bar--set">
          <span className="prompt-dest">
            <span className="prompt-dest-dot" />
            {destination.label ?? 'Destination'}
          </span>
          <button className="prompt-clear" onClick={clearTrip} aria-label="Clear trip">
            ✕
          </button>
        </div>
        {origin && (
          <div className="prompt-from">
            from <strong>{origin.label ?? 'Starting point'}</strong> — drag either pin to adjust
          </div>
        )}
        <Conversation />
      </div>
    )
  }

  return (
    <div className="prompt-shell">
      <div className="prompt-bar">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Where to?"
          aria-label="Where to?"
          autoFocus
        />
        {isSearching && <span className="prompt-spinner" aria-hidden />}
      </div>

      {!showDropdown && savedPlaces.length > 0 && (
        <div className="prompt-shortcuts">
          {savedPlaces.map(({ key, label, icon, place }) => (
            <button
              key={key}
              className="prompt-shortcut"
              onClick={() =>
                setDestination({ lat: place!.lat, lng: place!.lon, label })
              }
            >
              <span aria-hidden>{icon}</span> {label}
            </button>
          ))}
        </div>
      )}

      {showDropdown && (
        <div className="prompt-responses" role="listbox">
          {suggestions.map((s, i) => (
            <button
              key={`${s.lat},${s.lon}`}
              role="option"
              aria-selected={i === highlighted}
              className={
                'suggestion' +
                (i === highlighted ? ' suggestion--active' : '') +
                (s.pickable ? '' : ' suggestion--away')
              }
              onClick={() => pick(s)}
              onMouseEnter={() => setHighlighted(i)}
              disabled={!s.pickable}
            >
              <span className="suggestion-title">{splitName(s.display_name).title}</span>
              <span className="suggestion-detail">
                {s.pickable ? splitName(s.display_name).detail : 'Outside the current area'}
              </span>
            </button>
          ))}
          {suggestions.length > 0 && !anyPickable && (
            <div className="prompt-note">{OUT_OF_AREA_MESSAGE}</div>
          )}
          {suggestions.length === 0 && !isSearching && (
            <div className="prompt-note">
              Nothing found for “{query.trim()}” — {OUT_OF_AREA_MESSAGE}
            </div>
          )}
          {suggestions.length > 0 && anyPickable && suggestions.some((s) => !s.pickable) && (
            <div className="prompt-note prompt-note--footer">{OUT_OF_AREA_MESSAGE}</div>
          )}
        </div>
      )}
    </div>
  )
}
