import { MutableRefObject, useRef, useState } from 'react'

import { GameSession } from '@/components/useGameSession'
import { GameController } from '@/engine/gameTypes'
import { computeScore } from '@/engine/score'
import { gameOfVariant, VariantId } from '@/engine/variants'
import { clearGameInProgress } from '@/stores/gameInProgress'
import { DealMetrics } from '@/stores/statsTypes'

export interface FoundationWinCheck<TState> {
  won: boolean
  setWon: (won: boolean) => void
  recordedWinRef: MutableRefObject<boolean>
  /** Mirrors pendingDealTokenRef/pendingFlightRef's own shape - set by checkWin, consumed by the
   * caller's own [state]-effect once the winning foundation cards have actually committed and
   * registered themselves in CardRegistry (see runWinCascade). */
  pendingWinCascadeRef: MutableRefObject<{ gen: number } | null>
  checkWin: (next: TState) => void
}

/**
 * Shared by Klondike and FreeCell - the two games that check `controller.isWon()` imperatively,
 * synchronously inside their own move handler (checkWin runs at the end of applyMove, the same
 * tick as the state update). Spider/Pyramid instead derive `won` fresh every render and use a
 * separate `useEffect` for the one-time side effects below - see useDerivedWinCheck for that
 * shape. The two are genuinely different timing strategies, not just a naming difference, so they
 * stay two separate hooks rather than being forced into one.
 */
export function useFoundationWinCheck<TState>(
  controller: Pick<GameController<TState>, 'isWon'>,
  // The deal's game under the rules it was dealt with (engine/variants.ts): stats are kept per variant.
  variant: VariantId,
  session: GameSession,
  dealTokenRef: MutableRefObject<number>,
  recordDealWon: (variant: VariantId, metrics: DealMetrics) => unknown,
  // Whether the Hint button was pressed (and actually produced a hint) at any point during this
  // deal - read at the exact instant a win is recorded, since a screen's own ref value can't be
  // passed as a snapshot (see each screen's hintUsedThisDealRef).
  hintsUsedRef: MutableRefObject<boolean>
): FoundationWinCheck<TState> {
  const [won, setWon] = useState(false)
  const recordedWinRef = useRef(false)
  const pendingWinCascadeRef = useRef<{ gen: number } | null>(null)

  // Reads the move count through session.getMoves(), never a `session.moves` the caller closed over: an auto-played
  // winning card commits after a measurement await, and a move the player made during that await is in the live count only.
  function checkWin(next: TState) {
    if (controller.isWon(next) && !recordedWinRef.current) {
      recordedWinRef.current = true
      session.stopClock()
      setWon(true)
      const moves = session.getMoves()
      const seconds = session.getElapsed()
      recordDealWon(variant, { seconds, moves, score: computeScore(moves, seconds), usedHint: hintsUsedRef.current })
      clearGameInProgress(gameOfVariant(variant))
      pendingWinCascadeRef.current = { gen: dealTokenRef.current }
    }
  }

  return { won, setWon, recordedWinRef, pendingWinCascadeRef, checkWin }
}
