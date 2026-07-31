// Voice preferences: whether assistant replies are read aloud. Persisted like
// useUserStore's manual localStorage pattern — small enough not to need a
// backend round-trip, and it's a device/session habit, not routing data.
//
// autoSpeak starts off. The first time the mic is ever used, it flips on
// automatically (a one-time nudge toward the hands-free flow); after that
// it's purely the explicit speaker toggle's call — using the mic again never
// re-enables it once the user has muted it back off.
import { create } from 'zustand'

const STORAGE_KEY = 'gloway:voice'

interface StoredVoice {
  autoSpeak: boolean
  everUsedVoice: boolean
  voiceGuidance: boolean
}

const DEFAULTS: StoredVoice = { autoSpeak: false, everUsedVoice: false, voiceGuidance: true }

function loadStored(): StoredVoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw)
    return {
      autoSpeak: Boolean(parsed.autoSpeak),
      everUsedVoice: Boolean(parsed.everUsedVoice),
      // Not Boolean(...), unlike its neighbours: this key was added after
      // people already had a blob in localStorage, and every one of those
      // blobs is missing it. Reading absent as false would ship turn
      // announcements switched off to exactly the users who have driven
      // before. Absent means "never chose", and the default is on — so only an
      // explicit false mutes it.
      voiceGuidance: parsed.voiceGuidance !== false,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function persist(state: StoredVoice): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

interface VoiceState {
  autoSpeak: boolean
  everUsedVoice: boolean
  /**
   * Whether to speak turn-by-turn guidance while driving. Deliberately separate
   * from autoSpeak, in default and in meaning: autoSpeak reads the assistant's
   * conversation aloud and starts off, while this announces turns and starts
   * on — someone driving unfamiliar roads should not have to discover a setting
   * to be told about their exit.
   */
  voiceGuidance: boolean
  /** Call when the mic is tapped. One-time auto-enable of read-aloud. */
  noteVoiceUsed(): void
  setAutoSpeak(value: boolean): void
  setVoiceGuidance(value: boolean): void
}

const stored = loadStored()

export const useVoiceStore = create<VoiceState>((set, get) => {
  const snapshot = (): StoredVoice => ({
    autoSpeak: get().autoSpeak,
    everUsedVoice: get().everUsedVoice,
    voiceGuidance: get().voiceGuidance,
  })

  return {
    autoSpeak: stored.autoSpeak,
    everUsedVoice: stored.everUsedVoice,
    voiceGuidance: stored.voiceGuidance,

    noteVoiceUsed() {
      if (get().everUsedVoice) return
      set({ autoSpeak: true, everUsedVoice: true })
      persist(snapshot())
    },

    setAutoSpeak(value) {
      set({ autoSpeak: value })
      persist(snapshot())
    },

    setVoiceGuidance(value) {
      set({ voiceGuidance: value })
      persist(snapshot())
    },
  }
})
