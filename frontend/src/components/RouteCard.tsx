// One route option, as something a driver can actually choose between.
//
// Before this, six candidates rendered as six bare minute-chips — the user had
// more choices than ever and no basis to pick. The three things that make a
// choice possible are all here: what this route IS (its label), what it COSTS
// relative to the recommendation (the delta), and WHY it differs (the reason).
//
// The leading stroke is a map-legend swatch drawn in the same colour as this
// route's line, not a decorative accent bar — its whole job is to answer "which
// line on the map is this card?".
import type { ParsedRoute } from '../lib/api'
import { formatDelta, formatMinutes, routeReason } from '../lib/routeSummary'

interface Props {
  route: ParsedRoute
  /** Resolved by `routeLabels` across the whole set — not `route.label`, which
   * is "Another way" for every alternate Valhalla threw in. */
  label: string
  index: number
  isSelected: boolean
  isRecommended: boolean
  /** Minutes relative to the recommended route. Zero for the recommendation. */
  deltaMinutes: number
  lineColor: string
  onSelect(index: number): void
  onHover(index: number | null): void
}

export function RouteCard({
  route,
  label,
  index,
  isSelected,
  isRecommended,
  deltaMinutes,
  lineColor,
  onSelect,
  onHover,
}: Props) {
  const delta = isRecommended ? null : formatDelta(deltaMinutes)

  return (
    <button
      type="button"
      className={'route-card' + (isSelected ? ' route-card--selected' : '')}
      style={{ '--route-line': lineColor } as React.CSSProperties}
      aria-pressed={isSelected}
      onClick={() => onSelect(index)}
      // Pointer and focus both preview, so the map highlight is reachable by
      // keyboard too. Touch has no hover — there the tap itself is the preview.
      onPointerEnter={() => onHover(index)}
      onPointerLeave={() => onHover(null)}
      onFocus={() => onHover(index)}
      onBlur={() => onHover(null)}
    >
      <span className="route-card-swatch" aria-hidden />
      <span className="route-card-body">
        <span className="route-card-title">
          <span className="route-card-label">{label}</span>
          <span className="route-card-time">{formatMinutes(route.minutes)}</span>
          {delta && (
            <span className="route-card-delta">
              {delta}
              <span className="gw-sr-only"> minutes versus the recommended route</span>
            </span>
          )}
        </span>
        <span className="route-card-reason">
          {routeReason(route)}
          {isRecommended && <span className="route-card-tag">Recommended</span>}
        </span>
      </span>
    </button>
  )
}
