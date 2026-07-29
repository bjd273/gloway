// The conversation, reduced to one input bar pinned to the sheet.
//
// What used to be here — a stacking transcript of bubbles — is gone on purpose.
// In a map app the assistant's reply *is* the route change: the redrawn line is
// the answer and the text is only confirmation, so it appears briefly over the
// map (AssistantBubble) rather than holding permanent screen real estate.
// `useConvoStore.messages` still holds the full exchange, and the backend holds
// the real conversation; only the on-screen transcript went away.
//
// The open-once, reset-on-idle and text-to-speech effects moved here verbatim
// from Conversation.tsx — they are load-bearing, particularly the `listening`
// guard, since TTS and the microphone contend for the audio device.
import { useEffect, useRef, useState } from 'react'

import { useSpeechRecognition } from '../hooks/useSpeechRecognition'
import { isSpeechSynthesisSupported, speak } from '../lib/voice'
import { useConvoStore } from '../stores/useConvoStore'
import { useTripStore } from '../stores/useTripStore'
import { useVoiceStore } from '../stores/useVoiceStore'

export function ChatBar() {
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

  // 'off' means the backend has no LLM configured: render nothing at all rather
  // than a dead input. The sheet footer must not reserve space for this.
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
    <div className="chat-bar">
      <form className="convo-reply" onSubmit={send}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            listening
              ? 'Listening…'
              : transcribing
                ? 'Transcribing…'
                : status === 'thinking'
                  ? 'Thinking…'
                  : 'Ask to change the route…'
          }
          aria-label="Ask your assistant to change the route"
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
