import { useEffect, useRef } from 'react'

import type { GameSession } from '@/components/useGameSession'
import { GameController } from '@/engine/gameTypes'
import { gameOfVariant, VariantId } from '@/engine/variants'
import { clearGameInProgress } from '@/stores/gameInProgress'

import { LookaheadController, useBoardLookahead } from './useBoardLookahead'

export interface StuckLossCheck {
  stuck: boolean
}

/**
 * A dead board, the one loss that isn't a deal walked away from: the game's own `isStuck` (Aces Up, Golf, TriPeaks, Forty
 * Thieves and Scorpion: no legal move and no stock), or, for a game that says what progress is (GameController.progress),
 * the background look-ahead finding none anywhere (useBoardLookahead). The look-ahead is what finally gives Klondike,
 * Spider, FreeCell, Yukon, Canfield and Pyramid a loss dialog (a coworker of Jay's, 2026-10-22: none showed when a deal was
 * lost): their stock turns over for good or their moves go round in circles, so no legal move ever ran out. `stuck` is
 * derived from `state` every render (same "no separate useState mirror" shape as useDerivedWinCheck); the look-ahead's
 * part arrives a little after the board does.
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
export function useStuckLossCheck<TState>(controller: Partial<Pick<GameController<TState>, 'isStuck'>> & LookaheadController<TState>, state: TState | null, variant: VariantId, recordDealAbandoned: (variant: VariantId, played?: { seconds: number; moves: number }) => void, session?: Pick<GameSession, 'getMoves' | 'getElapsed'>): StuckLossCheck {
  const dead = useBoardLookahead(controller, state)
  const stuck = (state && controller.isStuck ? controller.isStuck(state) : false) || dead

  const latestRef = useRef({ stuck, variant, recordDealAbandoned, session })
  useEffect(() => {
    latestRef.current = { stuck, variant, recordDealAbandoned, session }
  })

  useEffect(
    () => () => {
      const { stuck: leftStuck, variant: leftVariant, recordDealAbandoned: record, session: left } = latestRef.current
      if (!leftStuck) return
      // A deal dead from the start, left without a move, isn't a loss of the player's (the same rule as New Game's).
      if (!left) record(leftVariant)
      else if (left.getMoves() > 0) record(leftVariant, { seconds: left.getElapsed(), moves: left.getMoves() })
      clearGameInProgress(gameOfVariant(leftVariant))
    },
    []
  )

  return { stuck }
}
