import { Card } from '@/engine/types'

export interface AcesUpDealStep {
  cardId: string
  card: Card
  pileIndex: number
  /** 0-based order this card is visited in a round-robin replay - use directly as
   * delayMs = visitOrder * dealStaggerMs(sequence.length) (components/dealing/dealSpring.ts - NOT the bare
   * DEAL_STAGGER_MS, which would put a 52-card deal back at ~2.1s). */
  visitOrder: number
}

/**
 * Replays the initial deal (rules.ts's newGame, unchanged) - one card per pile, left to right.
 * Only the initial 4-card deal is animated this way; later "deal a round" actions during play (see
 * AcesUpScreen.tsx's handleDrawStock) get the same lightweight instant-flip treatment every other
 * game's own mid-game stock draws already use, not a fresh dealSequence replay.
 */
export function buildAcesUpDealSequence(piles: Card[][]): AcesUpDealStep[] {
  const steps: AcesUpDealStep[] = []
  piles.forEach((pile, pileIndex) => {
    const card = pile[0]
    if (!card) return
    steps.push({ cardId: card.id, card, pileIndex, visitOrder: pileIndex })
  })
  return steps
}
