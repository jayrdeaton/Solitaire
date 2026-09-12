import { Card } from '@/engine/types'

export interface ScorpionDealStep {
  cardId: string
  card: Card
  colIndex: number
  rowIndex: number
  /** 0-based order this card is visited in a round-robin replay - use directly as
   * delayMs = visitOrder * DEAL_STAGGER_MS. */
  visitOrder: number
}

/**
 * Replays the already-computed final tableau (rules.ts's newGame, unchanged) round-robin across
 * the 7 columns (row 0 to every column that has one, then row 1, ...), the same visiting shape
 * Golf/Klondike/Spider/FreeCell use for their own deals - kept as this game's own copy rather than
 * a shared import, per this app's established per-game dealSequence convention (see Spider's own
 * dealSequence.ts for the full rationale). The assisted variant's 3 held-back stock cards are
 * deliberately not part of this sequence - like every other game's leftover stock pile, they just
 * appear as a pile with no individual flight, and only get animated later when the player actually
 * deals them in (see ScorpionScreen.tsx's own handling of drawStock).
 */
export function buildScorpionDealSequence(tableau: Card[][]): ScorpionDealStep[] {
  const steps: ScorpionDealStep[] = []
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
  return steps
}
