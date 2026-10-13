import { CARD_ASPECT } from '@tastic/cards'

import { cardLayoutForRow } from '@/components/cardLayout'
import { columnBoardModel, computeGameLayout, FACE_DOWN_FAN_RATIO, FACE_UP_FAN_RATIO, fitCardWidthToHeight, GAME_CONTENT_PADDING } from '@/components/gameLayout'
import { Card } from '@/engine/types'
import { BOARD_MODEL as CANFIELD_BOARD_MODEL, HEADROOM_FACE_UP, LONG_COLUMN, TALLEST_COLUMN } from '@/games/canfield/boardModel'
import { createCanfieldController } from '@/games/canfield/rules'
import { BOARD_MODEL as KLONDIKE_BOARD_MODEL } from '@/games/klondike/boardModel'

// CanfieldScreen sizes its cards off the board's 7 slots (the top row's 4 foundations + an open slot +
// waste + stock), not its 4 tableau columns - see TOP_ROW_UNITS there.
const TOP_ROW_UNITS = 7
// A phone held sideways: the rotated footprint and the insets remapped onto it (see gameLayout.test.ts).
const PHONE_LANDSCAPE = computeGameLayout(874, 402, { top: 0, right: 0, bottom: 21, left: 59 })
const PHONE_PORTRAIT = computeGameLayout(402, 874, { top: 59, right: 0, bottom: 34, left: 0 })

/** How many face-down / face-up cards a column holds, and how tall its fan is per card width. */
function describeColumn(col: Card[]) {
  const faceUp = col.filter((c) => c.faceUp).length
  const faceDown = col.length - faceUp
  return { faceDown, faceUp, fanHeight: faceDown * FACE_DOWN_FAN_RATIO + Math.max(0, faceUp - 1) * FACE_UP_FAN_RATIO }
}

function widthDerivedCardWidth(contentWidth: number): number {
  return cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, TOP_ROW_UNITS).cardWidth
}

describe('Canfield boardModel', () => {
  it.each([1, 12345, 987654321])('TALLEST_COLUMN matches the tallest tableau column of a real deal (seed %d)', (seed) => {
    const state = createCanfieldController(3).newGame(seed)
    const tallest = state.tableau.map(describeColumn).reduce((a, b) => (b.fanHeight > a.fanHeight ? b : a))
    expect(TALLEST_COLUMN).toEqual({ faceDown: tallest.faceDown, faceUp: tallest.faceUp })
  })

  it('does not count the 13-card reserve as a tableau column: it is drawn as a single card slot', () => {
    const state = createCanfieldController(3).newGame(12345)
    expect(state.reserve).toHaveLength(13)
    expect(state.tableau).toHaveLength(4)
    // Only the reserve's top card is ever rendered (ReserveCell, one card in the tableau row), so the board
    // is exactly: one top-row card + one tableau card + the headroom fans - nothing for 13 reserve cards.
    const cardHeight = 1 / CARD_ASPECT
    expect(CANFIELD_BOARD_MODEL.perWidth).toBeCloseTo(2 * cardHeight + HEADROOM_FACE_UP * FACE_UP_FAN_RATIO)
  })

  it('models a one-card-tall top row over a starting column with extra headroom for its deep builds', () => {
    expect(CANFIELD_BOARD_MODEL).toEqual(columnBoardModel({ faceDown: 0, faceUp: 1, headroomFaceUp: 6, longColumn: LONG_COLUMN }))
    expect(LONG_COLUMN).toEqual({ faceDown: 0, faceUp: 11 })
  })

  it("budgets a tableau column about as tall as Klondike's tallest one, so the two games' cards come out a similar size", () => {
    const topRow = 1 / CARD_ASPECT
    const canfieldTableau = CANFIELD_BOARD_MODEL.perWidth - topRow
    const klondikeTableau = KLONDIKE_BOARD_MODEL.perWidth - topRow
    expect(Math.abs(canfieldTableau - klondikeTableau)).toBeLessThan(0.25)
    expect(CANFIELD_BOARD_MODEL.fixed).toBe(KLONDIKE_BOARD_MODEL.fixed)
  })

  it("comes out within a few points of Klondike's card on a phone held sideways, long columns included", () => {
    const widthCardWidth = widthDerivedCardWidth(PHONE_LANDSCAPE.contentWidth)
    const canfield = fitCardWidthToHeight(widthCardWidth, PHONE_LANDSCAPE.availableHeight, CANFIELD_BOARD_MODEL)
    const klondike = fitCardWidthToHeight(widthCardWidth, PHONE_LANDSCAPE.availableHeight, KLONDIKE_BOARD_MODEL)
    expect(Math.abs(canfield - klondike)).toBeLessThan(4)
  })

  describe('in the wide layout (874x402 phone, rotated)', () => {
    const widthCardWidth = widthDerivedCardWidth(PHONE_LANDSCAPE.contentWidth)
    const fitted = fitCardWidthToHeight(widthCardWidth, PHONE_LANDSCAPE.availableHeight, CANFIELD_BOARD_MODEL)

    it('is height-limited, so the cards shrink below the width-derived size', () => {
      expect(PHONE_LANDSCAPE.isWide).toBe(true)
      expect(fitted).toBeLessThan(widthCardWidth)
    })

    it('fits the board in the available height and keeps cards a playable size', () => {
      expect(CANFIELD_BOARD_MODEL.perWidth * fitted + CANFIELD_BOARD_MODEL.fixed).toBeLessThanOrEqual(PHONE_LANDSCAPE.availableHeight + 0.001)
      expect(fitted).toBeGreaterThanOrEqual(40)
    })

    it('is a no-op whenever the height is not the binding limit', () => {
      const roomy = computeGameLayout(2000, 1200, { top: 0, right: 0, bottom: 0, left: 0 })
      const roomyWidthCardWidth = widthDerivedCardWidth(roomy.contentWidth)
      expect(fitCardWidthToHeight(roomyWidthCardWidth, roomy.availableHeight, CANFIELD_BOARD_MODEL)).toBe(roomyWidthCardWidth)
    })
  })

  it('leaves portrait to the width-derived size: the height never binds on a 402x874 phone', () => {
    const widthCardWidth = widthDerivedCardWidth(PHONE_PORTRAIT.contentWidth)
    expect(PHONE_PORTRAIT.isWide).toBe(false)
    // useFittedCardWidth skips the fit entirely in portrait; this confirms the fit would not have
    // changed the number anyway, so there is no portrait behaviour to preserve by skipping it.
    expect(fitCardWidthToHeight(widthCardWidth, PHONE_PORTRAIT.availableHeight, CANFIELD_BOARD_MODEL)).toBe(widthCardWidth)
  })
})
