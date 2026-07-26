// Who's driving: the locally-remembered account + routing preferences.
//
// Phase 1 identity is deliberately light — registering claims an email and
// the returned user id lives in localStorage. Preferences are kept here too
// (and PATCHed to the backend), so the panel renders instantly on reload
// without a profile fetch. Real auth replaces `register` when it matters.
import { create } from 'zustand'

import {
  FriendlyError,
  getProfile,
  registerUser,
  updateJourney,
  updatePreferences,
  type JourneyProfile,
  type LatLon,
  type UserPrefs,
} from '../lib/api'

const STORAGE_KEY = 'gloway:user'

export const DEFAULT_PREFS: UserPrefs = {
  avoid_highways: false,
  avoid_tolls: false,
  avoid_left_turns: false,
  prefer_scenic: false,
}

interface StoredUser {
  userId: string
  email: string
  prefs: UserPrefs
}

function loadStored(): StoredUser | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed.userId !== 'string') return null
    return {
      userId: parsed.userId,
      email: typeof parsed.email === 'string' ? parsed.email : '',
      prefs: { ...DEFAULT_PREFS, ...parsed.prefs },
    }
  } catch {
    return null
  }
}

function persist(userId: string, email: string, prefs: UserPrefs): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId, email, prefs }))
}

interface UserState {
  userId: string | null
  email: string | null
  prefs: UserPrefs
  /** Journey profile (home/work, convo style) — fetched, not persisted locally. */
  journey: JourneyProfile | null
  busy: boolean
  errorMessage: string | null

  /** Claim (or re-claim) an email. Resolves true when registered. */
  register(email: string): Promise<boolean>
  /** Flip one preference: optimistic locally, PATCHed to the backend,
   * reverted (with a message) if the save fails. Resolves true on success. */
  setPref(key: keyof UserPrefs, value: boolean): Promise<boolean>
  /** Refresh prefs + journey from the backend (prefs panel open). */
  loadProfile(): Promise<void>
  /** Set or clear home/work. Resolves true on success. */
  setPlace(kind: 'home_location' | 'work_location', place: LatLon | null): Promise<boolean>
  setConvoStyle(style: JourneyProfile['preferred_convo_style']): Promise<boolean>
  /** Adopt preference values the server changed (e.g. via conversation). */
  applyServerPrefs(prefs: UserPrefs): void
}

const stored = loadStored()

export const useUserStore = create<UserState>((set, get) => ({
  userId: stored?.userId ?? null,
  email: stored?.email ?? null,
  prefs: stored?.prefs ?? DEFAULT_PREFS,
  journey: null,
  busy: false,
  errorMessage: null,

  async register(email) {
    set({ busy: true, errorMessage: null })
    try {
      const user = await registerUser(email.trim().toLowerCase())
      persist(user.userId, user.email, user.prefs)
      set({
        userId: user.userId,
        email: user.email,
        prefs: user.prefs,
        journey: user.journey,
        busy: false,
      })
      return true
    } catch (error) {
      set({
        busy: false,
        errorMessage:
          error instanceof FriendlyError ? error.message : 'Something went sideways — try again.',
      })
      return false
    }
  },

  async setPref(key, value) {
    const { userId, email, prefs } = get()
    if (!userId) return false
    const previous = prefs
    const next = { ...prefs, [key]: value }
    set({ prefs: next, errorMessage: null })
    persist(userId, email ?? '', next)
    try {
      const saved = await updatePreferences(userId, { [key]: value })
      persist(userId, email ?? '', saved)
      set({ prefs: saved })
      return true
    } catch (error) {
      persist(userId, email ?? '', previous)
      set({
        prefs: previous,
        errorMessage:
          error instanceof FriendlyError ? error.message : 'Something went sideways — try again.',
      })
      return false
    }
  },

  async loadProfile() {
    const { userId } = get()
    if (!userId) return
    try {
      const user = await getProfile(userId)
      persist(user.userId, user.email, user.prefs)
      set({ email: user.email, prefs: user.prefs, journey: user.journey })
    } catch {
      // Panel falls back to what's cached locally — not worth an error banner.
    }
  },

  async setPlace(kind, place) {
    const { userId } = get()
    if (!userId) return false
    try {
      const journey = await updateJourney(userId, { [kind]: place })
      set({ journey, errorMessage: null })
      return true
    } catch (error) {
      set({
        errorMessage:
          error instanceof FriendlyError ? error.message : 'Something went sideways — try again.',
      })
      return false
    }
  },

  async setConvoStyle(style) {
    const { userId } = get()
    if (!userId) return false
    try {
      const journey = await updateJourney(userId, { preferred_convo_style: style })
      set({ journey, errorMessage: null })
      return true
    } catch (error) {
      set({
        errorMessage:
          error instanceof FriendlyError ? error.message : 'Something went sideways — try again.',
      })
      return false
    }
  },

  applyServerPrefs(prefs) {
    const { userId, email } = get()
    if (userId) persist(userId, email ?? '', prefs)
    set({ prefs })
  },
}))
