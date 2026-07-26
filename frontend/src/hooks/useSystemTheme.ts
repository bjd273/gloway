import { useSyncExternalStore } from 'react'

import type { Theme } from '../lib/mapStyles'

const query = window.matchMedia('(prefers-color-scheme: dark)')

function subscribe(callback: () => void): () => void {
  query.addEventListener('change', callback)
  return () => query.removeEventListener('change', callback)
}

function getSnapshot(): Theme {
  return query.matches ? 'dark' : 'light'
}

/** The OS color scheme, live — drives both the map style and (via CSS media
 * queries, automatically) the UI chrome. */
export function useSystemTheme(): Theme {
  return useSyncExternalStore(subscribe, getSnapshot)
}
