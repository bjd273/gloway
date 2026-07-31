// The turn card: what to do next, how far away it is, and which lane to be in.
//
// Floats at the top of the map rather than living in the sheet. While driving
// the sheet is pinned to its `peek` snap, so anything inside it is either
// clipped or down by the driver's knee — and this is the one thing on screen
// that has to be readable in a glance. Top of the map is also where a driver
// already looks: it sits over the far distance, not over the junction ahead.
import { useEffect, useRef } from 'react'

import { ICON_PATHS, iconForManeuver } from '../lib/maneuverIcons'
import { decodeLanes, laneHint, type DecodedLane, type LaneArrow } from '../lib/lanes'
import { formatDistanceToTurn } from '../lib/routeSummary'
import { useSheetStore } from '../stores/useSheetStore'
import { useTripStore } from '../stores/useTripStore'
import { useVoiceStore } from '../stores/useVoiceStore'

/** More than this and the arrows shrink past the point of being readable on a
 * phone. Wide interchanges get truncated rather than illegible. */
const MAX_LANES = 8

function ManeuverIcon({
  type,
  size,
  className,
}: {
  type?: number
  size: number
  className?: string
}) {
  const { name, mirrored } = iconForManeuver(type)
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {/* Right-hand turns are the left-hand path reflected, so the two can
          never drift apart. */}
      <g transform={mirrored ? 'translate(24,0) scale(-1,1)' : undefined}>
        <path d={ICON_PATHS[name]} />
      </g>
    </svg>
  )
}

/** Small arrows for the lane strip — flatter and wider than a maneuver icon,
 * closer to what's actually painted on tarmac. */
const LANE_ARROW_PATHS: Record<LaneArrow, string> = {
  uturn: 'M9 20v-8a3 3 0 0 1 6 0v4 M15 16l-2-2 M15 16l2-2',
  'sharp-left': 'M13 20v-6a2 2 0 0 0-2-2H7 M7 12l4-3 M7 12l4 3',
  left: 'M12 20v-6a2 2 0 0 0-2-2H6 M6 12l3.5-3.5 M6 12l3.5 3.5',
  'slight-left': 'M12 20v-6l-4-4 M8 10h4 M8 10v4',
  'merge-left': 'M12 20v-5c0-3-1.5-4.5-4-6 M8 9l3.5.8 M8 9l-.4-3.5',
  through: 'M12 20V5 M12 5l-3.5 3.5 M12 5l3.5 3.5',
  none: 'M12 20V5 M12 5l-3.5 3.5 M12 5l3.5 3.5',
  'merge-right': 'M12 20v-5c0-3 1.5-4.5 4-6 M16 9l-3.5.8 M16 9l.4-3.5',
  'slight-right': 'M12 20v-6l4-4 M16 10h-4 M16 10v4',
  right: 'M12 20v-6a2 2 0 0 1 2-2h4 M18 12l-3.5-3.5 M18 12l-3.5 3.5',
  'sharp-right': 'M11 20v-6a2 2 0 0 1 2-2h4 M17 12l-4-3 M17 12l-4 3',
}

function LaneStrip({ lanes }: { lanes: DecodedLane[] }) {
  const hint = laneHint(lanes)
  // No valid lane means either bad data or a junction you can't turn at, and
  // there's nothing actionable to show in either case.
  if (!hint) return null

  return (
    <div className="lane-strip" role="img" aria-label={hint}>
      {lanes.slice(0, MAX_LANES).map((lane, i) => (
        <span
          key={i}
          className={'lane' + (lane.valid ? ' lane--valid' : '')}
        >
          {lane.arrows.length === 0 ? (
            <span className="lane-blank" aria-hidden />
          ) : (
            lane.arrows.map((arrow) => (
              <svg
                key={arrow}
                className={
                  'lane-arrow' + (lane.active === arrow ? ' lane-arrow--active' : '')
                }
                width={18}
                height={18}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d={LANE_ARROW_PATHS[arrow]} />
              </svg>
            ))
          )}
        </span>
      ))}
    </div>
  )
}

