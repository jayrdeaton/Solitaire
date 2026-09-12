import { MutableRefObject, useEffect, useRef } from 'react'

import { GameController } from '@/engine/gameTypes'
import { SolitaireGameId } from '@/stores/statsTypes'

export interface StuckLossCheck {
  stuck: boolean
  recordedRef: MutableRefObject<boolean>
}

/**
 * A game's genuine, non-abandonment loss condition (currently only Aces Up - see its own rules.ts
 * header comment) - derives `stuck` fresh from `state` every render (same "no separate useState
 * mirror" shape as useDerivedWinCheck), and a one-time effect records the loss via the SAME
 * recordDealAbandoned every other game's own "left mid-game" path already calls (see
 * stores/statsEngine.ts's applyDealAbandoned) - per this app's own convention, a real loss and an
 * abandoned deal are the exact same stat, not two different outcomes.
 *
 * IMPORTANT: call this BEFORE the caller's own win-check hook (useDerivedWinCheck/
 * useFoundationWinCheck) if both exist, for the same effect-ordering reason those hooks' own doc
 * comments give - a game whose `isStuck` doesn't already exclude the won case (see
 * AcesUpController.isStuck's own `!isWon(state)` guard) could otherwise record both outcomes for
 * the same winning commit.
 */
export function useStuckLossCheck<TState>(controller: Pick<GameController<TState>, 'isStuck'>, state: TState | null, gameId: SolitaireGameId, recordDealAbandoned: (gameId: SolitaireGameId) => void): StuckLossCheck {
  const stuck = state && controller.isStuck ? controller.isStuck(state) : false
  const recordedRef = useRef(false)

  useEffect(() => {
    if (!state || !controller.isStuck) return
    if (controller.isStuck(state) && !recordedRef.current) {
      recordedRef.current = true
      recordDealAbandoned(gameId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  return { stuck, recordedRef }
}
