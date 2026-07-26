import { useEffect, useRef, useState } from 'react'

import { FriendlyError, transcribeAudio } from '../lib/api'
import { startVoiceRecorder, type VoiceRecorder } from '../lib/recorder'
import { createSpeechRecognition, isSpeechRecognitionSupported } from '../lib/voice'

const ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': "Mic access denied — check your browser's site permissions.",
  'service-not-allowed': "Mic access denied — check your browser's site permissions.",
  'no-speech': "Didn't catch that — try again.",
  network: 'Speech service unreachable — check your connection and try again.',
  'audio-capture': 'No microphone found — check your input device.',
}

const NO_SPEECH_MESSAGE = ERROR_MESSAGES['no-speech']

// Recordings smaller than this are effectively silence — not worth an upload.
const MIN_UPLOAD_BYTES = 1000

interface SpeechHandlers {
  /** Fires on every result, interim or final, with the utterance so far.
   * Wire this to show words in the input as they're spoken. */
  onTranscript?: (text: string) => void
  /** Fires once, when the utterance is final (or recognition ends), with the
   * completed text. Wire this to send the reply. */
  onFinalResult: (text: string) => void
}

/** One-shot mic capture. Streams interim text via `onTranscript` and delivers
 * the completed utterance once via `onFinalResult`.
 *
 * Two engines run per utterance:
 * 1. Web Speech API — instant, free, but Chrome's cloud engine can silently
 *    return nothing (mic listens, `onresult` never fires).
 * 2. A parallel MediaRecorder capture — if recognition ends with an empty
 *    transcript, the recorded audio is uploaded to the backend and
 *    transcribed server-side (Gemini), feeding the same delivery path.
 * When Web Speech works, the recording is discarded untouched. */
export function useSpeechRecognition(handlers: SpeechHandlers) {
  const [listening, setListening] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const recorderRef = useRef<Promise<VoiceRecorder | null> | null>(null)
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort()
      void recorderRef.current?.then((r) => r?.discard())
    }
  }, [])

  function start(): void {
    if (listening || transcribing) return
    const recognition = createSpeechRecognition()
    if (!recognition) return
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = 'en-US'

    // Start the fallback recording without awaiting — recognition must start
    // instantly, and (permission already granted) the recorder attaches as
    // soon as its promise settles. Resolves null on any failure, in which
    // case we're simply Web-Speech-only for this utterance.
    const recorderPromise = startVoiceRecorder()
    recorderRef.current = recorderPromise
    const discardRecording = () => void recorderPromise.then((r) => r?.discard())

    let transcript = ''
    let sent = false
    const deliver = () => {
      const text = transcript.trim()
      if (text && !sent) {
        sent = true
        discardRecording() // Web Speech won; the backup audio isn't needed
        handlersRef.current.onFinalResult(text)
      }
    }

    // Runs when recognition ended having produced nothing: upload the backup
    // recording and deliver the server transcript through the same path.
    async function transcribeFallback(): Promise<void> {
      const recorder = await recorderPromise
      if (!recorder) {
        console.debug('[voice] fallback unavailable (recorder never started)')
        setError((prev) => prev ?? NO_SPEECH_MESSAGE)
        return
      }
      const blob = await recorder.stop()
      if (!blob || blob.size < MIN_UPLOAD_BYTES) {
        console.debug('[voice] fallback skipped, recording empty', blob?.size ?? 0)
        setError((prev) => prev ?? NO_SPEECH_MESSAGE)
        return
      }
      console.debug('[voice] uploading for server transcription', blob.size, blob.type)
      setTranscribing(true)
      try {
        const text = (await transcribeAudio(blob)).trim()
        console.debug('[voice] server transcript', text)
        if (text && !sent) {
          sent = true
          handlersRef.current.onFinalResult(text)
        } else if (!text) {
          setError(NO_SPEECH_MESSAGE)
        }
      } catch (err) {
        setError(err instanceof FriendlyError ? err.message : NO_SPEECH_MESSAGE)
      } finally {
        setTranscribing(false)
      }
    }

    recognition.onresult = (event) => {
      // Rebuild the full utterance each fire (single, non-continuous phrase).
      transcript = ''
      let hasFinal = false
      for (let i = 0; i < event.results.length; i += 1) {
        transcript += event.results[i][0]?.transcript ?? ''
        if (event.results[i].isFinal) hasFinal = true
      }
      console.debug('[voice] onresult', { transcript, hasFinal })
      handlersRef.current.onTranscript?.(transcript)
      if (hasFinal) deliver()
    }
    recognition.onerror = (event) => {
      console.debug('[voice] onerror', event.error)
      // 'aborted' is benign (unmount/cancel); 'no-speech'/'network' are the
      // cases the server fallback exists for, so don't surface them here —
      // transcribeFallback() decides whether anything is actually wrong.
      if (event.error === 'aborted' || event.error === 'no-speech' || event.error === 'network') {
        return
      }
      setError(ERROR_MESSAGES[event.error] ?? NO_SPEECH_MESSAGE)
    }
    recognition.onend = () => {
      console.debug('[voice] onend', { transcript, sent })
      setListening(false)
      deliver() // Chrome often ends without ever flagging a final result
      if (!sent) void transcribeFallback()
    }
    // Extra diagnostics: these tell us whether the mic actually heard speech,
    // which distinguishes "no audio reached recognition" from "audio heard but
    // no result returned". Harmless to keep during voice bring-up.
    recognition.onspeechstart = () => console.debug('[voice] speechstart (audio detected)')
    recognition.onspeechend = () => console.debug('[voice] speechend')

    // Recognition and synthesis fight over the audio device in Chrome — silence
    // any spoken reply still playing before we start listening.
    if (typeof window.speechSynthesis !== 'undefined') window.speechSynthesis.cancel()

    recognitionRef.current = recognition
    setError(null)
    setListening(true)
    console.debug('[voice] start()')
    try {
      recognition.start()
    } catch (err) {
      // start() throws if the engine is mid-teardown from a prior session.
      // Reset so the button stays usable instead of locking on `listening`.
      console.debug('[voice] start() threw', err)
      setListening(false)
      setError("Couldn't start the mic — try again.")
      discardRecording() // don't leave a live mic track behind
    }
  }

  return { supported: isSpeechRecognitionSupported(), listening, transcribing, start, error }
}
