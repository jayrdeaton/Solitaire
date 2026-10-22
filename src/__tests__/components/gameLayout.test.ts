import { CARD_ASPECT } from '@tastic/cards'

import { CARD_GAP_MIN, SPLIT_TOP_ROW_MIN_GAP } from '@/components/cardLayout'
import { MIN_FACE_UP_FAN_SCALE } from '@/components/columnTops'
import { columnBoardModel, columnFan, computeGameLayout, FACE_DOWN_FAN_RATIO, FACE_UP_FAN_RATIO, fitCardWidthToHeight, fittedGap, GAME_CONTENT_BOTTOM_PADDING, GAME_CONTENT_MAX_WIDTH, GAME_CONTENT_TOP_PADDING, LONG_COLUMN_MIN_CARD_WIDTH, MIN_CARD_WIDTH } from '@/components/gameLayout'

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 }

describe('computeGameLayout', () => {
  it('leaves portrait exactly as it was: full width, portrait chrome bands, no side gutters', () => {
    const layout = computeGameLayout(402, 874, { top: 59, right: 0, bottom: 34, left: 0 })
    expect(layout.isWide).toBe(false)
    expect(layout.leftGutter).toBe(0)
    expect(layout.rightGutter).toBe(0)
    expect(layout.contentWidth).toBe(402)
    expect(layout.topPadding).toBe(GAME_CONTENT_TOP_PADDING)
    expect(layout.bottomPadding).toBe(GAME_CONTENT_BOTTOM_PADDING)
    expect(layout.availableHeight).toBe(874 - 59 - 34 - GAME_CONTENT_TOP_PADDING - GAME_CONTENT_BOTTOM_PADDING)
  })

  it('caps portrait content width at GAME_CONTENT_MAX_WIDTH like computeContentBounds did', () => {
    expect(computeGameLayout(1300, 1400, NO_INSETS).contentWidth).toBe(GAME_CONTENT_MAX_WIDTH)
  })

  it('goes wide for a landscape footprint: side gutters replace the vertical chrome bands', () => {
    const layout = computeGameLayout(874, 402, { top: 0, right: 0, bottom: 21, left: 59 })
    expect(layout.isWide).toBe(true)
    // each gutter = its own chrome column + ITS OWN inset (the readout leads on the left, the footer
    // controls trail on the right)
    expect(layout.leftGutter).toBe(64 + 59)
    expect(layout.rightGutter).toBe(56 + 0)
    expect(layout.contentWidth).toBe(874 - (64 + 59) - 56)
    expect(layout.topPadding).toBe(8)
    expect(layout.bottomPadding).toBe(8)
    expect(layout.availableHeight).toBe(402 - 21 - 16)
  })

  it("hugs each side's own inset instead of both using the larger one (a phone held sideways)", () => {
    // +90: the island is on the leading side (62), the home indicator on the trailing one (34)
    const plus90 = computeGameLayout(874, 402, { top: 0, right: 34, bottom: 0, left: 62 })
    expect(plus90.leftGutter).toBe(64 + 62)
    expect(plus90.rightGutter).toBe(56 + 34)
    // -90: the sides swap - a chrome column on the SMALL-inset side must not carry the island side's
    // extra width (the dead space this used to leave between the buttons and the board)
    const minus90 = computeGameLayout(874, 402, { top: 0, right: 62, bottom: 0, left: 34 })
    expect(minus90.leftGutter).toBe(64 + 34)
    expect(minus90.rightGutter).toBe(56 + 62)
    expect(minus90.contentWidth).toBe(874 - (64 + 34) - (56 + 62))
  })
})

describe('columnBoardModel / fitCardWidthToHeight', () => {
  const H = 1 / CARD_ASPECT

  it('models a top row plus a fanned column, linear in card width', () => {
    // 6 face-down + 1 face-up (Klondike's tallest column), no headroom.
    const model = columnBoardModel({ faceDown: 6, faceUp: 1, headroomFaceUp: 0 })
    expect(model.perWidth).toBeCloseTo(H + (6 * FACE_DOWN_FAN_RATIO + H))
    expect(model.fixed).toBe(16 + 20)
  })

  it('budgets headroom in face-up fans', () => {
    const none = columnBoardModel({ faceDown: 0, faceUp: 7, headroomFaceUp: 0 })
    const three = columnBoardModel({ faceDown: 0, faceUp: 7, headroomFaceUp: 3 })
    expect(three.perWidth - none.perWidth).toBeCloseTo(3 * FACE_UP_FAN_RATIO)
  })

  it('has no top-row cost when there is no top row', () => {
    const model = columnBoardModel({ topRowCards: 0, faceDown: 0, faceUp: 1, headroomFaceUp: 0 })
    expect(model.perWidth).toBeCloseTo(H)
    expect(model.fixed).toBe(20)
  })

  it('returns a card width whose board exactly fills the available height when height is the limit', () => {
    const model = columnBoardModel({ faceDown: 6, faceUp: 1 })
    const available = 386
    const w = fitCardWidthToHeight(500, available, model)
    expect(w * model.perWidth + model.fixed).toBeCloseTo(available, 6)
  })

  it('never exceeds the width-derived card width', () => {
    expect(fitCardWidthToHeight(40, 5000, columnBoardModel({ faceDown: 6, faceUp: 1 }))).toBe(40)
  })

  it('never shrinks below the minimum', () => {
    expect(fitCardWidthToHeight(96, 30, columnBoardModel({ faceDown: 6, faceUp: 1 }))).toBe(MIN_CARD_WIDTH)
  })
})

