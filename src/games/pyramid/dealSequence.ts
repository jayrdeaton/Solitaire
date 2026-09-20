import { Card } from '@/engine/types'

export interface PyramidDealStep {
  cardId: string
  card: Card
  /** Flat pyramid index (see rules.ts's flatIndex/rowColOf) - PyramidScreen.tsx's runDeal maps
   * this back to a (row, col) and then a real on-screen position via cardPosition(). */
  index: number
  /** 0-based order this card is visited in the deal replay - use directly as
   * delayMs = visitOrder * dealStaggerMs(sequence.length) (components/dealing/dealSpring.ts - NOT the bare
   * DEAL_STAGGER_MS, which would put a 52-card deal back at ~2.1s). */
  visitOrder: number
}

/**
 * Replays the already-computed initial pyramid (rules.ts's newGame, unchanged) in visual deal
 * order: apex first, row by row, left to right - the same "how a real dealer lays it out" intent
 * as Klondike's/Spider's/FreeCell's own dealSequence.ts, just with nothing to actually reorder
 * today, since rules.ts's flat pyramid array already happens to be built in exactly that order
 * (see flatIndex/rowColOf). Kept as its own named, separately-testable step regardless - not just
 * an inline loop in PyramidScreen.tsx's runDeal - so a future change to how rules.ts builds the
 * pyramid (a difficulty variant, an alternate RNG-slicing strategy, ...) can't silently desync the
 * deal animation's visual order from the data's storage order without this function's own test
 * catching it: the same decoupling every other game's dealSequence.ts already provides between
 * rules.ts's internal deal-slicing order and how the result should be presented.
 */
export function buildPyramidDealSequence(pyramid: (Card | null)[]): PyramidDealStep[] {
  const steps: PyramidDealStep[] = []
  let visitOrder = 0
  pyramid.forEach((card, index) => {
    if (!card) return
    steps.push({ cardId: card.id, card, index, visitOrder })
    visitOrder += 1
  })
  return steps
}
