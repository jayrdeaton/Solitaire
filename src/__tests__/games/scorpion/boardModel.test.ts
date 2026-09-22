import { CARD_ASPECT } from '@tastic/cards'

import { CARD_GAP_MIN, cardLayoutForRow } from '@/components/cardLayout'
import { columnBoardModel, computeGameLayout, FACE_DOWN_FAN_RATIO, FACE_UP_FAN_RATIO, fitCardWidthToHeight, fittedGap, GAME_CONTENT_PADDING } from '@/components/gameLayout'
import { Card } from '@/engine/types'
import { BOARD_MODEL, TALLEST_COLUMN } from '@/games/scorpion/boardModel'
import { createScorpionController } from '@/games/scorpion/rules'
import { tableauMaxHeightFor } from '@/games/shared/useTableauMaxHeight'

const TABLEAU_COLUMNS = 7
const H = 1 / CARD_ASPECT

/** A phone held sideways: 874x402 with the notch on the left and the home indicator at the bottom. */
const LANDSCAPE_INSETS = { top: 0, right: 0, bottom: 21, left: 59 }
const PORTRAIT_INSETS = { top: 59, right: 0, bottom: 34, left: 0 }

function columnCounts(col: Card[]): { faceDown: number; faceUp: number } {
  return { faceDown: col.filter((c) => !c.faceUp).length, faceUp: col.filter((c) => c.faceUp).length }
}

/** How tall a column's fan is, in card widths, below its first card - face-down cards fan tighter than
 * face-up ones, so the column with the most cards is not necessarily the tallest. */
function fanHeight(c: { faceDown: number; faceUp: number }): number {
  return c.faceDown * FACE_DOWN_FAN_RATIO + Math.max(0, c.faceUp - 1) * FACE_UP_FAN_RATIO
}

function tallestColumn(tableau: Card[][]): { faceDown: number; faceUp: number } {
  return tableau.map(columnCounts).reduce((best, c) => (fanHeight(c) > fanHeight(best) ? c : best))
}

function widthDerivedCardWidth(contentWidth: number, columns = TABLEAU_COLUMNS): number {
  return cardLayoutForRow(contentWidth - GAME_CONTENT_PADDING * 2, columns).cardWidth
}

describe('scorpion TALLEST_COLUMN', () => {
  it('matches the tallest column of a real classic deal (columns 4-6: 8 face-up)', () => {
    const state = createScorpionController(false).newGame(12345)
    expect(state.tableau).toHaveLength(TABLEAU_COLUMNS)
    expect(tallestColumn(state.tableau)).toEqual(TALLEST_COLUMN)
  })

  it('matches the tallest column the assisted variant reaches once its stock is dealt', () => {
    const controller = createScorpionController(true)
    const state = controller.newGame(12345)
    // Before the stock is dealt the assisted deal is shorter than the model...
    expect(fanHeight(tallestColumn(state.tableau))).toBeLessThan(fanHeight(TALLEST_COLUMN))
    // ...and dealing it brings columns 4-6 to exactly the classic deal's 8.
    const dealt = controller.drawStock!(state)!
    expect(tallestColumn(dealt.tableau)).toEqual(TALLEST_COLUMN)
  })

  it('is taller than the 3 face-down + 4 face-up front columns, which are not the tallest', () => {
    const state = createScorpionController(false).newGame(12345)
    const front = columnCounts(state.tableau[0])
    expect(front).toEqual({ faceDown: 3, faceUp: 4 })
    expect(fanHeight(front)).toBeLessThan(fanHeight(TALLEST_COLUMN))
  })
})

describe('scorpion BOARD_MODEL', () => {
  it('has no top row (the wide layout puts the stock packet beside the tableau) over the default-headroom columns', () => {
    expect(BOARD_MODEL).toEqual(columnBoardModel({ topRowCards: 0, faceDown: 0, faceUp: 8, headroomFaceUp: 3 }))
    // (7 face-up fans + 3 headroom fans + the last card) in card widths, then only the 20pt tableau padding.
    expect(BOARD_MODEL.perWidth).toBeCloseTo(10 * FACE_UP_FAN_RATIO + H)
    expect(BOARD_MODEL.fixed).toBe(20)
  })

  it('agrees with the tableau max height the wide screen passes (topRowCards 0): the deal fits exactly', () => {
    const layout = computeGameLayout(874, 402, LANDSCAPE_INSETS)
    const w = fitCardWidthToHeight(1000, layout.availableHeight, BOARD_MODEL)
    // The tableau's fan budget at that width is the whole board minus its 20pt padding.
    expect(tableauMaxHeightFor(layout.availableHeight, w, 0)).toBeCloseTo(w * BOARD_MODEL.perWidth, 6)
  })
})

