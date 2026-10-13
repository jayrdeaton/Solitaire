import { CARD_ASPECT } from '@tastic/cards'

import { CARD_GAP_MIN, CARD_WIDTH_MAX, cardLayoutForRow } from '@/components/cardLayout'
import { MIN_FAN_SCALE } from '@/components/columnTops'
import { columnBoardModel, columnFan, computeGameLayout, FACE_DOWN_FAN_RATIO, FACE_UP_FAN_RATIO, fitCardWidthToHeight, GAME_CONTENT_PADDING } from '@/components/gameLayout'
import { Card } from '@/engine/types'
import { BOARD_MODEL, LONG_COLUMN, TALLEST_COLUMN } from '@/games/acesup/boardModel'
import { AcesUpController } from '@/games/acesup/rules'
import { tableauMaxHeightFor } from '@/games/shared/useTableauMaxHeight'

const NUM_PILES = 4
const H = 1 / CARD_ASPECT

/** A phone held sideways: 874x402 with the notch on the left and the home indicator at the bottom. */
const LANDSCAPE_INSETS = { top: 0, right: 0, bottom: 21, left: 59 }
const PORTRAIT_INSETS = { top: 59, right: 0, bottom: 34, left: 0 }

function tallestPile(piles: Card[][]): { faceDown: number; faceUp: number } {
  const counts = piles.map((pile) => ({ faceDown: pile.filter((c) => !c.faceUp).length, faceUp: pile.filter((c) => c.faceUp).length }))
  const height = (c: { faceDown: number; faceUp: number }) => c.faceDown * FACE_DOWN_FAN_RATIO + Math.max(0, c.faceUp - 1) * FACE_UP_FAN_RATIO
  return counts.reduce((best, c) => (height(c) > height(best) ? c : best))
}

function widthDerivedCardWidth(contentWidth: number): number {
  return cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, NUM_PILES).cardWidth
}

describe('acesup TALLEST_COLUMN', () => {
  it('matches the tallest pile of a real deal (every pile starts as one face-up card)', () => {
    const state = AcesUpController.newGame(12345)
    expect(state.piles).toHaveLength(NUM_PILES)
    expect(tallestPile(state.piles)).toEqual(TALLEST_COLUMN)
  })
})

describe('acesup BOARD_MODEL', () => {
  it('is one card-tall top row over a columnBoardModel with 5 face-ups of headroom, and a 9-card pile at the minimum fan spacing', () => {
    expect(BOARD_MODEL).toEqual(columnBoardModel({ topRowCards: 1, faceDown: 0, faceUp: 1, headroomFaceUp: 5, longColumn: LONG_COLUMN }))
    expect(LONG_COLUMN).toEqual({ faceDown: 0, faceUp: 9 })
    // top row + (5 face-up fans + the last card) in card widths, then margin 16 + padding 20.
    expect(BOARD_MODEL.perWidth).toBeCloseTo(H + (5 * FACE_UP_FAN_RATIO + H))
    expect(BOARD_MODEL.fixed).toBe(16 + 20)
  })

  it('budgets more than the default 3 face-ups, since a pile starts as a single card and grows every stock round', () => {
    expect(BOARD_MODEL.perWidth).toBeGreaterThan(columnBoardModel({ faceDown: 0, faceUp: 1 }).perWidth)
  })
})

describe('acesup card size in the wide layout', () => {
  const layout = computeGameLayout(874, 402, LANDSCAPE_INSETS)

  it('is a wide layout', () => {
    expect(layout.isWide).toBe(true)
  })

  it('fits the board in the available height and stays playable', () => {
    const w = fitCardWidthToHeight(widthDerivedCardWidth(layout.contentWidth), layout.availableHeight, BOARD_MODEL)
    expect(w * BOARD_MODEL.perWidth + BOARD_MODEL.fixed).toBeLessThanOrEqual(layout.availableHeight + 0.001)
    expect(w).toBeGreaterThanOrEqual(40)
  })

  it('is height-limited here: 4 piles hit the 96pt card cap by width, so the fitted card is narrower, sized for a 9-card pile', () => {
    const widthCardWidth = widthDerivedCardWidth(layout.contentWidth)
    expect(widthCardWidth).toBe(96)
    const w = fitCardWidthToHeight(widthCardWidth, layout.availableHeight, BOARD_MODEL)
    expect(w).toBeLessThan(widthCardWidth)
    expect(w * BOARD_MODEL.long!.perWidth + BOARD_MODEL.fixed).toBeCloseTo(layout.availableHeight, 6)
  })

  it('is a no-op when height is not the limit', () => {
    // A tall wide window (an iPad-sized landscape footprint) has height to spare for 96pt cards.
    const tall = computeGameLayout(1366, 1024, { top: 0, right: 0, bottom: 20, left: 0 })
    expect(tall.isWide).toBe(true)
    const widthCardWidth = widthDerivedCardWidth(tall.contentWidth)
    expect(fitCardWidthToHeight(widthCardWidth, tall.availableHeight, BOARD_MODEL)).toBe(widthCardWidth)
  })
})

describe('acesup card size in portrait (AcesUpScreen fits the height in both layouts)', () => {
  /** What AcesUpScreen draws: the width-derived card, fitted to the height. */
  const cardWidthIn = (width: number, height: number, insets: { top: number; right: number; bottom: number; left: number }) => {
    const layout = computeGameLayout(width, height, insets)
    const widthCardWidth = widthDerivedCardWidth(layout.contentWidth)
    return { layout, widthCardWidth, w: fitCardWidthToHeight(widthCardWidth, layout.availableHeight, BOARD_MODEL) }
  }

  it('leaves a tall phone at its width-derived card (the 96pt cap)', () => {
    const { layout, widthCardWidth, w } = cardWidthIn(402, 874, PORTRAIT_INSETS)
    expect(layout.isWide).toBe(false)
    // (402 - 2*GAME_CONTENT_PADDING - 3*CARD_GAP_MIN) / 4 piles, clamped at CARD_WIDTH_MAX
    const row = 402 - GAME_CONTENT_PADDING * 2 - (NUM_PILES - 1) * CARD_GAP_MIN
    expect(widthCardWidth).toBeCloseTo(Math.min(CARD_WIDTH_MAX, row / NUM_PILES), 6)
    expect(w).toBe(widthCardWidth)
  })

  it.each([
    ['a 640pt Android (3-button nav)', 360, 640, { top: 24, right: 0, bottom: 48, left: 0 }],
    ['an iPhone SE', 375, 667, { top: 20, right: 0, bottom: 0, left: 0 }]
  ])('shrinks the card on %s so a 9-card pile fits at the minimum fan spacing, without scrolling', (_name, width, height, insets) => {
    const { layout, widthCardWidth, w } = cardWidthIn(width, height, insets)
    expect(w).toBeLessThan(widthCardWidth)
    const pileHeight = columnFan(LONG_COLUMN) * w * MIN_FAN_SCALE + H * w
    expect(pileHeight).toBeLessThanOrEqual(tableauMaxHeightFor(layout.availableHeight, w) + 1e-6)
  })
})
