// Post-trip debrief, shown in the trip panel's wrap-up slot. One assistant
// question → the user's reply (which writes the reward signal) → a warm ack,
// then a Done button clears the trip. Skippable at any point.
import { useEffect, useRef, useState } from 'react'

import { useSpeechRecognition } from '../hooks/useSpeechRecognition'
import { isSpeechSynthesisSupported, speak } from '../lib/voice'
import { useDebriefStore } from '../stores/useDebriefStore'
import { useVoiceStore } from '../stores/useVoiceStore'

export function Debrief({ onDone }: { onDone: () => void }) {
  const status = useDebriefStore((s) => s.status)
  const messages = useDebriefStore((s) => s.messages)
  const reply = useDebriefStore((s) => s.reply)

  const autoSpeak = useVoiceStore((s) => s.autoSpeak)
  const setAutoSpeak = useVoiceStore((s) => s.setAutoSpeak)
  const noteVoiceUsed = useVoiceStore((s) => s.noteVoiceUsed)

  const [draft, setDraft] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const spokenUpToRef = useRef(0)

  const {
    supported: micSupported,
    listening,
    transcribing,
    start: startListening,
    error: micError,
  } = useSpeechRecognition({
    onTranscript: (text) => setDraft(text),
    onFinalResult: (text) => {
      setDraft('')
      void reply(text)
    },
  })

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [messages.length, status])
  // Speak only new assistant messages, never while the mic is listening.
  useEffect(() => {
    if (!autoSpeak || listening) {
      spokenUpToRef.current = messages.length
      return
    }
    for (let i = spokenUpToRef.current; i < messages.length; i += 1) {
      if (messages[i].role === 'assistant') speak(messages[i].content)
    }
    spokenUpToRef.current = messages.length
  }, [messages, autoSpeak, listening])

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

      {status === 'done' ? (
        <button className="trip-chip trip-chip--active" onClick={onDone}>
          Done
        </button>
      ) : (
        <form className="convo-reply convo-reply--wrapup" onSubmit={send}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={listening ? 'Listening…' : transcribing ? 'Transcribing…' : 'How was it?'}
            aria-label="How was the drive?"
            disabled={status !== 'ready'}
            autoFocus
          />
          {micSupported && (
            <button
              type="button"
              className={`convo-mic ${listening ? 'convo-mic--listening' : ''}`}
              onClick={onMicClick}
              disabled={status !== 'ready' || listening || transcribing}
              aria-label="Speak your answer"
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
          <button type="button" className="trip-chip" onClick={onDone}>
            Skip
          </button>
        </form>
      )}
      {micError && (
        <div className="convo-mic-error" role="status">
          {micError}
        </div>
      )}
    </div>
  )
}
