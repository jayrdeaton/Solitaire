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

/** Always true - the `isValidRun` predicate Yukon passes to buriedCount/runCountFrom/
 * pickBestTableauTarget. Unlike Klondike/FreeCell (isDescendingAltColor) or Spider
 * (isDescendingSameSuit), Yukon has no run-validity requirement at all: any face-up card, plus
 * everything stacked above it, is always a legal group to move together. */
export function alwaysValidRun(): boolean {
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

/** True if the top `indexFromTop + 1` cards of `pile` are all face-up and (when more than one)
 * form a valid run per `isValidRun` - i.e. legally draggable as one unit starting at that depth.
 * Returns that run length if so, 0 otherwise. Shared by Klondike/FreeCell (isValidRun =
 * isDescendingAltColor) and Spider (isValidRun = isDescendingSameSuit) for their drag-config
 * getRunCount callbacks - Pyramid has no multi-card tableau runs, so N/A there. The face-up check
 * is a no-op for FreeCell (whose whole tableau is always face-up), but must stay unconditional:
 * Klondike has genuine face-down cards, and a run dipping into one is never draggable. */
export function runCountFrom(pile: Card[], indexFromTop: number, isValidRun: (cards: Card[]) => boolean): number {
  const count = indexFromTop + 1
  const run = pile.slice(pile.length - count)
  if (run.some((c) => !c.faceUp)) return 0
  if (count > 1 && !isValidRun(run)) return 0
  return count
}

/** The card newly exposed at the top of a pile by a move that took `count` cards off it, if that
 * move revealed a face-down card - null if nothing was revealed (the pile emptied entirely, or the
 * newly-exposed card was already face-up). `before`/`after` are the same pile's contents
 * immediately before/after the move; every tryMove in this app only ever splices the top `count`
 * cards off a pile, leaving every card below at its original index, so the newly-exposed card (if
 * any) always sits at the same `before.length - count - 1` index in both arrays. */
export function detectRevealedCard(before: Card[], after: Card[], count: number): Card | null {
  const idx = before.length - count - 1
  if (idx < 0) return null
  const prev = before[idx]
  const next = after[idx]
  return prev && next && !prev.faceUp && next.faceUp ? next : null
}
