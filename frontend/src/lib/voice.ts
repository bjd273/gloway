// Feature detection + TTS for the browser-native voice layer (Web Speech
// API). No backend involvement — STT/TTS live entirely client-side, feeding
// plain text into the same reply() calls typing already uses.
//
// Support varies per browser (Firefox has SpeechSynthesis but not
// SpeechRecognition, for example), so callers gate each affordance on its own
// check rather than one combined "voice supported" flag.

function getSpeechRecognitionCtor(): SpeechRecognitionConstructor | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null
}

export function isSpeechRecognitionSupported(): boolean {
  return getSpeechRecognitionCtor() !== null
}

export function isSpeechSynthesisSupported(): boolean {
  return typeof window.speechSynthesis !== 'undefined'
}

export function createSpeechRecognition(): SpeechRecognition | null {
  const Ctor = getSpeechRecognitionCtor()
  return Ctor ? new Ctor() : null
}

// --- voice selection -------------------------------------------------------
// The default synthesis voice is usually a robotic local one. Prefer a
// higher-quality male English voice, ordered by what's actually good on each
// platform (Google network voices on Chrome, Natural voices on Edge, the
// premium built-ins on macOS). getVoices() populates asynchronously, so we
// cache on load and refresh when the browser fires `voiceschanged`.

const MALE_VOICE_PREFERENCES = [
  'Google UK English Male', // Chrome, network — the best male voice Chrome ships
  'Microsoft Guy Online (Natural) - English (United States)',
  'Microsoft David - English (United States)',
  'Daniel', // macOS, British male
  'Alex', // macOS, American male (high quality)
  'Rishi',
  'Aaron',
  'Fred',
]

let cachedVoices: SpeechSynthesisVoice[] = []
let preferredVoice: SpeechSynthesisVoice | null = null

function pickMaleVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null
  const english = voices.filter((v) => v.lang.toLowerCase().startsWith('en'))
  const pool = english.length > 0 ? english : voices

  for (const name of MALE_VOICE_PREFERENCES) {
    const match = pool.find((v) => v.name === name)
    if (match) return match
  }
  // Fall back to any voice whose name hints male — carefully, since "female"
  // contains "male" as a substring.
  const maleish = pool.find((v) => {
    const n = v.name.toLowerCase()
    if (n.includes('female')) return false
    return /\bmale\b|\b(daniel|alex|guy|david|mark|aaron|rishi|fred|george|james|oliver|arthur|thomas)\b/.test(
      n,
    )
  })
  return maleish ?? pool[0]
}

function refreshVoices(): void {
  if (!isSpeechSynthesisSupported()) return
  cachedVoices = window.speechSynthesis.getVoices()
  preferredVoice = pickMaleVoice(cachedVoices)
}

if (isSpeechSynthesisSupported()) {
  refreshVoices()
  // getVoices() is empty until this fires on most browsers.
  window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices)
}

/** The name of the voice currently used for read-aloud (for debugging /
 * letting the user tell us if they want a different one). */
export function getSelectedVoiceName(): string | null {
  if (!preferredVoice) refreshVoices()
  return preferredVoice?.name ?? null
}

/** All available English voice names — handy for picking an alternative. */
export function listEnglishVoiceNames(): string[] {
  if (cachedVoices.length === 0) refreshVoices()
  return cachedVoices.filter((v) => v.lang.toLowerCase().startsWith('en')).map((v) => v.name)
}

/** Speaks text aloud with the preferred male voice, cancelling any utterance
 * already in flight — replies can arrive back-to-back and should never
 * overlap. No-ops silently if the browser doesn't support SpeechSynthesis. */
export function speak(text: string): void {
  if (!isSpeechSynthesisSupported() || !text.trim()) return
  if (!preferredVoice) refreshVoices() // late-load if voices weren't ready earlier
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'en-US'
  if (preferredVoice) utterance.voice = preferredVoice
  utterance.rate = 1.0
  utterance.pitch = 1.0
  window.speechSynthesis.speak(utterance)
}
