import { Card, cardColor } from './types'

export function top<T>(pile: T[]): T | undefined {
  return pile.length ? pile[pile.length - 1] : undefined
}

export function isEmpty<T>(pile: T[]): boolean {
  return pile.length === 0
}

/** True if `cards` (top-to-bottom order not assumed - checked as dealt order, ascending index = deeper in pile)
 * form a valid descending, alternating-color run, e.g. black-8, red-7, black-6 (used by Klondike/FreeCell). */
export function isDescendingAltColor(cards: Card[]): boolean {
  for (let i = 1; i < cards.length; i++) {
    const prev = cards[i - 1]
    const cur = cards[i]
    if (cur.rank !== prev.rank - 1) return false
    if (cardColor(cur.suit) === cardColor(prev.suit)) return false
  }
  return true
}

/** True if `cards` form a valid descending same-suit run (used by Spider completed-sequence detection). */
export function isDescendingSameSuit(cards: Card[]): boolean {
  for (let i = 1; i < cards.length; i++) {
    const prev = cards[i - 1]
    const cur = cards[i]
    if (cur.rank !== prev.rank - 1) return false
    if (cur.suit !== prev.suit) return false
  }
  return true
}

/** True if `cards` form a descending run regardless of suit/color (used by Spider's "movable sequence" rule,
 * which is looser than the "completed set" rule above). */
export function isDescendingAnySuit(cards: Card[]): boolean {
  for (let i = 1; i < cards.length; i++) {
    if (cards[i].rank !== cards[i - 1].rank - 1) return false
  }
  return true
}

/**
 * How many cards in `pile` sit below its current movable top run - i.e. aren't reachable as a
 * single unit right now, whether because they're face-down (Klondike/Spider) or face-up but not
 * part of a well-formed run continuing from the top (FreeCell/Spider, where cards can be visible
 * yet still buried under an unrelated run). `isValidRun` is the game's own run-validity check
 * (`isDescendingAltColor` for Klondike/FreeCell, `isDescendingSameSuit` for Spider). Used to rank
 * candidate auto-move destinations: a pile that buries fewer cards is the "less committed" choice.
 */
export function buriedCount(pile: Card[], isValidRun: (cards: Card[]) => boolean): number {
  let runStart = pile.length
  while (runStart > 0 && pile[runStart - 1].faceUp && isValidRun(pile.slice(runStart - 1))) {
    runStart -= 1
  }
  return runStart
}
