// Address search, shared by the sheet's destination field and the home/work
// rows in settings. Both live inside an already-glass surface, so the field is
// a solid pill and the results a flat list — glass on glass reads as mud.
//
// Extracted so the two can't drift: the debounce, the abort-on-retype, the
// out-of-region handling and the keyboard model are subtle enough that a
// second copy would quietly diverge.
import { useEffect, useRef, useState } from 'react'

import { searchPlaces, type SearchResult } from '../lib/api'
import { inRegion, OUT_OF_AREA_MESSAGE } from '../lib/region'

interface Suggestion extends SearchResult {
  pickable: boolean
}

/** "AT&T Stadium, 1, AT&T Way, Arlington, …" -> "AT&T Stadium" + the rest. */
function splitName(displayName: string): { title: string; detail: string } {
  const [title, ...rest] = displayName.split(', ')
  return { title, detail: rest.slice(0, 3).join(', ') }
}

interface Props {
  placeholder: string
  ariaLabel: string
  autoFocus?: boolean
  /** Rendered between the field and the results when nothing is being searched. */
  children?: React.ReactNode
  onPick(result: SearchResult, title: string): void
}

export function PlaceSearchField({
  placeholder,
  ariaLabel,
  autoFocus,
  children,
  onPick,
}: Props) {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

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
        setSuggestions(results.map((r) => ({ ...r, pickable: inRegion(r.lat, r.lon) })))
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
    onPick(s, splitName(s.display_name).title)
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
      const target = suggestions[highlighted]?.pickable
        ? suggestions[highlighted]
        : suggestions.find((s) => s.pickable)
      if (target) pick(target)
    } else if (e.key === 'Escape') {
      setSuggestions([])
    }
  }

  const anyPickable = suggestions.some((s) => s.pickable)
  const showDropdown = query.trim().length >= 3 && (suggestions.length > 0 || !isSearching)

  return (
    <>
      <div className="place-search-bar">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={ariaLabel}
          autoFocus={autoFocus}
        />
        {isSearching && <span className="prompt-spinner" aria-hidden />}
      </div>

      {!showDropdown && children}

      {showDropdown && (
        <div className="place-results" role="listbox">
          {suggestions.map((s, i) => (
            <button
              // Index, not coordinates: the merged Overture + Nominatim
              // geocoder can return distinct places at identical lat/lon
              // ("Levitt Pavilion"). The list is rebuilt wholesale per query
              // and never reorders, so the index is stable enough.
              key={i}
              type="button"
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
    </>
  )
}
