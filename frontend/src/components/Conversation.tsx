// The pre-journey conversation — rendered inside the prompt shell once a
// route is on screen (the surface PromptBar reserved for the Phase 2 layer).
// One opener from the assistant, replies can re-route the trip (hurry /
// explore) or persist durable preferences. Invisible when the backend has
// no LLM configured.
import { useEffect, useRef, useState } from 'react'

import { useSpeechRecognition } from '../hooks/useSpeechRecognition'
import { isSpeechSynthesisSupported, speak } from '../lib/voice'
import { useConvoStore } from '../stores/useConvoStore'
import { useTripStore } from '../stores/useTripStore'
import { useVoiceStore } from '../stores/useVoiceStore'

export function Conversation() {
  const tripStatus = useTripStore((s) => s.status)
  const tripId = useTripStore((s) => s.tripId)
  const status = useConvoStore((s) => s.status)
  const messages = useConvoStore((s) => s.messages)
  const open = useConvoStore((s) => s.open)
  const reply = useConvoStore((s) => s.reply)
  const reset = useConvoStore((s) => s.reset)

  const autoSpeak = useVoiceStore((s) => s.autoSpeak)
  const setAutoSpeak = useVoiceStore((s) => s.setAutoSpeak)
  const noteVoiceUsed = useVoiceStore((s) => s.noteVoiceUsed)

  const [draft, setDraft] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  // Index of the last message we've read aloud, so toggling the speaker on
  // doesn't re-read an already-shown message and we only speak new arrivals.
  const spokenUpToRef = useRef(0)

  const {
    supported: micSupported,
    listening,
    transcribing,
    start: startListening,
    error: micError,
  } = useSpeechRecognition({
    // Show words in the input as they're spoken, then send + clear when final.
    onTranscript: (text) => setDraft(text),
    onFinalResult: (text) => {
      setDraft('')
      void reply(text)
    },
  })

  // Open once per session's first routed trip; reset when the trip clears.
  useEffect(() => {
    if (tripStatus === 'ready' && tripId && status === 'idle') void open(tripId)
  }, [tripStatus, tripId, status, open])
  useEffect(() => {
    if (tripStatus === 'idle' && status !== 'idle') reset()
  }, [tripStatus, status, reset])
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [messages.length, status])
  // Read *new* assistant messages aloud when voice mode is on — covers the
  // opener and every reply ack uniformly, no special-casing per message kind.
  // Guarded so flipping the speaker on never re-reads an old message, and so
  // TTS never plays over the mic while it's listening (they contend for the
  // audio device).
  useEffect(() => {
    if (!autoSpeak || listening) {
      // Don't queue past messages to be spoken later; treat them as caught up.
      spokenUpToRef.current = messages.length
      return
    }
    for (let i = spokenUpToRef.current; i < messages.length; i += 1) {
      if (messages[i].role === 'assistant') speak(messages[i].content)
    }
    spokenUpToRef.current = messages.length
  }, [messages, autoSpeak, listening])

  if (status === 'idle' || status === 'off') return null

  function onMicClick() {
    noteVoiceUsed()
    startListening()
  }

  function send(e?: React.FormEvent) {
    e?.preventDefault()
    const text = draft.trim()
    if (!text) return
    setDraft('')
    void reply(text)
  }

  // Explicit Enter handling: implicit form submission is a default action
  // that synthetic key events (tests, automation) never trigger.
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="convo">
      <div className="convo-messages">
        {status === 'opening' && <div className="convo-bubble convo-bubble--thinking">…</div>}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`convo-bubble ${m.role === 'user' ? 'convo-bubble--user' : ''}`}
          >
            {m.content}
          </div>
        ))}
        {status === 'thinking' && <div className="convo-bubble convo-bubble--thinking">…</div>}
        <div ref={endRef} />
      </div>
      <form className="convo-reply" onSubmit={send}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={listening ? 'Listening…' : transcribing ? 'Transcribing…' : 'Reply…'}
          aria-label="Reply to your assistant"
          disabled={status !== 'ready'}
        />
        {micSupported && (
          <button
            type="button"
            className={`convo-mic ${listening ? 'convo-mic--listening' : ''}`}
            onClick={onMicClick}
            disabled={status !== 'ready' || listening || transcribing}
            aria-label="Speak your reply"
          >
            🎤
          </button>
        )}
        {isSpeechSynthesisSupported() && (
          <button
            type="button"
            className={`convo-speaker ${autoSpeak ? 'convo-speaker--active' : ''}`}
            onClick={() => setAutoSpeak(!autoSpeak)}
            aria-label={autoSpeak ? 'Mute spoken replies' : 'Read replies aloud'}
          >
            {autoSpeak ? '🔊' : '🔈'}
          </button>
        )}
      </form>
      {micError && (
        <div className="convo-mic-error" role="status">
          {micError}
        </div>
      )}
    </div>
  )
}
