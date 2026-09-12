import { Card } from '@/engine/types'

export interface GolfDealStep {
  cardId: string
  card: Card
  /** -1 for the one starting build-pile card (destination is the waste zone, not a tableau column). */
  colIndex: number
  rowIndex: number
  /** 0-based order this card is visited in a round-robin replay - use directly as
   * delayMs = visitOrder * DEAL_STAGGER_MS. */
  visitOrder: number
}

/**
 * Replays the already-computed final tableau (rules.ts's newGame, unchanged) round-robin across the
 * 7 equal-height columns (row 0 to every column, then row 1, ...), the same visiting shape
 * Klondike/Spider/FreeCell use for their own deals - kept as this game's own copy rather than a
 * shared import, per this app's established per-game dealSequence convention (see Spider's own
 * dealSequence.ts for the full rationale). `starter`, the one card that lands face up on the build
 * pile rather than in any tableau column, is appended last so the deal reads as "the tableau fills,
 * then the first build-pile card flips" - the same order a real dealer would use.
 */
export function buildGolfDealSequence(tableau: Card[][], starter: Card): GolfDealStep[] {
  const steps: GolfDealStep[] = []
  const maxRows = tableau.reduce((max, col) => Math.max(max, col.length), 0)
  let visitOrder = 0
  for (let row = 0; row < maxRows; row++) {
    for (let col = 0; col < tableau.length; col++) {
      const card = tableau[col][row]
      if (!card) continue
      steps.push({ cardId: card.id, card, colIndex: col, rowIndex: row, visitOrder })
      visitOrder += 1
    }
  }
  steps.push({ cardId: starter.id, card: starter, colIndex: -1, rowIndex: 0, visitOrder })
  return steps
}
