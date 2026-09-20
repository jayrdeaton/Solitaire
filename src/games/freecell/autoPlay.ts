// FreeCell's auto-play policy - two deliberately separate behaviors, both pure so they can be
// tested against real boards without rendering the screen (see FreeCellScreen.tsx for the wiring).
//
// 1. The SAFE-CARD cascade (engine/autoFoundation.ts's mechanism A, driven by
//    useAutoFoundationCascade): after the player TAPS a card and tap-to-move sends it to a
//    foundation, cards that are provably safe to send up follow it one at a time. It starts from
//    nothing else - not a drag onto a foundation, not a tap that lands on a column/freecell, and
//    never from one of its own (silent) moves' side effects.
//
// 2. The FINISH (mechanism B, driven by useAutoFinish): once the rest of the board can go up on
//    foundation moves alone - every column already sorted, highest at the bottom - there is no
//    decision left to protect, so every remaining card is swept up at once at sweep pace. That is
//    a property of the BOARD, so any player move can start it (a drag, a tap, a move to a column),
//    not just a foundation one.
//
// The cascade steps aside the moment the board is finishable (nextSafeCascadeStep returns null),
// so the two never both try to fire a card at the same settle.

import { AutoCompleteStep, findSafeAutoPlay, isFullyAutoCompletable, nextAutoCompleteMove } from '@/engine/autoFoundation'
import { AccessibleCard, PileRef } from '@/engine/gameTypes'
import { SUITS } from '@/engine/types'

import { FreeCellController, FreeCellState } from './rules'

/** How a move reached applyMove. `silent` is an auto-played card (never a player decision);
 * `viaTap` is tap-to-move, as opposed to a drag's drop. */
export interface MoveSource {
  silent?: boolean
  viaTap?: boolean
}

/** Whether a just-committed move starts the safe-card cascade - only the player's own tap whose
 * resolved destination is a foundation. See this file's header for what deliberately doesn't. */
export function armsSafeCascade(to: PileRef, source: MoveSource): boolean {
  return !source.silent && !!source.viaTap && to.zone === 'foundation'
}

/** Whether a just-committed move lets the finish start once the board settles - any move the
 * player made themselves, wherever it went. Auto-played (silent) moves never do: they already
 * happen inside a cascade or a finish. */
export function allowsFinish(source: MoveSource): boolean {
  return !source.silent
}

/** True once every card still on the board can reach a foundation by foundation moves alone
 * (engine/autoFoundation.ts's mechanism B). False on a won board - nothing is left to finish. */
export function canAutoFinish(state: FreeCellState): boolean {
  return !FreeCellController.isWon(state) && isFullyAutoCompletable(FreeCellController, state)
}

function foundationStep(entry: AccessibleCard): { entry: AccessibleCard; to: PileRef } {
  return { entry, to: { zone: 'foundation', index: SUITS.indexOf(entry.card.suit) } }
}

/** The next card the finish should send up, or null if there's none (won, or not finishable). */
export function nextFinishMove(state: FreeCellState): { entry: AccessibleCard; to: PileRef } | null {
  if (!canAutoFinish(state)) return null
  const entry = nextAutoCompleteMove(FreeCellController, state)
  return entry ? foundationStep(entry) : null
}

/** The next card the safe-card cascade should send up, or null once it has run dry - including the
 * moment the board becomes finishable, when the finish takes over (see this file's header). */
export function nextSafeCascadeStep(state: FreeCellState): AutoCompleteStep | null {
  if (!FreeCellController.accessibleCards || canAutoFinish(state)) return null
  const entry = findSafeAutoPlay(FreeCellController.accessibleCards(state), state.foundation)
  return entry ? { kind: 'play', ...foundationStep(entry) } : null
}
