import { useEffect } from 'react'

import { MapView } from './components/MapView'
import { PrefsPanel } from './components/PrefsPanel'
import { PromptBar } from './components/PromptBar'
import { TripPanel } from './components/TripPanel'
import { Wordmark } from './components/Wordmark'
import { useUserStore } from './stores/useUserStore'

function App() {
  // Hydrate the journey profile for a remembered user so Home/Work shortcuts
  // appear without opening the preferences panel first.
  useEffect(() => {
    if (useUserStore.getState().userId) void useUserStore.getState().loadProfile()
  }, [])

  return (
    <>
      <MapView />
      <Wordmark />
      <PromptBar />
      <PrefsPanel />
      <TripPanel />
    </>
  )
}

export default App
