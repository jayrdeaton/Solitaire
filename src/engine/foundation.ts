// Foundation-pile helpers shared by every game with a suit-indexed foundation (Klondike, FreeCell)
// and by the auto-play-to-foundation feature (autoFoundation.ts), which works across both.

import { top } from './pile'
import { Card, Suit, SUITS } from './types'

export function canPlaceOnFoundation(dest: Card[], moving: Card): boolean {
  const destTop = top(dest)
  if (destTop === undefined) return moving.rank === 1
  return destTop.suit === moving.suit && moving.rank === destTop.rank + 1
}

export function suitIndex(suit: Suit): number {
  return SUITS.indexOf(suit)
}
