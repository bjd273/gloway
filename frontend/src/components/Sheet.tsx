// The bottom sheet shell: snap heights, drag, and height publishing. Knows
// nothing about trips — TripSheet supplies the content.
//
// Replaces the old two-panel layout, where a top prompt shell and a bottom trip
// panel sandwiched the map into a sliver exactly when the map mattered most.
// One surface, three heights, and the map keeps the majority of the screen.
import { useEffect, useRef } from 'react'

import { resolveSnap, useSheetStore, type Snap } from '../stores/useSheetStore'

/** Below this the sheet is a fixed rail, not a draggable sheet. */
const WIDE = '(min-width: 768px)'

interface Props {
  children: React.ReactNode
}

export function Sheet({ children }: Props) {
  const snap = useSheetStore((s) => s.snap)
  const setSnap = useSheetStore((s) => s.setSnap)
  const cycleSnap = useSheetStore((s) => s.cycleSnap)
  const setHeightPx = useSheetStore((s) => s.setHeightPx)

  const elRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    startY: number
    startHeight: number
    lastY: number
    lastT: number
    velocity: number
  } | null>(null)

  // Publish the measured height twice: as a CSS variable, so the assistant
  // bubble can ride above the sheet without prop-drilling, and into the store
  // for MapView's fit padding.
  useEffect(() => {
    const el = elRef.current
    if (!el) return
    const publish = (px: number) => {
      document.documentElement.style.setProperty('--gw-sheet-h', `${Math.round(px)}px`)
      setHeightPx(px)
    }
    publish(el.getBoundingClientRect().height)
    // Border-box, not contentRect: the sheet carries a safe-area bottom padding
    // that contentRect excludes, and both consumers (the bubble's offset and
    // the map's fit padding) need the height the sheet actually occupies.
    const observer = new ResizeObserver(([entry]) =>
      publish(entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height),
    )
    observer.observe(el, { box: 'border-box' })
    return () => observer.disconnect()
  }, [setHeightPx])

  function onPointerDown(e: React.PointerEvent) {
    if (window.matchMedia(WIDE).matches) return
    const el = elRef.current
    if (!el) return
    // A drag may start on the grabber or on dead space, but never on another
    // control — a press on "Start drive" must stay a press.
    const control = (e.target as HTMLElement).closest('button, input, a, [role="listbox"]')
    if (control && !(control as HTMLElement).dataset.grabber) return
    el.setPointerCapture(e.pointerId)
    dragRef.current = {
      startY: e.clientY,
      startHeight: el.getBoundingClientRect().height,
      lastY: e.clientY,
      lastT: performance.now(),
      velocity: 0,
    }
    el.dataset.dragging = 'true'
  }

  function onPointerMove(e: React.PointerEvent) {
    const drag = dragRef.current
    const el = elRef.current
    if (!drag || !el) return
    const viewport = window.innerHeight
    // Dragging up (negative dy) grows the sheet.
    const raw = drag.startHeight + (drag.startY - e.clientY)
    const min = 0.12 * viewport
    const max = 0.94 * viewport
    // Rubber-band past the limits rather than stopping dead.
    const height = raw < min ? min - (min - raw) * 0.3 : raw > max ? max + (raw - max) * 0.3 : raw

    const now = performance.now()
    const dt = now - drag.lastT
    if (dt > 0) drag.velocity = (drag.lastY - e.clientY) / dt
    drag.lastY = e.clientY
    drag.lastT = now

    // Written straight to the element: routing this through React state would
    // re-render the whole trip sheet on every pointer frame.
    el.style.height = `${height}px`
  }

  function endDrag(e: React.PointerEvent) {
    const drag = dragRef.current
    const el = elRef.current
    if (!drag || !el) return
    dragRef.current = null
    el.releasePointerCapture?.(e.pointerId)
    delete el.dataset.dragging
    const height = el.getBoundingClientRect().height
    el.style.height = ''
    setSnap(resolveSnap(height, window.innerHeight, drag.velocity, snap))
  }

  function onGrabberKeyDown(e: React.KeyboardEvent) {
    const order: Snap[] = ['peek', 'half', 'full']
    const index = order.indexOf(snap)
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSnap(order[Math.min(order.length - 1, index + 1)])
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSnap(order[Math.max(0, index - 1)])
    }
  }

  return (
    <div
      ref={elRef}
      className="sheet"
      data-snap={snap}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* A real button, not a decorative bar: tapping cycles the height, which
          beats dragging when the phone is in a car mount, and gives the
          keyboard a way in. */}
      <button
        type="button"
        className="sheet-grabber"
        data-grabber="true"
        aria-label="Resize panel"
        aria-expanded={snap !== 'peek'}
        onClick={cycleSnap}
        onKeyDown={onGrabberKeyDown}
      >
        <span className="sheet-grabber-bar" aria-hidden />
      </button>
      {children}
    </div>
  )
}
