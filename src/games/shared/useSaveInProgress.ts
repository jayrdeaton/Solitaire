import { useEffect, useRef } from 'react'
import { AppState } from 'react-native'

import { flushGameInProgress } from '@/stores/gameInProgress'

// While a deal is active, re-persists it at this cadence even with no new move, so a player who
// leaves the board open and then closes/kills the app still resumes close to how long they
// actually had it open - see useGameSession.ts's own doc comment for why the per-move save effect
// deliberately no longer does this every second itself.
const BACKSTOP_INTERVAL_MS = 10000

/**
 * Low-frequency backstop for each game screen's own save-on-move effect. `save` is called on this
 * interval for as long as `active` stays true, entirely through a ref rather than a reactive effect
 * dependency, so it can never itself trigger the kind of per-second whole-screen re-render the
 * ticking elapsed-time clock this replaced used to cause (see useGameSession.ts). Doesn't fire an
 * initial call of its own - the screen's own save-on-move effect already covers "right now," this
 * covers "still open N seconds later with nothing new to say," and the moment the screen is left or
 * the app leaves the foreground.
 */
export function useSaveInProgressBackstop(active: boolean, save: () => void) {
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  })

  useEffect(() => {
    if (!active) return
    const id = setInterval(() => saveRef.current(), BACKSTOP_INTERVAL_MS)
    return () => clearInterval(id)
  }, [active])

  // A save holds the elapsed time from when it was MADE (the last move, or the last tick above, up to
  // BACKSTOP_INTERVAL_MS ago), so leaving the screen (Home, or any other way it unmounts) or the app
  // leaving the foreground saves once more first: otherwise every trip Home handed back up to ten
  // seconds of the clock. Then it writes whatever is still waiting out its debounce (saves are
  // coalesced, see stores/gameInProgress.ts). `save` itself skips a won or lost deal. Every game screen
  // mounts this hook.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') return
      saveRef.current()
      void flushGameInProgress()
    })
    return () => {
      sub.remove()
      saveRef.current()
      void flushGameInProgress()
    }
  }, [])
}
