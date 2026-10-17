// FreeCell's auto-play policy - two deliberately separate behaviors, both pure so they can be
// tested against real boards without rendering the screen (see FreeCellScreen.tsx for the wiring).
//
// 1. The SAFE-CARD cascade (engine/autoFoundation.ts's mechanism A, driven by
//    useAutoFoundationCascade): only after the player's own play of a card to a foundation (a tap or
//    a drag), cards that are provably safe to send up follow it one at a time. Any other move of
//    theirs (to a column or a freecell) stops it.
//
// 2. The FINISH (mechanism B, driven by useAutoFinish): once the rest of the board can go up on
//    foundation moves alone - every column already sorted, highest at the bottom; FreeCell hides
//    nothing, so that is all "solved" takes - there is no decision left to protect, so every remaining
//    card files away on its own, at a pace that ramps up (finishGapMs). Unlike the cascade it follows
//    ANY move of the player's that leaves the board solved (Jay, 2026-10-17), or the cascade a
//    foundation play set off, once it does. An undo, a resume, a new deal or a card taken back off a
//    foundation never starts it; the player's next move does.
//
// The cascade steps aside the moment the board is finishable (nextSafeCascadeStep returns null),
// so the two never both try to fire a card at the same settle.

import { AutoCompleteStep, findSafeAutoPlay, FinishMove, isFullyAutoCompletable, nextAutoCompleteMove } from '@/engine/autoFoundation'
import { AccessibleCard } from '@/engine/gameTypes'
import { SUITS } from '@/engine/types'

import { FreeCellController, FreeCellState } from './rules'

/** True once every card still on the board can reach a foundation by foundation moves alone
 * (engine/autoFoundation.ts's mechanism B). False on a won board - nothing is left to finish. */
export function canAutoFinish(state: FreeCellState): boolean {
  return !FreeCellController.isWon(state) && isFullyAutoCompletable(FreeCellController, state)
}

function foundationStep(entry: AccessibleCard): FinishMove {
  return { entry, to: { zone: 'foundation', index: SUITS.indexOf(entry.card.suit) } }
}

/** The next card the finish should send up, or null if there's none (won, or not finishable). */
export function nextFinishMove(state: FreeCellState): FinishMove | null {
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
