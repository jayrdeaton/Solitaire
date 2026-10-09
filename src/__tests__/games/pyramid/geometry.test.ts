import { CARD_ASPECT } from '@tastic/cards'

import { cardLayoutForRow } from '@/components/cardLayout'
import { FACE_UP_OFFSET_RATIO } from '@/components/CardSizeContext'
import { computeGameLayout, GAME_CONTENT_PADDING } from '@/components/gameLayout'
import { cardPosition, PYRAMID_BOARD_MODEL, pyramidCardWidth, pyramidCellScreenPoint, ROWS, triangleHeight, triangleWidth } from '@/games/pyramid/geometry'
import { clampCardWidthForHeight } from '@/games/shared/clampCardWidthForHeight'

const WIN_W = 402
const WIN_H = 874
const CARD_W = 50
const GAP = 6

/** Independent forward model of FakeLandscapeView: the triangle container sits at a known LOCAL
 * position in a rotated frame centred in the window; returns the bbox top-left iOS would report for
 * (a) the container and (b) a card inside it. */
function forward(rotation: number, containerLeft: number, containerTop: number, cardWidth: number) {
  const swapped = Math.abs(rotation) === 90
  const localW = swapped ? WIN_H : WIN_W
  const localH = swapped ? WIN_W : WIN_H
  const rad = (rotation * Math.PI) / 180
  const cw = triangleWidth(cardWidth, GAP)
  const ch = triangleHeight(cardWidth)
  const bbox = (lx: number, ly: number, w: number, h: number) => {
    const relX = lx + w / 2 - localW / 2
    const relY = ly + h / 2 - localH / 2
    const cx = WIN_W / 2 + relX * Math.cos(rad) - relY * Math.sin(rad)
    const cy = WIN_H / 2 + relX * Math.sin(rad) + relY * Math.cos(rad)
    const bw = swapped ? h : w
    const bh = swapped ? w : h
    return { x: cx - bw / 2, y: cy - bh / 2 }
  }
  const cardH = cardWidth / CARD_ASPECT
  return {
    container: bbox(containerLeft, containerTop, cw, ch),
    card: (row: number, col: number) => {
      const { left, top } = cardPosition(row, col, cardWidth, cardH, GAP)
      return bbox(containerLeft + left, containerTop + top, cardWidth, cardH)
    }
  }
}

describe('pyramidCellScreenPoint', () => {
  it.each([0, 90, -90, 180])('matches the rotated-container forward model at %i degrees', (rotation) => {
    const model = forward(rotation, 120, 210, CARD_W)
    for (const [row, col] of [
      [0, 0],
      [3, 2],
      [6, 0],
      [6, 6]
    ]) {
      const got = pyramidCellScreenPoint(model.container, row, col, CARD_W, GAP, rotation)
      const want = model.card(row, col)
      expect(got.x).toBeCloseTo(want.x, 6)
      expect(got.y).toBeCloseTo(want.y, 6)
    }
  })

  it('is exactly measured origin + cardPosition at 0 degrees', () => {
    const origin = { x: 37.5, y: 412.25 }
    const { left, top } = cardPosition(4, 3, CARD_W, CARD_W / CARD_ASPECT, GAP)
    expect(pyramidCellScreenPoint(origin, 4, 3, CARD_W, GAP, 0)).toEqual({ x: origin.x + left, y: origin.y + top })
  })
})

describe('pyramidCardWidth', () => {
  it('portrait is identical to the original formula across window sizes and insets', () => {
    for (const w of [320, 375, 390, 402, 430, 600, 768]) {
      for (const h of [568, 667, 812, 874, 932, 1024]) {
        if (w > h) continue
        for (const insets of [
          { top: 0, right: 0, bottom: 0, left: 0 },
          { top: 47, right: 0, bottom: 34, left: 0 },
          { top: 59, right: 0, bottom: 34, left: 0 }
        ]) {
          const layout = computeGameLayout(w, h, insets)
          const { cardWidth: widthCardWidth } = cardLayoutForRow(layout.contentWidth - GAME_CONTENT_PADDING * 2, ROWS)
          // useTableauMaxHeight(widthCardWidth, 0) in portrait, verbatim.
          const topRow = widthCardWidth / CARD_ASPECT
          const portraitAvailable = Math.max(0, layout.availableHeight - topRow - 16 - 20)
          const oldWidth = clampCardWidthForHeight(widthCardWidth, portraitAvailable, ROWS - 1, FACE_UP_OFFSET_RATIO, CARD_ASPECT)
          expect(pyramidCardWidth(widthCardWidth, layout.isWide, layout.availableHeight, portraitAvailable)).toBe(oldWidth)
        }
      }
    }
  })

  it('wide layout makes the real board (control row + triangle + margins) fit the available height', () => {
    const layout = computeGameLayout(874, 402, { top: 0, right: 0, bottom: 21, left: 59 })
    expect(layout.isWide).toBe(true)
    const { cardWidth: widthCardWidth } = cardLayoutForRow(layout.contentWidth - GAME_CONTENT_PADDING * 2, ROWS)
    const cw = pyramidCardWidth(widthCardWidth, true, layout.availableHeight, 0)
    const cardH = cw / CARD_ASPECT
    const boardHeight = cardH + 20 + triangleHeight(cw) + 20
    expect(boardHeight).toBeCloseTo(PYRAMID_BOARD_MODEL.perWidth * cw + PYRAMID_BOARD_MODEL.fixed, 6)
    expect(boardHeight).toBeLessThanOrEqual(layout.availableHeight + 1e-6)
    if (cw < widthCardWidth) expect(boardHeight).toBeCloseTo(layout.availableHeight, 6)
  })
})
