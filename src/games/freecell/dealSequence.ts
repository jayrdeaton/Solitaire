import { Card } from '@/engine/types'

export interface FreeCellDealStep {
  cardId: string
  card: Card
  colIndex: number
  rowIndex: number
  /** 0-based order this card is visited in a round-robin replay - use directly as
   * delayMs = visitOrder * dealStaggerMs(sequence.length) (components/dealing/dealSpring.ts - NOT the bare
   * DEAL_STAGGER_MS, which would put a 52-card deal back at ~2.1s). */
  visitOrder: number
}

/**
 * Replays the already-computed initial tableau (rules.ts's newGame, unchanged) in the order a
 * real dealer lays it out: round-robin across the columns (row 0 to every column that still
 * needs a card, then row 1, ...) rather than rules.ts's own column-by-column slicing order,
 * which exists purely to keep the RNG-driven deck-slicing simple and has no bearing on how the
 * result should be presented. Each column's cards are already bottom-to-top in the input array,
 * so visiting increasing rows per column naturally replays that column bottom-up.
 *
 * Identical algorithm to Klondike's/Spider's own dealSequence.ts (fully generic over any
 * Card[][] shape - FreeCell's columns just happen to be 7 or 6 deep instead of Klondike's
 * 1-through-7 triangle) - kept as FreeCell's own copy rather than a shared import, same as
 * Spider's copy, to keep this file's own game self contained the way every other game's
 * dealSequence-shaped logic already is.
 */
export function buildFreeCellDealSequence(tableau: Card[][]): FreeCellDealStep[] {
  const steps: FreeCellDealStep[] = []
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
