import { top } from '@/engine/pile'
import { Card } from '@/engine/types'

export interface CanfieldDealStep {
  cardId: string
  card: Card
  /** 'foundation' for the one starter card (destination is its foundation slot), 'tableau' for
   * one of the 4 single-card tableau columns, or 'reserve' for one of the reserve pile's 13 cards. */
  zone: 'foundation' | 'tableau' | 'reserve'
  /** Tableau column index (0-3) when zone is 'tableau'; unused (0) otherwise. */
  colIndex: number
  /** 0-based order this card is visited in the deal replay - use directly as
   * delayMs = visitOrder * DEAL_STAGGER_MS. */
  visitOrder: number
  /** Only meaningful when zone is 'reserve'. True for the pile's own 13th/top (face-up) card - the
   * only reserve card ReserveCell actually renders and registers in CardRegistry, so it's the only
   * reserve step runDeal can measure a destination for directly. False for the other 12 (face-down)
   * steps stacked beneath it, which have no view of their own to measure - runDeal reuses the top
   * card's own destination for those instead, and piggybacks their dealHiddenIds reveal on the top
   * card's own landed callback (see runDeal's own comment) rather than giving each its own flight,
   * since there's nowhere visually distinct for 12 cards stacked at one point to fly to. */
  reserveTop: boolean
}

/**
 * Replays the already-computed initial deal (rules.ts's newGame, unchanged): the one foundation
 * starter card first (it's cut from the very top of the deck, before anything else), then each of
 * the 4 tableau columns' single card left to right, then all 13 reserve cards last - matching the
 * order newGame itself deals them (starter, then 4 tableau cards, then the reserve, per rules.ts's
 * own cursor order), with the reserve's own 12 face-down cards preceding its 13th/top (face-up)
 * card, exactly as a real dealer lays a pile down before flipping its top card. Unlike the 34-card
 * stock (deliberately excluded here, the same treatment every other game's leftover stock pile
 * already gets - Klondike's 24 remaining stock cards, Golf/TriPeaks' own stock, etc.), every
 * reserve card IS included, even though 12 of them get no individual flight (see CanfieldDealStep's
 * own reserveTop doc comment) - so dealHiddenIds (derived from this sequence's card ids) correctly
 * covers the whole pile from the start, not just its visible top card.
 */
export function buildCanfieldDealSequence(starter: Card, tableau: Card[][], reserve: Card[]): CanfieldDealStep[] {
  const steps: CanfieldDealStep[] = []
  let visitOrder = 0
  steps.push({ cardId: starter.id, card: starter, zone: 'foundation', colIndex: 0, visitOrder, reserveTop: false })
  visitOrder += 1
  tableau.forEach((col, colIndex) => {
    const card = col[0]
    if (!card) return
    steps.push({ cardId: card.id, card, zone: 'tableau', colIndex, visitOrder, reserveTop: false })
    visitOrder += 1
  })
  const reserveTopCard = top(reserve)
  reserve.forEach((card) => {
    steps.push({ cardId: card.id, card, zone: 'reserve', colIndex: 0, visitOrder, reserveTop: card === reserveTopCard })
    visitOrder += 1
  })
  return steps
}
