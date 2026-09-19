import { cardLayoutForRow } from '@/components/cardLayout'
import { columnBoardModel, computeGameLayout, FACE_DOWN_FAN_RATIO, FACE_UP_FAN_RATIO, fitCardWidthToHeight, GAME_CONTENT_PADDING } from '@/components/gameLayout'
import { Card } from '@/engine/types'
import { BOARD_MODEL, TALLEST_COLUMN } from '@/games/klondike/boardModel'
import { createKlondikeController } from '@/games/klondike/rules'

const TABLEAU_COLUMNS = 7
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
  return cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS).cardWidth
}

describe('Klondike boardModel', () => {
  it.each([1, 12345, 987654321])('TALLEST_COLUMN matches the tallest column of a real deal (seed %d)', (seed) => {
    const state = createKlondikeController(1).newGame(seed)
    const tallest = state.tableau.map(describeColumn).reduce((a, b) => (b.fanHeight > a.fanHeight ? b : a))
    expect(TALLEST_COLUMN).toEqual({ faceDown: tallest.faceDown, faceUp: tallest.faceUp })
  })

  it('deals the same column shapes in draw-3 as in draw-1, so one model serves both', () => {
    const shapes = (draw: 1 | 3) =>
      createKlondikeController(draw)
        .newGame(7)
        .tableau.map((col) => [describeColumn(col).faceDown, describeColumn(col).faceUp])
    expect(shapes(3)).toEqual(shapes(1))
  })

  it('models a one-card-tall top row over the tallest column with the default headroom', () => {
    expect(BOARD_MODEL).toEqual(columnBoardModel({ faceDown: 6, faceUp: 1 }))
  })

  describe('in the wide layout (874x402 phone, rotated)', () => {
    const widthCardWidth = widthDerivedCardWidth(PHONE_LANDSCAPE.contentWidth)
    const fitted = fitCardWidthToHeight(widthCardWidth, PHONE_LANDSCAPE.availableHeight, BOARD_MODEL)

    it('is height-limited, so the cards shrink below the width-derived size', () => {
      expect(PHONE_LANDSCAPE.isWide).toBe(true)
      expect(fitted).toBeLessThan(widthCardWidth)
    })

    it('fits the board in the available height and keeps cards a playable size', () => {
      expect(BOARD_MODEL.perWidth * fitted + BOARD_MODEL.fixed).toBeLessThanOrEqual(PHONE_LANDSCAPE.availableHeight + 0.001)
      expect(fitted).toBeGreaterThanOrEqual(40)
    })

    it('is a no-op whenever the height is not the binding limit', () => {
      const roomy = computeGameLayout(2000, 1200, { top: 0, right: 0, bottom: 0, left: 0 })
      const roomyWidthCardWidth = widthDerivedCardWidth(roomy.contentWidth)
      expect(fitCardWidthToHeight(roomyWidthCardWidth, roomy.availableHeight, BOARD_MODEL)).toBe(roomyWidthCardWidth)
    })
  })

  it('leaves portrait to the width-derived size: the height never binds on a 402x874 phone', () => {
    const widthCardWidth = widthDerivedCardWidth(PHONE_PORTRAIT.contentWidth)
    expect(PHONE_PORTRAIT.isWide).toBe(false)
    // useFittedCardWidth skips the fit entirely in portrait; this confirms the fit would not have
    // changed the number anyway, so there is no portrait behaviour to preserve by skipping it.
    expect(fitCardWidthToHeight(widthCardWidth, PHONE_PORTRAIT.availableHeight, BOARD_MODEL)).toBe(widthCardWidth)
  })
})
