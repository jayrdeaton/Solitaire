import { CARD_ASPECT } from '@tastic/cards'

import { CARD_GAP_MIN, cardLayoutForRow } from '@/components/cardLayout'
import { columnBoardModel, computeGameLayout, FACE_DOWN_FAN_RATIO, FACE_UP_FAN_RATIO, fitCardWidthToHeight, GAME_CONTENT_PADDING, LONG_COLUMN_MIN_CARD_WIDTH } from '@/components/gameLayout'
import { Card } from '@/engine/types'
import { BOARD_MODEL, LONG_COLUMN, TALLEST_COLUMN } from '@/games/spider/boardModel'
import { createSpiderController } from '@/games/spider/rules'

const TABLEAU_COLUMNS = 10
const H = 1 / CARD_ASPECT

/** A phone held sideways: 874x402 with the notch on the left and the home indicator at the bottom. */
const LANDSCAPE_INSETS = { top: 0, right: 0, bottom: 21, left: 59 }
const PORTRAIT_INSETS = { top: 59, right: 0, bottom: 34, left: 0 }

function tallestColumn(tableau: Card[][]): { faceDown: number; faceUp: number } {
  // "Tallest" as the fan actually draws it: face-down cards fan tighter than face-up ones, so the
  // column with the most cards is not necessarily the tallest.
  const counts = tableau.map((col) => ({ faceDown: col.filter((c) => !c.faceUp).length, faceUp: col.filter((c) => c.faceUp).length }))
  const height = (c: { faceDown: number; faceUp: number }) => c.faceDown * FACE_DOWN_FAN_RATIO + Math.max(0, c.faceUp - 1) * FACE_UP_FAN_RATIO
  return counts.reduce((best, c) => (height(c) > height(best) ? c : best))
}

function widthDerivedCardWidth(contentWidth: number): number {
  return cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, TABLEAU_COLUMNS).cardWidth
}

describe('spider TALLEST_COLUMN', () => {
  for (const numSuits of [1, 2, 4] as const) {
    it(`matches the tallest column of a real ${numSuits}-suit deal`, () => {
      const state = createSpiderController(numSuits).newGame(12345)
      expect(state.tableau).toHaveLength(TABLEAU_COLUMNS)
      expect(tallestColumn(state.tableau)).toEqual(TALLEST_COLUMN)
    })
  }
})

describe('spider BOARD_MODEL', () => {
  it('is one card-tall top row over the default-headroom columnBoardModel, and a 22-card column at the minimum fan spacing', () => {
    expect(BOARD_MODEL).toEqual(columnBoardModel({ topRowCards: 1, faceDown: 5, faceUp: 1, headroomFaceUp: 3, longColumn: LONG_COLUMN }))
    expect(LONG_COLUMN).toEqual({ faceDown: 0, faceUp: 22 })
    // top row + (5 face-down + 3 face-up fans + the last card) in card widths, then margin 16 + padding 20.
    expect(BOARD_MODEL.perWidth).toBeCloseTo(H + (5 * FACE_DOWN_FAN_RATIO + 3 * FACE_UP_FAN_RATIO + H))
    expect(BOARD_MODEL.fixed).toBe(16 + 20)
  })
})

describe('spider card size in the wide layout', () => {
  const layout = computeGameLayout(874, 402, LANDSCAPE_INSETS)

  it('is a wide layout', () => {
    expect(layout.isWide).toBe(true)
  })

  it('fits the board in the available height and stays playable', () => {
    const w = fitCardWidthToHeight(widthDerivedCardWidth(layout.contentWidth), layout.availableHeight, BOARD_MODEL)
    expect(w * BOARD_MODEL.perWidth + BOARD_MODEL.fixed).toBeLessThanOrEqual(layout.availableHeight + 0.001)
    expect(w).toBeGreaterThanOrEqual(40)
  })

  it('shrinks for its long column only down to LONG_COLUMN_MIN_CARD_WIDTH: a 22-card column cannot fit a phone held sideways at a readable size, so a longer one scrolls', () => {
    const widthCardWidth = widthDerivedCardWidth(layout.contentWidth)
    expect(fitCardWidthToHeight(widthCardWidth, layout.availableHeight, BOARD_MODEL)).toBe(LONG_COLUMN_MIN_CARD_WIDTH)
  })

  it('fits its long column at a bigger card where the window is tall enough (a landscape iPad or desktop window)', () => {
    const roomy = computeGameLayout(1280, 900, { top: 0, right: 0, bottom: 0, left: 0 })
    const widthCardWidth = widthDerivedCardWidth(roomy.contentWidth)
    const w = fitCardWidthToHeight(widthCardWidth, roomy.availableHeight, BOARD_MODEL)
    expect(w).toBeGreaterThan(LONG_COLUMN_MIN_CARD_WIDTH)
    expect(w).toBeLessThan(widthCardWidth)
    expect(w * BOARD_MODEL.long!.perWidth + BOARD_MODEL.fixed).toBeCloseTo(roomy.availableHeight, 6)
  })

  it('shrinks the cards further only for the deal itself, when the window is too short for even that at the floor', () => {
    const short = computeGameLayout(874, 240, { top: 0, right: 0, bottom: 0, left: 59 })
    const widthCardWidth = widthDerivedCardWidth(short.contentWidth)
    const w = fitCardWidthToHeight(widthCardWidth, short.availableHeight, BOARD_MODEL)
    expect(w).toBeLessThan(LONG_COLUMN_MIN_CARD_WIDTH)
    expect(w * BOARD_MODEL.perWidth + BOARD_MODEL.fixed).toBeCloseTo(short.availableHeight, 6)
  })
})

describe('spider card size in portrait', () => {
  it('is not height-fitted: portrait is not the wide layout, so the width-derived size is used as-is', () => {
    const layout = computeGameLayout(402, 874, PORTRAIT_INSETS)
    expect(layout.isWide).toBe(false)
    // (402 - 2*GAME_CONTENT_PADDING - 9 gaps of CARD_GAP_MIN) / 10 columns
    const row = 402 - GAME_CONTENT_PADDING * 2 - (TABLEAU_COLUMNS - 1) * CARD_GAP_MIN
    expect(widthDerivedCardWidth(layout.contentWidth)).toBeCloseTo(row / TABLEAU_COLUMNS, 6)
  })
})
