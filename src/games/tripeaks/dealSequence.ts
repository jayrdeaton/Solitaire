import { Card } from '@/engine/types'

export interface TriPeaksDealStep {
  cardId: string
  card: Card
  /** Flat tableau index (see rules.ts's flatIndex/rowColOf), or -1 for the one starter card whose
   * destination is the waste zone, not a tableau slot. */
  index: number
  /** 0-based order this card is visited in the deal replay - use directly as
   * delayMs = visitOrder * dealStaggerMs(sequence.length) (components/dealing/dealSpring.ts - NOT the bare
   * DEAL_STAGGER_MS, which would put a 52-card deal back at ~2.1s). */
  visitOrder: number
}

/**
 * Replays the already-computed initial tableau (rules.ts's newGame, unchanged) in visual deal
 * order: apex first, row by row, left to right - nothing to reorder, since rules.ts's flat tableau
 * array already happens to be built in exactly that order (see flatIndex/rowColOf), the same
 * situation Pyramid's own dealSequence.ts documents for its own flat array. `starter`, the one card
 * that lands face up on the build pile rather than in any tableau slot, is appended last, matching
 * Golf's own dealSequence.ts convention for the identical situation.
 */
export function buildTriPeaksDealSequence(tableau: (Card | null)[], starter: Card): TriPeaksDealStep[] {
  const steps: TriPeaksDealStep[] = []
  let visitOrder = 0
  tableau.forEach((card, index) => {
    if (!card) return
    steps.push({ cardId: card.id, card, index, visitOrder })
    visitOrder += 1
  })
  steps.push({ cardId: starter.id, card: starter, index: -1, visitOrder })
  return steps
}
