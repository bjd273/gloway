// The Gloway mark: the teal paper-plane / navigation star on a lime tile,
// plus the lowercase wordmark. Same geometry as public/favicon.svg — keep the
// two in sync when the logo changes.
import { useTripStore } from '../stores/useTripStore'

export function Wordmark() {
  // Stands down during a drive. The turn banner claims the top of the screen
  // and is wider than this, so leaving the wordmark up would put branding
  // underneath the one thing on screen that has to be read at speed.
  const navPhase = useTripStore((s) => s.navPhase)
  if (navPhase === 'navigating') return null

  return (
    <div className="wordmark" aria-hidden>
      <svg width="20" height="20" viewBox="0 0 32 32" fill="none">
        <rect width="32" height="32" rx="7" fill="#c0ff71" />
        {/* star points / shards around the plane */}
        <path d="M10 2 L19.5 5.2 L11.5 9 Z" fill="#05767a" />
        <path d="M26.4 12.8 L30.6 20.6 L23.4 20.4 Z" fill="#02a4aa" />
        <path d="M4.5 22.5 L12 20 L8.8 29.5 Z" fill="#05767a" />
        {/* the paper plane: bright dart + darker spine crease */}
        <path d="M30 2 L2.6 14 L17.6 30.6 Z" fill="#3ee7ed" />
        <path d="M30 2 L17.6 30.6 L20.6 16.4 Z" fill="#1ec9cf" />
      </svg>
      <span>gloway</span>
    </div>
  )
}
