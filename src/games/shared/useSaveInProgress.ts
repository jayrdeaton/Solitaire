import { useEffect, useRef } from 'react'

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
 * only covers "still open N seconds later with nothing new to say."
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
}
