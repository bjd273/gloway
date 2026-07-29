// Formatting for the route cards. Pure functions, no React, no store — this is
// the file worth testing, because it is where "six unlabelled minute-chips"
// turns into something a driver can choose from at a glance.

import type { ParsedRoute } from './api'

export function formatMinutes(minutes: number): string {
  // Floors at 1: a 40-second hop is "1 min", never "0 min".
  const total = Math.max(1, Math.round(minutes))
  if (total < 60) return `${total} min`
  const hours = Math.floor(total / 60)
  const rest = total % 60
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`
}

export function formatMiles(miles: number): string {
  if (miles < 0.2) return `${Math.round(miles * 5280)} ft`
  return `${miles.toFixed(1)} mi`
}

/**
 * Time cost of a route relative to the recommended one.
 *
 * Returns null when the difference rounds away — a card reading "(+0)" implies
 * a distinction that isn't there, and the recommended route itself has no
 * delta to show. Uses a real minus sign, not a hyphen.
 */
export function formatDelta(deltaMinutes: number): string | null {
  const rounded = Math.round(deltaMinutes)
  if (rounded === 0) return null
  return rounded > 0 ? `+${rounded}` : `−${Math.abs(rounded)}`
}

/**
 * The one-line "why" under a route's name: distance, then at most one reason
 * this route is different from the others.
 *
 * Keyed off the machine `strategy` rather than the display `label`, because
 * labels are user-facing copy the backend expects to reword. An unknown or
 * missing strategy falls back to turn count, which is always true.
 */
export function routeReason(route: ParsedRoute): string {
  const distance = formatMiles(route.miles)
  const turns = route.steps.length

  switch (route.strategy) {
    case 'avoid_highways':
      return `${distance} · surface streets`
    case 'fewest_turns':
      return `${distance} · ${turns} turns`
    case 'shortest_distance':
      return `${distance} · shortest way`
    case 'relaxed':
    case 'quiet':
      return `${distance} · calmer roads`
    case 'avoid_tolls':
      return `${distance} · no tolls`
    case 'well_lit':
      return `${distance} · lit streets`
    case 'fewer_steps':
      return `${distance} · fewer stairs`
  }

  // No strategy-specific angle. Valhalla's summary flags can still add one, but
  // only when they're definitively false — these are emitted on some builds and
  // costings only, so `undefined` means "unknown" and must stay silent.
  if (route.hasHighway === false) return `${distance} · surface streets`
  if (route.hasToll === false) return `${distance} · no tolls`
  return `${distance} · ${turns} turns`
}

// Postal abbreviations, keyed lowercase. Only the forms a driver reads without
// thinking — the point is to shorten "South Collins Street" to something
// glanceable at 40mph, not to be exhaustive. Anything not here is left alone,
// which is what keeps route numbers ("TX 180", "FM 157", "I-30") untouched:
// they contain no directional and no type word.
const DIRECTIONS: Record<string, string> = {
  north: 'N',
  south: 'S',
  east: 'E',
  west: 'W',
  northeast: 'NE',
  northwest: 'NW',
  southeast: 'SE',
  southwest: 'SW',
}

const STREET_TYPES: Record<string, string> = {
  street: 'St',
  road: 'Rd',
  drive: 'Dr',
  avenue: 'Ave',
  boulevard: 'Blvd',
  lane: 'Ln',
  trail: 'Trl',
  court: 'Ct',
  place: 'Pl',
  parkway: 'Pkwy',
  highway: 'Hwy',
  circle: 'Cir',
  terrace: 'Ter',
  square: 'Sq',
  expressway: 'Expy',
  freeway: 'Fwy',
  turnpike: 'Tpke',
  crossing: 'Xing',
  point: 'Pt',
  plaza: 'Plz',
}

/** Strip trailing punctuation so "Street," still matches. */
const key = (token: string) => token.toLowerCase().replace(/[.,]+$/, '')

/**
 * Shorten a road name the way a street sign does: "South Collins Street"
 * becomes "S Collins St".
 *
 * Valhalla returns full USPS-style names, which are correct and too long for a
 * route card — the label has to share a line with a time and a delta. These
 * abbreviations are the ones every US driver already reads without decoding.
 *
 * Three guards, each protecting a real name rather than a hypothetical:
 *
 *  - The type word is abbreviated only as the LAST token, so "Avenue H" keeps
 *    its avenue and "Trail Lake Drive" becomes "Trail Lake Dr" rather than
 *    "Trl Lake Dr" — the leading "Trail" is part of the name, not its type.
 *  - The leading directional needs 3+ tokens, so a street genuinely called
 *    "North Street" reads "North St" and not the cryptic "N St".
 *  - Matching is case-insensitive but the rest of the name keeps whatever
 *    casing it arrived with; nothing is title-cased or otherwise rewritten.
 */
export function abbreviateRoad(name: string): string {
  const tokens = name.trim().split(/\s+/)
  if (tokens.length < 2) return name

  // Trailing directional first ("Cooper Street South"), so the type check
  // below still sees the type word in final position.
  const lastKey = key(tokens[tokens.length - 1])
  let trailingDirection: string | undefined
  if (tokens.length >= 3 && DIRECTIONS[lastKey]) {
    trailingDirection = DIRECTIONS[lastKey]
    tokens.pop()
  }

  const typeKey = key(tokens[tokens.length - 1])
  if (tokens.length >= 2 && STREET_TYPES[typeKey]) {
    tokens[tokens.length - 1] = STREET_TYPES[typeKey]
  }

  if (tokens.length >= 3 && DIRECTIONS[key(tokens[0])]) {
    tokens[0] = DIRECTIONS[key(tokens[0])]
  }

  if (trailingDirection) tokens.push(trailingDirection)
  return tokens.join(' ')
}

/**
 * The name on each card, resolved for the whole set at once.
 *
 * The backend only names the route each strategy purpose-built ("No highways",
 * "Fewest turns"). Valhalla's own alternates ride along with every strategy
 * call and are all labelled "Another way" — so on a short trip, where only the
 * baseline strategy runs, the entire list reads "Fastest" then "Another way"
 * four times. Which is accurate and useless: the user has four choices and
 * nothing to choose on.
 *
 * Those routes are genuinely just *different roads*, so that is what we call
 * them — "via Cooper St", the same thing Google and Apple say, off the street
 * names Valhalla already sends.
 *
 * Takes and returns the whole array rather than working per-route because the
 * de-duplication needs the full picture: two alternates that happen to share a
 * dominant road would otherwise both render "via Cooper St", which is a worse
 * lie than "Another way" — it claims a distinction and gets it wrong.
 */
export function routeLabels(routes: ParsedRoute[]): string[] {
  const used = new Set<string>()
  // Superlatives are computed against the whole set, so "Shortest" means
  // shortest of what's on offer — the only sense in which it's checkable.
  const fewestTurns = Math.min(...routes.map((r) => r.steps.length))
  const shortest = Math.min(...routes.map((r) => r.miles))

  return routes.map((route) => {
    // A strategy built this one on purpose; its name is the real answer.
    if (route.isPrimary !== false) {
      used.add(route.label)
      return route.label
    }
    const via = route.viaRoad && `via ${abbreviateRoad(route.viaRoad)}`
    if (via && !used.has(via)) {
      used.add(via)
      return via
    }
    // No usable road name — fall back to whatever this route is measurably
    // best at. Still only claims something true of the set as shown.
    for (const [isBest, name] of [
      [route.miles === shortest, 'Shortest'],
      [route.steps.length === fewestTurns, 'Fewest turns'],
    ] as const) {
      if (isBest && !used.has(name)) {
        used.add(name)
        return name
      }
    }
    return route.label
  })
}

/**
 * Display order for the cards: recommended first, backend order preserved
 * behind it.
 *
 * The array itself is never reordered — `properties.index` on the map features
 * is the click contract, and the backend's own ordering (baseline, then the
 * strategy sweep, then Valhalla's extras) already carries meaning.
 */
export function routeDisplayOrder(count: number, recommendedIndex: number): number[] {
  const rest = []
  for (let i = 0; i < count; i++) if (i !== recommendedIndex) rest.push(i)
  return recommendedIndex >= 0 && recommendedIndex < count ? [recommendedIndex, ...rest] : rest
}
