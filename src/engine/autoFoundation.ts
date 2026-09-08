// Auto-play-to-foundation: two independent mechanisms - see KlondikeScreen/FreeCellScreen's
// maybeAutoPlay for how they compose.
//
// Mechanism A (isSafeAutoPlay/findSafeAutoPlay): a per-card heuristic, checked continuously. A
// card is "safe" once BOTH opposite-color foundations are at rank >= this card's rank - 1 - i.e.
// every opposite-color card that could ever land on top of it in the tableau is already itself on
// a foundation, so this card can never be needed back.
//
// Mechanism B (isFullyAutoCompletable/nextAutoCompleteMove): "can the rest of the board clear via
// foundation moves alone, in any order?" Needed because mechanism A can deadlock: e.g. a
// foundation-legal-right-now black 5 sitting on top of a buried red 4 that its own foundation
// needs next, while the black 5 itself isn't yet "safe" by the color heuristic - mechanism A
// refuses it forever even though the position is provably fully resolvable. Order doesn't matter
// for this check: a foundation-only move only ever consumes its own pile's top card and advances
// its own suit's counter, never affecting any other pile's legality - so the "eventually playable"
// set only grows or gets consumed, and a plain greedy scan reaches the same maximal state any
// smarter ordering would. Do NOT extend this to also try tableau-to-tableau or freecell moves "to
// be smarter" - that breaks the order-independence argument above and turns this into a full
// solitaire solver, a much harder (NP-hard-ish) problem.
//
// Both mechanisms consider ONLY foundation moves, and only cards already reported by the
// controller's accessibleCards() - never stock. For Klondike this means isFullyAutoCompletable
// can't return true while the stock still has cards in it: isWon requires all 52 cards on
// foundations, and nothing here can ever draw from stock to reach them.

import { canPlaceOnFoundation, suitIndex } from './foundation'
import { AccessibleCard, GameController, PileRef } from './gameTypes'
import { top } from './pile'
import { Card, cardColor, Suit, SUITS } from './types'

function foundationRank(foundation: Card[][], suit: Suit): number {
  return top(foundation[suitIndex(suit)])?.rank ?? 0
}

/** True if no card of the opposite color could still need `card` as a tableau landing spot - see
 * "Mechanism A" above. Does not check whether the move is legal right now; see findSafeAutoPlay. */
export function isSafeAutoPlay(foundation: Card[][], card: Card): boolean {
  const oppositeColor = cardColor(card.suit) === 'red' ? 'black' : 'red'
  const oppositeSuits = SUITS.filter((s) => cardColor(s) === oppositeColor)
  const oppMin = Math.min(...oppositeSuits.map((s) => foundationRank(foundation, s)))
  return oppMin >= card.rank - 1
}

/** The next single card to safely auto-play to its foundation, if any - legal on its own suit's
 * foundation right now AND passing isSafeAutoPlay. Call again after each resulting move; a move
 * can make the next card both accessible and safe. */
export function findSafeAutoPlay(accessible: AccessibleCard[], foundation: Card[][]): AccessibleCard | null {
  for (const entry of accessible) {
    if (canPlaceOnFoundation(foundation[suitIndex(entry.card.suit)], entry.card) && isSafeAutoPlay(foundation, entry.card)) {
      return entry
    }
  }
  return null
}

/** Shared by isFullyAutoCompletable's own loop and nextAutoCompleteMove so the two can never
 * disagree about which move comes next. */
function findNextFoundationMove<TState>(controller: GameController<TState>, state: TState): AccessibleCard | null {
  if (!controller.accessibleCards) return null
  for (const entry of controller.accessibleCards(state)) {
    const to: PileRef = { zone: 'foundation', index: suitIndex(entry.card.suit) }
    if (controller.tryMove(state, { from: entry.ref, to, count: 1 })) return entry
  }
  return null
}

/** True if the entire remaining game can be cleared via foundation moves alone, in some order -
 * i.e. the player has already won and it's just a matter of mechanically sending every card up.
 * See "Mechanism B" above for why a plain greedy simulation (via the controller's own tryMove,
 * against a scratch copy of state - never the real one) is a correct decision procedure here. */
export function isFullyAutoCompletable<TState>(controller: GameController<TState>, state: TState): boolean {
  if (!controller.accessibleCards) return false
  let cur = state
  while (!controller.isWon(cur)) {
    const entry = findNextFoundationMove(controller, cur)
    if (!entry) return false
    const to: PileRef = { zone: 'foundation', index: suitIndex(entry.card.suit) }
    const result = controller.tryMove(cur, { from: entry.ref, to, count: 1 })
    if (!result) return false // unreachable - findNextFoundationMove only returns moves tryMove already accepted
    cur = result
  }
  return true
}

/** The next single move in a full auto-complete cascade - only meaningful once
 * isFullyAutoCompletable has confirmed true; each successive call (after applying the previous
 * move for real) advances the cascade by exactly one card. */
export function nextAutoCompleteMove<TState>(controller: GameController<TState>, state: TState): AccessibleCard | null {
  return findNextFoundationMove(controller, state)
}
