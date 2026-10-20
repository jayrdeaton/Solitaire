// Foundation-pile helpers shared by every game with a suit-indexed foundation (Klondike, FreeCell)
// and by the auto-play-to-foundation feature (autoFoundation.ts), which works across both.

import { top } from './pile'
import { Card, Suit } from './types'

/** The suit each foundation slot is locked to, left to right: new deck order (and the app icon's), so the colors
 * alternate. Deliberately NOT the deck's own SUITS order (clubs, diamonds, hearts, spades), which builds every deck:
 * changing that would change every seeded deal. Saves from before this order are remapped as they load
 * (stores/gameInProgress.ts's remapLegacyFoundations). */
export const FOUNDATION_SUITS: readonly Suit[] = ['spades', 'diamonds', 'clubs', 'hearts']

/** The stamp every saved game carries (SavedGame's foundationLayout) once its foundation slots follow FOUNDATION_SUITS. A
 * save without it was made while the slots followed the deck's SUITS order. */
export const FOUNDATION_LAYOUT = 1

export function canPlaceOnFoundation(dest: Card[], moving: Card): boolean {
  const destTop = top(dest)
  if (destTop === undefined) return moving.rank === 1
  return destTop.suit === moving.suit && moving.rank === destTop.rank + 1
}

export function suitIndex(suit: Suit): number {
  return FOUNDATION_SUITS.indexOf(suit)
}
