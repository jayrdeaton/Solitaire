import { top } from '@/engine/pile'
import { Card } from '@/engine/types'

export interface CanfieldDealStep {
  cardId: string
  card: Card
  /** 'foundation' for the one starter card (destination is its foundation slot), 'tableau' for
   * one of the 4 single-card tableau columns, or 'reserve' for the reserve pile's own top (13th,
   * face-up) card. */
  zone: 'foundation' | 'tableau' | 'reserve'
  /** Tableau column index (0-3) when zone is 'tableau'; unused (0) for the foundation starter and
   * the reserve step. */
  colIndex: number
  /** 0-based order this card is visited in the deal replay - use directly as
   * delayMs = visitOrder * DEAL_STAGGER_MS. */
  visitOrder: number
}

/**
 * Replays the already-computed initial deal (rules.ts's newGame, unchanged): the one foundation
 * starter card first (it's cut from the very top of the deck, before anything else), then each of
 * the 4 tableau columns' single card left to right, then finally the reserve's own top (13th,
 * face-up) card - matching the order newGame itself deals them (starter, then 4 tableau cards,
 * then the 13-card reserve last, per rules.ts's own cursor order). The other 12 (face-down)
 * reserve cards and the 34-card stock are deliberately NOT part of this sequence and get no
 * individual flight animation, the same treatment every other game's leftover stock pile already
 * gets (Klondike's 24 remaining stock cards, Golf/TriPeaks' own stock, etc. all just appear as a
 * pile rather than each flying in) - only the reserve's single visible top card needs its own
 * flight, exactly like the foundation starter and each tableau card.
 */
export function buildCanfieldDealSequence(starter: Card, tableau: Card[][], reserve: Card[]): CanfieldDealStep[] {
  const steps: CanfieldDealStep[] = []
  let visitOrder = 0
  steps.push({ cardId: starter.id, card: starter, zone: 'foundation', colIndex: 0, visitOrder })
  visitOrder += 1
  tableau.forEach((col, colIndex) => {
    const card = col[0]
    if (!card) return
    steps.push({ cardId: card.id, card, zone: 'tableau', colIndex, visitOrder })
    visitOrder += 1
  })
  const reserveTop = top(reserve)
  if (reserveTop) {
    steps.push({ cardId: reserveTop.id, card: reserveTop, zone: 'reserve', colIndex: 0, visitOrder })
    visitOrder += 1
  }
  return steps
}
