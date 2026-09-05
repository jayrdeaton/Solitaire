import { Card } from '@/engine/types'

export interface KlondikeDealStep {
  cardId: string
  card: Card
  colIndex: number
  rowIndex: number
  /** 0-based order this card is visited in a round-robin replay - use directly as
   * delayMs = visitOrder * DEAL_STAGGER_MS. */
  visitOrder: number
}

/**
 * Replays the already-computed final tableau (rules.ts's newGame, unchanged) in the order a real
 * dealer lays it out: round-robin across the columns (row 0 to every column that still needs a
 * card, then row 1, ...) rather than rules.ts's own column-by-column slicing order, which exists
 * purely to keep the RNG-driven deck-slicing simple and has no bearing on how the result should be
 * presented. Each column's cards are already bottom-to-top in the input array, so visiting
 * increasing rows per column naturally replays that column bottom-up over multiple rounds - no
 * reordering of any column's own cards, only of which column gets visited when.
 */
export function buildKlondikeDealSequence(tableau: Card[][]): KlondikeDealStep[] {
  const steps: KlondikeDealStep[] = []
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
