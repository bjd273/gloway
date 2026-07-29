// Remembers what a saved coordinate was called when the user picked it.
//
// The journey profile stores home and work as bare {lat, lon} — there is no
// address field anywhere in the model — so without this, searching for
// "1200 Ballpark Way", saving it, and reopening settings shows "32.7513,
// -97.0829". The feature works and looks broken.
//
// TODO: the real fix is home_label / work_label on the backend journey model.
// This cache is device-local and is NOT truth: it survives reloads on this
// browser only, and a new device falls back to coordinates. It is never used
// for routing or sent anywhere — purely what to print next to the row.

const STORAGE_KEY = 'gloway:placeLabels'

/**
 * ~11 m of precision. Enough that the same saved place round-trips to the same
 * key, coarse enough that a re-picked address doesn't miss by a float wobble.
 */
function keyFor(lat: number, lon: number): string {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`
}

function read(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    // Private mode, quota, or hand-edited junk — a missing label is cosmetic.
    return {}
  }
}

export function rememberPlaceLabel(lat: number, lon: number, label: string): void {
  if (!label.trim()) return
  try {
    const all = read()
    all[keyFor(lat, lon)] = label.trim()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // Ignore: losing a label is not worth surfacing an error for.
  }
}

export function lookupPlaceLabel(lat: number, lon: number): string | null {
  return read()[keyFor(lat, lon)] ?? null
}

/** What to print for a saved place: its remembered name, else its coordinates. */
export function describePlace(lat: number, lon: number): string {
  return lookupPlaceLabel(lat, lon) ?? `${lat.toFixed(4)}, ${lon.toFixed(4)}`
}