describe('tableauMaxHeightFor default top row', () => {
  it('still reserves exactly one card-tall top row + 16 + 20 unless told otherwise (every other caller)', () => {
    expect(tableauMaxHeightFor(500, 50)).toBeCloseTo(500 - 50 * H - 16 - 20, 9)
    expect(tableauMaxHeightFor(500, 50, 1)).toBe(tableauMaxHeightFor(500, 50))
  })
})

describe('scorpion card size in the wide layout', () => {
  const layout = computeGameLayout(874, 402, LANDSCAPE_INSETS)

  it('is a wide layout', () => {
    expect(layout.isWide).toBe(true)
  })

  it('fits the board in the available height and stays playable', () => {
    const w = fitCardWidthToHeight(widthDerivedCardWidth(layout.contentWidth, TABLEAU_COLUMNS + 2), layout.availableHeight, BOARD_MODEL)
    expect(w * BOARD_MODEL.perWidth + BOARD_MODEL.fixed).toBeLessThanOrEqual(layout.availableHeight + 0.001)
    expect(w).toBeGreaterThanOrEqual(40)
    // Was ~45pt while a card-tall top row was budgeted.
    expect(w).toBeGreaterThan(52)
  })

  it('is height-limited here: the fitted card is narrower than the width-derived one', () => {
    const widthCardWidth = widthDerivedCardWidth(layout.contentWidth, TABLEAU_COLUMNS + 2)
    const w = fitCardWidthToHeight(widthCardWidth, layout.availableHeight, BOARD_MODEL)
    expect(w).toBeLessThan(widthCardWidth)
    expect(w * BOARD_MODEL.perWidth + BOARD_MODEL.fixed).toBeCloseTo(layout.availableHeight, 6)
  })

  it('leaves room for the stock packet past column 7 without leaving the content area, tableau still centred', () => {
    const row = layout.contentWidth - GAME_CONTENT_PADDING * 2
    const widthCardWidth = widthDerivedCardWidth(layout.contentWidth, TABLEAU_COLUMNS + 2)
    const w = fitCardWidthToHeight(widthCardWidth, layout.availableHeight, BOARD_MODEL)
    const gap = fittedGap(row, w, TABLEAU_COLUMNS + 2)
    const tableau = w * TABLEAU_COLUMNS + gap * (TABLEAU_COLUMNS - 1)
    // packet's right edge, measured from the row's centre: half the tableau + a gap + a card.
    expect(tableau / 2 + gap + w).toBeLessThanOrEqual(row / 2 + 0.001)
  })

  it('is a no-op when height is not the limit', () => {
    // A tall wide window (an iPad-sized landscape footprint) has height to spare for 96pt cards.
    const tall = computeGameLayout(1194, 834, { top: 0, right: 0, bottom: 20, left: 0 })
    expect(tall.isWide).toBe(true)
    const widthCardWidth = widthDerivedCardWidth(tall.contentWidth, TABLEAU_COLUMNS + 2)
    expect(fitCardWidthToHeight(widthCardWidth, tall.availableHeight, BOARD_MODEL)).toBe(widthCardWidth)
  })
})

describe('scorpion card size in portrait', () => {
  it('is not height-fitted: portrait is not the wide layout, so the width-derived size is used as-is', () => {
    const layout = computeGameLayout(402, 874, PORTRAIT_INSETS)
    expect(layout.isWide).toBe(false)
    // (402 - 2*GAME_CONTENT_PADDING - 6 gaps of CARD_GAP_MIN) / 7 columns
    const row = 402 - GAME_CONTENT_PADDING * 2 - (TABLEAU_COLUMNS - 1) * CARD_GAP_MIN
    expect(widthDerivedCardWidth(layout.contentWidth)).toBeCloseTo(row / TABLEAU_COLUMNS, 6)
  })
})
