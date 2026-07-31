import { useEffect } from 'react'

import { AssistantBubble } from './components/AssistantBubble'
import { MapView } from './components/MapView'
import { PrefsPanel } from './components/PrefsPanel'
import { Sheet } from './components/Sheet'
import { TripSheet } from './components/TripSheet'
import { TurnBanner } from './components/TurnBanner'
import { Wordmark } from './components/Wordmark'
import { useUserStore } from './stores/useUserStore'

function App() {
  // Hydrate the journey profile for a remembered user so Home/Work shortcuts
  // appear without opening the preferences panel first.
  useEffect(() => {
    if (useUserStore.getState().userId) void useUserStore.getState().loadProfile()
  }, [])

  // Everything floats over a full-bleed map. Stacking order, low to high:
  // map (0) → wordmark (20) → turn banner (22) → sheet (25) → assistant
  // bubble (28) → prefs (30). The bubble is a sibling of the sheet, not a
  // child: inside it, the sheet's overflow would clip it and the sheet's
  // scrolling would drag it around.
  //
  // The turn banner takes the top of the screen during a drive, which is why
  // Wordmark stands down while navigating rather than sitting under it.
  return (
    <>
      <MapView />
      <Wordmark />
      <TurnBanner />
      <PrefsPanel />
      <AssistantBubble />
      <Sheet>
        <TripSheet />
      </Sheet>
    </>
  )
}

export default App