describe('columnBoardModel longColumn', () => {
  const H = 1 / CARD_ASPECT
  const deal = { faceDown: 6, faceUp: 1 }
  const longColumn = { faceDown: 0, faceUp: 12 }

  it('models the board with the long column fanned at the minimum spacing in place of the deal, and leaves the deal model as it was', () => {
    const model = columnBoardModel({ ...deal, longColumn })
    expect(model.perWidth).toBe(columnBoardModel(deal).perWidth)
    expect(model.fixed).toBe(columnBoardModel(deal).fixed)
    expect(model.long?.perWidth).toBeCloseTo(H + columnFan(longColumn) * MIN_FACE_UP_FAN_SCALE + H, 9)
    expect(model.long?.minCardWidth).toBe(LONG_COLUMN_MIN_CARD_WIDTH)
    expect(columnFan(longColumn)).toBeCloseTo(11 * FACE_UP_FAN_RATIO, 9)
  })

  it('has no long model when the deal and its headroom already need more room than the long column at the minimum', () => {
    expect(columnBoardModel({ faceDown: 0, faceUp: 4, headroomFaceUp: 5, longColumn: { faceDown: 0, faceUp: 9 } }).long).toBeUndefined()
  })

  it('sizes the cards so the long column fills the height at the minimum spacing, where that leaves them above the floor', () => {
    const model = columnBoardModel({ ...deal, longColumn })
    const available = 500
    const w = fitCardWidthToHeight(500, available, model)
    expect(w).toBeGreaterThan(LONG_COLUMN_MIN_CARD_WIDTH)
    expect(w * model.long!.perWidth + model.fixed).toBeCloseTo(available, 6)
  })

  it('shrinks the cards for the long column only down to LONG_COLUMN_MIN_CARD_WIDTH (a longer column then scrolls)', () => {
    const model = columnBoardModel({ ...deal, longColumn: { faceDown: 0, faceUp: 40 } })
    expect(fitCardWidthToHeight(96, 386, model)).toBe(LONG_COLUMN_MIN_CARD_WIDTH)
  })

  it('still shrinks below that floor for the deal itself, on a window too short for even the deal at the floor', () => {
    const model = columnBoardModel({ ...deal, longColumn })
    const available = 200
    const w = fitCardWidthToHeight(96, available, model)
    expect(w).toBeLessThan(LONG_COLUMN_MIN_CARD_WIDTH)
    expect(w * model.perWidth + model.fixed).toBeCloseTo(available, 6)
  })
})

describe('fittedGap', () => {
  it('spreads the leftover width across the gaps', () => {
    // 628 wide row, 7 columns of 60: (628 - 420) / 6 = 34.67 -> capped at CARD_GAP_MAX (24)
    expect(fittedGap(628, 60, 7)).toBe(24)
    // 500 wide row, 7 columns of 60: (500 - 420) / 6 = 13.33
    expect(fittedGap(500, 60, 7)).toBeCloseTo(80 / 6)
  })

  it('never goes below the minimum gap, even for a row that is already too wide', () => {
    expect(fittedGap(400, 60, 7)).toBe(CARD_GAP_MIN)
  })

  it('is the minimum gap for a single column', () => {
    expect(fittedGap(628, 60, 1)).toBe(CARD_GAP_MIN)
  })

  it('floors at the minGap the row was sized with (a split top row)', () => {
    expect(fittedGap(400, 60, 7, SPLIT_TOP_ROW_MIN_GAP)).toBe(SPLIT_TOP_ROW_MIN_GAP)
    expect(fittedGap(628, 60, 1, SPLIT_TOP_ROW_MIN_GAP)).toBe(SPLIT_TOP_ROW_MIN_GAP)
    expect(fittedGap(500, 60, 7, SPLIT_TOP_ROW_MIN_GAP)).toBeCloseTo(80 / 6)
  })
})
