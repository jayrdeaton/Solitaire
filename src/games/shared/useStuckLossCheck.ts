import { useEffect, useRef } from 'react'

import { GameController } from '@/engine/gameTypes'
import { clearGameInProgress } from '@/stores/gameInProgress'
import { SolitaireGameId } from '@/stores/statsTypes'

export interface StuckLossCheck {
  stuck: boolean
}

/**
 * A game's genuine, non-abandonment loss condition (Aces Up, Golf, TriPeaks, Forty Thieves and Scorpion: games whose
 * `isStuck` is exact - no recycle to fall back on) - derives `stuck` fresh from `state` every render (same "no separate
 * useState mirror" shape as useDerivedWinCheck).
 *
 * The loss is recorded when the player LEAVES the dead board, not when it is reached (Jay, 2026-10-14): the loss dialog
 * offers Undo, and recording on arrival counted one deal twice (the loss, then a win or a second loss on New Game after an
 * Undo). The two ways out:
 * - New Game: the screen's own handleNewGame records it, through the same `session.moves > 0 && !won` check as a deal
 *   walked away from mid-game (a real loss and an abandoned deal are the same stat, recordDealAbandoned).
 * - Leaving the screen (Home): recorded here, on unmount, and the save cleared so the next visit deals a fresh game.
 * An Undo out of the dead board cancels it: nothing was recorded. The dead board itself is never saved (each screen's save
 * skips `stuck`), so a killed app resumes the board one move before it died, which is just that Undo.
 */
export function useStuckLossCheck<TState>(controller: Pick<GameController<TState>, 'isStuck'>, state: TState | null, gameId: SolitaireGameId, recordDealAbandoned: (gameId: SolitaireGameId) => void): StuckLossCheck {
  const stuck = state && controller.isStuck ? controller.isStuck(state) : false

  const latestRef = useRef({ stuck, gameId, recordDealAbandoned })
  useEffect(() => {
    latestRef.current = { stuck, gameId, recordDealAbandoned }
  })

  useEffect(
    () => () => {
      const { stuck: leftStuck, gameId: id, recordDealAbandoned: record } = latestRef.current
      if (!leftStuck) return
      record(id)
      clearGameInProgress(id)
    },
    []
  )

  return { stuck }
}
