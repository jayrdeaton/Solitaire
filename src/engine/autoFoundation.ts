// Auto-play-to-foundation: two independent mechanisms - see useAutoFoundationCascade's
// computeNextStep for how each game composes them.
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
// Both of the above consider ONLY foundation moves, and only cards already reported by the
// controller's accessibleCards() - never stock. For Klondike this means isFullyAutoCompletable
// can't return true while the stock still has cards in it: isWon requires all 52 cards on
// foundations, and nothing in these two functions ever draws from stock to reach them.
//
// isFullyAutoCompletableWithDraws/nextAutoCompleteMoveWithDraws extend mechanism B, for the games
// that have a stock, to also simulate drawing from it once no foundation move is available. This
// doesn't reopen the "full solver" problem the comment above warns about: a draw is forced and
// deterministic (the next card is always the same one, there's no choice to branch on), unlike a
// tableau-to-tableau or freecell move, which genuinely is a choice. A run of draws with no
// foundation move in between can revisit an earlier arrangement (via recycling), so - unlike plain
// mechanism B, which only ever makes monotonic progress - this needs an explicit "have I seen this
// exact position before" guard to prove termination when the deal isn't actually clearable this
// way.

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
 * can make the next card both accessible and safe.
 *
 * A waste-top ace is included here like any other card - drawing or revealing an ace is meant to
 * play it immediately as a deliberate payoff for the player (see useAutoFoundationCascade's
 * armFromAceEvent, which is what actually surfaces this in practice as soon as the ace lands,
 * rather than waiting on this function to be reached via the normal cascade). */
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

/** One step of a draws-aware auto-complete cascade (see isFullyAutoCompletableWithDraws below):
 * either an ordinary foundation play, a plain stock draw/recycle with nothing new immediately
 * playable, or a draw that itself exposes a card ready to go straight to its foundation. Never
 * names a concrete state type - a draw's outcome is read back through the same accessibleCards()/
 * tryMove() interface as everything else here, never by reaching into TState's own shape. */
export type AutoCompleteStep = { kind: 'play'; entry: AccessibleCard; to: PileRef } | { kind: 'draw' } | { kind: 'drawAndPlay'; entry: AccessibleCard; to: PileRef }

/** Shared by isFullyAutoCompletableWithDraws's own loop and nextAutoCompleteMoveWithDraws, same
 * reasoning as findNextFoundationMove above. Tries a foundation move first; only reaches for the
 * stock once none of the currently accessible cards can move. A drawn card is only ever detected
 * indirectly, by asking findNextFoundationMove again against the post-draw state - never by
 * reading the drawn card off TState directly - since nothing else could have newly become
 * accessible-and-legal from a draw alone (draws never touch tableau/freecell/foundation), so any
 * move that check finds is necessarily the just-drawn card. */
function findNextAutoCompleteStepWithDraws<TState>(controller: GameController<TState>, state: TState): AutoCompleteStep | null {
  const playEntry = findNextFoundationMove(controller, state)
  if (playEntry) return { kind: 'play', entry: playEntry, to: { zone: 'foundation', index: suitIndex(playEntry.card.suit) } }
  if (!controller.drawStock) return null
  const afterDraw = controller.drawStock(state)
  if (!afterDraw) return null
  const drawEntry = findNextFoundationMove(controller, afterDraw)
  if (drawEntry) return { kind: 'drawAndPlay', entry: drawEntry, to: { zone: 'foundation', index: suitIndex(drawEntry.card.suit) } }
  return { kind: 'draw' }
}

/** Draws-aware counterpart of isFullyAutoCompletable, for games with a stock: also simulates
 * drawing (and recycling, as many passes as it takes) once no foundation move is currently
 * available, rather than giving up the instant accessibleCards() runs dry. See this file's header
 * comment for why a forced, deterministic draw doesn't reopen the "full solver" problem mechanism
 * B otherwise avoids.
 *
 * Termination: a 'play' step always strictly grows the foundation (at most 52 total, or however
 * many cards this game deals), so any run of consecutive 'draw' steps is finite - the only way this
 * loop could fail to terminate is by recycling through the exact same stock/waste arrangement
 * forever with nothing ever playable in between, which `seen` catches (recycling can only ever
 * reproduce a position that's already been visited, never a genuinely new one, once no play has
 * happened since the last time this exact arrangement occurred). */
export function isFullyAutoCompletableWithDraws<TState>(controller: GameController<TState>, state: TState): boolean {
  if (!controller.accessibleCards || !controller.drawStock) return false
  const seen = new Set<string>()
  let cur = state
  while (!controller.isWon(cur)) {
    const step = findNextAutoCompleteStepWithDraws(controller, cur)
    if (!step) return false
    if (step.kind === 'play') {
      cur = controller.tryMove(cur, { from: step.entry.ref, to: step.to, count: 1 })! // unreachable null - findNextFoundationMove only returns moves tryMove already accepted
    } else if (step.kind === 'drawAndPlay') {
      const afterDraw = controller.drawStock(cur)! // unreachable null - findNextAutoCompleteStepWithDraws already called this and got a result
      cur = controller.tryMove(afterDraw, { from: step.entry.ref, to: step.to, count: 1 })! // unreachable null - same reasoning as the 'play' branch above
    } else {
      const key = JSON.stringify(cur)
      if (seen.has(key)) return false
      seen.add(key)
      cur = controller.drawStock(cur)! // unreachable null - findNextAutoCompleteStepWithDraws already called this and got a result
    }
  }
  return true
}

/** The next single step in a draws-aware full auto-complete cascade - only meaningful once
 * isFullyAutoCompletableWithDraws has confirmed true; each successive call (after applying the
 * previous step for real) advances the cascade by exactly one step. */
export function nextAutoCompleteMoveWithDraws<TState>(controller: GameController<TState>, state: TState): AutoCompleteStep | null {
  return findNextAutoCompleteStepWithDraws(controller, state)
}
