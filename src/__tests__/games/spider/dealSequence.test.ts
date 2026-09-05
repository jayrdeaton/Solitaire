import { Card } from '@/engine/types'
import { buildSpiderDealSequence } from '@/games/spider/dealSequence'
import { createSpiderController } from '@/games/spider/rules'

function card(id: string): Card {
  return { id, suit: 'clubs', rank: 1, faceUp: true }
}

describe('buildSpiderDealSequence', () => {
  it('visits uneven columns round-robin, bottom-to-top per column', () => {
    const a = card('a')
    const b = card('b')
    const c = card('c')
    const d = card('d')
    const e = card('e')
    const f = card('f')
    const tableau = [[a], [b, c], [d, e, f]]

    const steps = buildSpiderDealSequence(tableau)

    expect(steps.map((s) => s.cardId)).toEqual(['a', 'b', 'd', 'c', 'e', 'f'])
    expect(steps.map((s) => s.visitOrder)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('produces 54 steps for a real 10-column deal, each column strictly increasing in rowIndex as visitOrder increases', () => {
    const controller = createSpiderController(1)
    const state = controller.newGame(12345)

    const steps = buildSpiderDealSequence(state.tableau)

    expect(steps.length).toBe(54)

    const lastRowSeenByCol = new Map<number, number>()
    steps.forEach((step) => {
      const lastRow = lastRowSeenByCol.get(step.colIndex)
      if (lastRow !== undefined) {
        expect(step.rowIndex).toBeGreaterThan(lastRow)
      }
      lastRowSeenByCol.set(step.colIndex, step.rowIndex)
    })
  })
})
