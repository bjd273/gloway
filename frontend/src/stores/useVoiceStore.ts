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
}

function loadStored(): StoredVoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { autoSpeak: false, everUsedVoice: false }
    const parsed = JSON.parse(raw)
    return {
      autoSpeak: Boolean(parsed.autoSpeak),
      everUsedVoice: Boolean(parsed.everUsedVoice),
    }
  } catch {
    return { autoSpeak: false, everUsedVoice: false }
  }
}

function persist(state: StoredVoice): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

interface VoiceState {
  autoSpeak: boolean
  everUsedVoice: boolean
  /** Call when the mic is tapped. One-time auto-enable of read-aloud. */
  noteVoiceUsed(): void
  setAutoSpeak(value: boolean): void
}

const stored = loadStored()

export const useVoiceStore = create<VoiceState>((set, get) => ({
  autoSpeak: stored.autoSpeak,
  everUsedVoice: stored.everUsedVoice,

  noteVoiceUsed() {
    if (get().everUsedVoice) return
    const next = { autoSpeak: true, everUsedVoice: true }
    persist(next)
    set(next)
  },

  setAutoSpeak(value) {
    const next = { autoSpeak: value, everUsedVoice: get().everUsedVoice }
    persist(next)
    set({ autoSpeak: value })
  },
}))
