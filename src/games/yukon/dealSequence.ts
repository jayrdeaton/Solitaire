import { Card } from '@/engine/types'

export interface YukonDealStep {
  cardId: string
  card: Card
  colIndex: number
  rowIndex: number
  /** 0-based order this card is visited in a two-phase replay - use directly as
   * delayMs = visitOrder * dealStaggerMs(sequence.length) (components/dealing/dealSpring.ts - NOT the bare
   * DEAL_STAGGER_MS, which would put a 52-card deal back at ~2.1s). */
  visitOrder: number
}

/**
 * Replays the already-computed final tableau (rules.ts's newGame, unchanged) in two phases, matching
 * how rules.ts itself builds it: first the Klondike-shaped base triangle (round-robin row 0..6,
 * columns whose base still reaches that row - i.e. col >= row, since column `col`'s base is `col + 1`
 * cards), then the 24 extra face-up cards fanned onto columns 2-7 (index 1..6), 4 rows each. Kept as
 * two explicit passes rather than one flat round-robin so the deal animation visually reads as "the
 * triangle forms, then extra cards rain onto the taller columns" - the same two-stage shape the deal
 * itself has, rather than an order with no relationship to it.
 */
export function buildYukonDealSequence(tableau: Card[][]): YukonDealStep[] {
  const steps: YukonDealStep[] = []
  let visitOrder = 0

  for (let row = 0; row < 7; row++) {
    for (let col = row; col < 7; col++) {
      const card = tableau[col][row]
      if (!card) continue
      steps.push({ cardId: card.id, card, colIndex: col, rowIndex: row, visitOrder })
      visitOrder += 1
    }
  }

  for (let row = 0; row < 4; row++) {
    for (let col = 1; col < 7; col++) {
      const rowIndex = col + 1 + row
      const card = tableau[col][rowIndex]
      if (!card) continue
      steps.push({ cardId: card.id, card, colIndex: col, rowIndex, visitOrder })
      visitOrder += 1
    }
  }

  return steps
}
