import { Card } from '@/engine/types'

export interface FortyThievesDealStep {
  cardId: string
  card: Card
  colIndex: number
  rowIndex: number
  /** 0-based order this card is visited in a round-robin replay - use directly as
   * delayMs = visitOrder * dealStaggerMs(sequence.length), then paceFaceUpDeal (components/dealing/dealSpring.ts - NOT the bare
   * DEAL_STAGGER_MS, which would put a 52-card deal back at ~2.1s). */
  visitOrder: number
}

/**
 * Replays the already-computed final tableau (rules.ts's newGame, unchanged) round-robin across
 * the 10 equal-height columns (row 0 to every column, then row 1, ...), the same visiting shape
 * Golf/Klondike/Spider/FreeCell use for their own deals - kept as this game's own copy rather than
 * a shared import, per this app's established per-game dealSequence convention (see Spider's own
 * dealSequence.ts for the full rationale). The 64-card stock is deliberately not part of this
 * sequence - like every other game's leftover stock pile, it just appears as a pile with no
 * individual flight.
 */
export function buildFortyThievesDealSequence(tableau: Card[][]): FortyThievesDealStep[] {
  const steps: FortyThievesDealStep[] = []
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
