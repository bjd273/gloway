// The assistant's latest reply, briefly, over the map — then gone.
//
// This is the deliberate replacement for the permanent chat transcript, and the
// reasoning is worth keeping so it doesn't get relitigated: in a map app the
// answer to "avoid the highway" is the redrawn line, not the sentence about it.
// The text confirms; the map informs. A transcript would hold screen space for
// something the user has already seen and acted on.
//
// The full exchange still exists in useConvoStore.messages and on the backend.
//
// Only the pre-trip conversation shows here. The in-drive voice loop never
// writes to useConvoStore — NavVoice renders its own reply inline in the sheet
// footer, where the driver is already looking, and also shows what it heard.
import { useEffect, useRef, useState } from 'react'

import { useConvoStore } from '../stores/useConvoStore'

/** Long enough to glance-read, capped so it never loiters over the map. */
function readingTimeMs(text: string): number {
  const words = text.trim().split(/\s+/).length
  return Math.min(9000, 2500 + words * 320)
}

const LEAVE_MS = 350

export function AssistantBubble() {
  const messages = useConvoStore((s) => s.messages)
  const status = useConvoStore((s) => s.status)

  const [shown, setShown] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  const dismissRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const removeRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimers = () => {
    if (dismissRef.current) clearTimeout(dismissRef.current)
    if (removeRef.current) clearTimeout(removeRef.current)
    dismissRef.current = null
    removeRef.current = null
  }

  const last = messages[messages.length - 1]
  const latestAssistant = last?.role === 'assistant' ? last.content : null

  // Keyed on message count, not on the message object: the store hands back a
  // new array each update, so object identity churns even when nothing new
  // arrived.
  useEffect(() => {
    if (!latestAssistant) return
    clearTimers()
    setShown(latestAssistant)
    setLeaving(false)
    dismissRef.current = setTimeout(() => {
      setLeaving(true)
      removeRef.current = setTimeout(() => setShown(null), LEAVE_MS)
    }, readingTimeMs(latestAssistant))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length])

  // A reply is on its way: hold the surface open rather than letting the
  // previous bubble time out and flash the next one in a moment later.
  useEffect(() => {
    if (status === 'thinking' || status === 'opening') {
      clearTimers()
      setLeaving(false)
    }
  }, [status])

  useEffect(() => clearTimers, [])

  const thinking = status === 'thinking' || status === 'opening'
  if (!thinking && !shown) return null

  function dismiss() {
    clearTimers()
    setLeaving(true)
    removeRef.current = setTimeout(() => setShown(null), LEAVE_MS)
  }

  return (
    <div className={'gw-bubble' + (leaving ? ' gw-bubble--leaving' : '')} role="status">
      <button type="button" className="gw-bubble-body" onClick={dismiss}>
        {thinking && !shown ? (
          <span className="gw-bubble-thinking" aria-label="Thinking">
            …
          </span>
        ) : (
          shown
        )}
      </button>
    </div>
  )
}
