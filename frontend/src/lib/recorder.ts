// MediaRecorder wrapper for the server-side STT fallback. Runs alongside the
// Web Speech API: while recognition listens, we capture the same utterance
// locally so that if the browser's engine returns nothing (which real Chrome
// does, silently), the audio can be uploaded and transcribed server-side
// instead of being lost.
//
// Failure philosophy: never throw. Any problem (permission, no MediaRecorder,
// insecure context) resolves to null and the caller proceeds Web-Speech-only —
// the recorder is a safety net, not a dependency.

export interface VoiceRecorder {
  /** Stops recording and resolves with the captured audio (null if nothing). */
  stop(): Promise<Blob | null>
  /** Stops and releases everything without keeping the data. */
  discard(): void
}

// Ordered by preference per browser: Chrome/Edge take webm+opus, Safari only
// mp4 (AAC). An unsupported list falls through to the browser default.
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
]

function pickMimeType(): string | undefined {
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m))
}

export async function startVoiceRecorder(maxMs = 30_000): Promise<VoiceRecorder | null> {
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return null
  }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (err) {
    console.debug('[voice] recorder getUserMedia failed', err)
    return null
  }

  let recorder: MediaRecorder
  try {
    const mimeType = pickMimeType()
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  } catch (err) {
    console.debug('[voice] MediaRecorder construction failed', err)
    stream.getTracks().forEach((t) => t.stop())
    return null
  }

  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }

  // `stopped` resolves once the final chunk has flushed — MediaRecorder only
  // guarantees the last ondataavailable before its stop event.
  let finished = false
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
    recorder.onerror = () => resolve()
  })

  const finish = () => {
    // Idempotent: the safety timeout, the deliver path, and unmount cleanup
    // can all race to stop the same recorder.
    if (finished) return
    finished = true
    clearTimeout(timeout)
    if (recorder.state !== 'inactive') recorder.stop()
    stream.getTracks().forEach((t) => t.stop()) // releases the mic indicator
  }

  // Safety cap: a runaway recognition session shouldn't record forever.
  const timeout = setTimeout(finish, maxMs)

  recorder.start()

  return {
    async stop() {
      finish()
      await stopped
      if (chunks.length === 0) return null
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
      return blob.size > 0 ? blob : null
    },
    discard() {
      finish()
      chunks.length = 0
    },
  }
}
