import { MutableRefObject, useEffect, useRef } from 'react'

import { GameSession } from '@/components/useGameSession'
import { GameController } from '@/engine/gameTypes'
import { computeScore } from '@/engine/score'
import { clearGameInProgress } from '@/stores/gameInProgress'
import { DealMetrics, SolitaireGameId } from '@/stores/statsTypes'

export interface DerivedWinCheck {
  won: boolean
  recordedRef: MutableRefObject<boolean>
  /** Mirrors pendingDealTokenRef/pendingDealRef's own shape - set by this hook's own effect,
   * consumed by the caller's [state]-effect once the winning slot(s) have actually committed (see
   * runWinCascade). */
  pendingWinCascadeRef: MutableRefObject<{ gen: number } | null>
}

/**
 * Shared by Spider and Pyramid - the two games that derive `won` fresh from `state` every render
 * (rather than mirroring it into its own useState the way Klondike/FreeCell do - see
 * useFoundationWinCheck for that shape) and use a separate effect purely for the one-time side
 * effects below. Deriving `won` this way means undoing out of a won position drops the win banner
 * immediately, with no separate reset needed.
 *
 * IMPORTANT: call this BEFORE the caller's own win-cascade-consumer effect (the one reading
 * `pendingWinCascadeRef.current`) - React runs a component's effects in the order they were
 * called during render, and the consumer effect only sees a same-commit payload if the producer
 * (this hook's own internal effect) ran first.
 */
export function useDerivedWinCheck<TState>(
  controller: Pick<GameController<TState>, 'isWon'>,
  state: TState | null,
  gameId: SolitaireGameId,
  session: GameSession,
  dealTokenRef: MutableRefObject<number>,
  recordDealWon: (gameId: SolitaireGameId, metrics: DealMetrics) => unknown,
  // Whether the Hint button was pressed (and actually produced a hint) at any point during this
  // deal - read at the exact instant a win is recorded, since a screen's own ref value can't be
  // passed as a snapshot (see each screen's hintUsedThisDealRef).
  hintsUsedRef: MutableRefObject<boolean>
): DerivedWinCheck {
  const won = state ? controller.isWon(state) : false
  const recordedRef = useRef(false)
  const pendingWinCascadeRef = useRef<{ gen: number } | null>(null)

  useEffect(() => {
    if (!state) return
    if (controller.isWon(state) && !recordedRef.current) {
      recordedRef.current = true
      session.stopClock()
      recordDealWon(gameId, { seconds: session.getElapsed(), moves: session.moves, score: computeScore(session.moves, session.getElapsed()), usedHint: hintsUsedRef.current })
      clearGameInProgress(gameId)
      pendingWinCascadeRef.current = { gen: dealTokenRef.current }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  return { won, recordedRef, pendingWinCascadeRef }
}