export function TurnBanner() {
  const navPhase = useTripStore((s) => s.navPhase)
  const guidance = useTripStore((s) => s.guidance)
  const routes = useTripStore((s) => s.routes)
  const gpsSignalLost = useTripStore((s) => s.gpsSignalLost)
  const selectedIndex = useTripStore((s) => s.selectedIndex)
  const voiceGuidance = useVoiceStore((s) => s.voiceGuidance)
  const setVoiceGuidance = useVoiceStore((s) => s.setVoiceGuidance)
  const setBannerPx = useSheetStore((s) => s.setBannerPx)
  const ref = useRef<HTMLDivElement | null>(null)

  const driving = navPhase === 'navigating' && guidance !== null

  // Publish the measured height so MapView can keep the road ahead clear of it.
  // Measured rather than a constant: the card is 40-90px depending on whether
  // the "then" row and the lane strip are there.
  useEffect(() => {
    const element = ref.current
    if (!element) {
      setBannerPx(0)
      return
    }
    const observer = new ResizeObserver(() => {
      // Border box, not entry.contentRect — that excludes the card's padding
      // and border, which here is 26px. Anything positioned against a
      // too-short banner ends up tucked under its bottom edge.
      const height = element.getBoundingClientRect().height
      setBannerPx(height)
      // Also as a CSS variable, so the re-centre pill can sit below the banner
      // without React having to re-render it.
      document.documentElement.style.setProperty('--gw-banner-h', `${height}px`)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      setBannerPx(0)
      document.documentElement.style.setProperty('--gw-banner-h', '0px')
    }
  }, [driving, setBannerPx])

  if (!driving) return null

  const route = routes[selectedIndex]
  const step = route?.steps[guidance.stepIndex]
  if (!step) return null

  const next =
    guidance.nextStepIndex !== null ? route.steps[guidance.nextStepIndex] : undefined
  const lanes = decodeLanes(step.lanes)
  const exitNumber = step.sign?.exitNumbers?.[0]
  const toward = step.sign?.exitToward?.slice(0, 2).join(' / ')

  return (
    <div className="turn-banner" ref={ref} role="group" aria-label="Next turn">
      {/* The distance changes every second. An aria-live region on the banner
          itself would have a screen reader reciting it for the whole drive, so
          only the instruction is announced, and only when the step changes. */}
      <p className="gw-sr-only" aria-live="polite">
        {step.text}
      </p>

      {/* Says why the puck has stopped moving. Without it a tunnel looks
          identical to the app being broken — and it used to BE broken: any
          watchPosition error ended the drive, so a twenty-second tunnel killed
          the trip. The drive is still live here; the position is just stale. */}
      {gpsSignalLost && (
        <p className="turn-banner-signal" role="status">
          <span aria-hidden>📡</span> Waiting for GPS — your position is paused
        </p>
      )}

      <div className="turn-banner-main">
        <ManeuverIcon className="turn-banner-icon" type={step.type} size={40} />
        <div className="turn-banner-text">
          <span className="turn-banner-distance">
            {formatDistanceToTurn(guidance.metersToManeuver)}
          </span>
          <span className="turn-banner-instruction">
            {exitNumber && <span className="turn-banner-exit">Exit {exitNumber}</span>}
            {step.text}
          </span>
          {toward && <span className="turn-banner-toward">toward {toward}</span>}
        </div>
        <button
          type="button"
          className={'turn-banner-mute' + (voiceGuidance ? '' : ' turn-banner-mute--off')}
          onClick={() => setVoiceGuidance(!voiceGuidance)}
          aria-pressed={!voiceGuidance}
          aria-label={voiceGuidance ? 'Mute turn announcements' : 'Unmute turn announcements'}
        >
          <span aria-hidden>{voiceGuidance ? '🔊' : '🔇'}</span>
        </button>
      </div>

      {next && (
        <div className="turn-banner-then">
          <span>then</span>
          <ManeuverIcon type={next.type} size={16} />
          <span className="turn-banner-then-text">{next.streetNames?.[0] ?? next.text}</span>
        </div>
      )}

      <LaneStrip lanes={lanes} />
    </div>
  )
}
