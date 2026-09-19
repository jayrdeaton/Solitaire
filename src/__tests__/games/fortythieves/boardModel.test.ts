import { CARD_ASPECT, faceUpFanOffset } from '@tastic/cards'

import { cardLayoutForRow } from '@/components/cardLayout'
import { columnBoardModel, computeGameLayout, fitCardWidthToHeight, GAME_CONTENT_PADDING } from '@/components/gameLayout'
import { Card } from '@/engine/types'
import { BOARD_MODEL, TALLEST_COLUMN } from '@/games/fortythieves/boardModel'
import { createFortyThievesController } from '@/games/fortythieves/rules'

const TABLEAU_COLUMNS = 10
// A phone held sideways: the rotated footprint, with the notch on the left and the home indicator below.
const WIDE_INSETS = { top: 0, right: 0, bottom: 21, left: 59 }

function tallestColumn(tableau: Card[][]) {
  const tallest = tableau.reduce((a, b) => (b.length > a.length ? b : a))
  return { faceDown: tallest.filter((c) => !c.faceUp).length, faceUp: tallest.filter((c) => c.faceUp).length }
}

function widthCardWidthFor(windowWidth: number, windowHeight: number) {
  const layout = computeGameLayout(windowWidth, windowHeight, windowHeight > windowWidth ? { top: 59, right: 0, bottom: 34, left: 0 } : WIDE_INSETS)
  return { layout, widthCardWidth: cardLayoutForRow(layout.contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS).cardWidth }
}

describe('Forty Thieves board model', () => {
  it("TALLEST_COLUMN matches a real deal's tallest column", () => {
    // Both move styles deal identically; check each so a future rules split can't quietly diverge.
    for (const runMoves of [false, true]) {
      for (const seed of [1, 12345, 987654]) {
        expect(tallestColumn(createFortyThievesController(runMoves).newGame(seed).tableau)).toEqual(TALLEST_COLUMN)
      }
    }
  })

  it('is the documented model: one top card row, the dealt column, 5 cards of headroom, default margins', () => {
    expect(BOARD_MODEL).toEqual(columnBoardModel({ topRowCards: 1, faceDown: 0, faceUp: 4, headroomFaceUp: 5 }))
    // Independent of columnBoardModel's own arithmetic: top row + (4 dealt + 5 headroom - 1 fanned) face-up
    // fans + the last, fully visible card, all in card widths.
    const H = 1 / CARD_ASPECT
    expect(BOARD_MODEL.perWidth).toBeCloseTo(H + (4 - 1 + 5) * faceUpFanOffset(1) + H)
    expect(BOARD_MODEL.fixed).toBe(16 + 20)
  })

  it('budgets more headroom than the default, since its columns grow well past the deal', () => {
    const withDefault = columnBoardModel({ topRowCards: 1, faceDown: 0, faceUp: 4 })
    expect(BOARD_MODEL.perWidth).toBeGreaterThan(withDefault.perWidth)
  })

  it('fits the board into a 874x402 landscape footprint, with cards of a usable size', () => {
    const { layout, widthCardWidth } = widthCardWidthFor(874, 402)
    expect(layout.isWide).toBe(true)
    const fitted = fitCardWidthToHeight(widthCardWidth, layout.availableHeight, BOARD_MODEL)
    expect(fitted).toBeLessThan(widthCardWidth) // height, not width, is the binding limit here
    expect(fitted).toBeGreaterThanOrEqual(40)
    expect(fitted * BOARD_MODEL.perWidth + BOARD_MODEL.fixed).toBeLessThanOrEqual(layout.availableHeight + 0.001)
  })

  it("leaves a real deal's tallest column uncompressed at the fitted width", () => {
    const { layout, widthCardWidth } = widthCardWidthFor(874, 402)
    const fitted = fitCardWidthToHeight(widthCardWidth, layout.availableHeight, BOARD_MODEL)
    // What useTableauMaxHeight hands PileView in the wide layout (no floor), vs. the column's own height.
    const tableauMaxHeight = layout.availableHeight - fitted / CARD_ASPECT - BOARD_MODEL.fixed
    const dealt = tallestColumn(createFortyThievesController(false).newGame(12345).tableau)
    const columnHeight = (dealt.faceUp - 1) * faceUpFanOffset(fitted) + fitted / CARD_ASPECT
    expect(columnHeight).toBeLessThanOrEqual(tableauMaxHeight)
  })

  it('is a no-op whenever height is not the binding limit', () => {
    // A roomy wide window (a landscape iPad / desktop): plenty of height for full-size cards.
    const { layout, widthCardWidth } = widthCardWidthFor(1280, 1200)
    expect(layout.isWide).toBe(true)
    expect(fitCardWidthToHeight(widthCardWidth, layout.availableHeight, BOARD_MODEL)).toBe(widthCardWidth)
  })

  it('leaves the portrait width-derived size alone (a portrait window never asks for a height fit)', () => {
    const { layout, widthCardWidth } = widthCardWidthFor(402, 874)
    expect(layout.isWide).toBe(false)
    expect(layout.contentWidth).toBe(402) // the full window width, exactly as before the wide layout existed
    expect(widthCardWidth).toBe(cardLayoutForRow(402 - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS).cardWidth)
  })
})
