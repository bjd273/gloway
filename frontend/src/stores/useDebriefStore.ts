// Post-trip debrief: one LLM question about the drive, one reply that writes
// the reward signal server-side. Mirrors useConvoStore but simpler — it's a
// single question→answer→ack, then the trip clears.
//
// 'off' means no LLM configured (open returned null); TripPanel then falls
// back to the plain note form so wrap-up still works.
import { create } from 'zustand'

import { FriendlyError, openDebrief, replyDebrief } from '../lib/api'
import { useUserStore } from './useUserStore'

export type DebriefStatus = 'idle' | 'opening' | 'off' | 'ready' | 'thinking' | 'done'

interface DebriefMessage {
  role: 'assistant' | 'user'
  content: string
}

interface DebriefState {
  status: DebriefStatus
  tripId: string | null
  messages: DebriefMessage[]

  open(tripId: string): Promise<void>
  reply(text: string): Promise<void>
  reset(): void
}

export const useDebriefStore = create<DebriefState>((set, get) => ({
  status: 'idle',
  tripId: null,
  messages: [],

  async open(tripId) {
    if (get().status !== 'idle') return
    set({ status: 'opening', tripId })
    const question = await openDebrief(tripId)
    if (question === null) {
      set({ status: 'off' })
      return
    }
    set({ status: 'ready', messages: [{ role: 'assistant', content: question }] })
  },

  async reply(text) {
    const { tripId, status, messages } = get()
    if (!tripId || status !== 'ready') return
    set({ status: 'thinking', messages: [...messages, { role: 'user', content: text }] })
    try {
      const result = await replyDebrief(tripId, text)
      if (result.prefs) useUserStore.getState().applyServerPrefs(result.prefs)
      set((s) => ({
        status: 'done',
        messages: [...s.messages, { role: 'assistant', content: result.message }],
      }))
    } catch (error) {
      set((s) => ({
        status: 'ready',
        messages: [
          ...s.messages,
          {
            role: 'assistant',
            content:
              error instanceof FriendlyError ? error.message : 'Something went sideways — try again.',
          },
        ],
      }))
    }
  },

  reset() {
    set({ status: 'idle', tripId: null, messages: [] })
  },
}))
