import { useEffect, useState } from 'react'

/** After the last flight lands, how long the finished board sits complete before the win
 * celebration takes over - long enough to see the final card arrive. */
export const WIN_REVEAL_HOLD_MS = 400
/** If the flights never report settled (a bug elsewhere, a stuck measurement), reveal anyway after
 * this long - a win must never be withheld. */
export const WIN_REVEAL_MAX_WAIT_MS = 2500

/**
 * When the win CELEBRATION should start, as opposed to when the game is won.
 *
 * `won` flips in the same commit as the winning move, so anything hung on it (the foundations
 * hiding their real cards so the bouncing win cascade can take over, the fireworks, the banner)
 * fires while the last card is still in the air - and worse, hiding the foundations unregisters the
 * very card the last flight is measuring to land on, so it cannot fly at all and simply appears.
 * Gate those visuals on this instead: it turns true only once `won` AND `settled` (nothing left
 * flying, see each screen's own settled signal) have held for WIN_REVEAL_HOLD_MS, so the last card
 * flies in, lands, and the completed board reads for a beat first.
 *
 * Only the VISUALS use this. Everything that is game logic keeps reading `won` directly - the clock,
 * the recorded stat, the cleared save, hint/undo gating - so a win is recorded the instant it
 * happens, not 400ms later.
 *
 * `maxWaitMs` (default WIN_REVEAL_MAX_WAIT_MS) is how long a win that never settles is withheld. A screen whose winning move
 * starts a LONG sequence of its own that the reveal must wait for (Pyramid's sweep of the stock and waste onto the discard,
 * ~1.1s for 24 cards on top of the last removal's flight and the hold) passes a longer one, so a slow device's JS stall
 * cannot cut that sequence short with the fallback timer - the default only has to cover a single card's flight.
 */
export function useWinReveal(won: boolean, settled: boolean, maxWaitMs: number = WIN_REVEAL_MAX_WAIT_MS): boolean {
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    if (!won) return
    const timer = setTimeout(() => setRevealed(true), settled ? WIN_REVEAL_HOLD_MS : maxWaitMs)
    return () => clearTimeout(timer)
  }, [won, settled, maxWaitMs])

  // React's sanctioned "adjust state during render" shape (see useFrozenWhileHidden): an undo that
  // un-wins the deal must rearm this for a later re-win, or that win would reveal instantly.
  if (!won && revealed) setRevealed(false)

  return won && revealed
}
