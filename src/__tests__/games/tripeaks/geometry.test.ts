import { CARD_ASPECT } from '@tastic/cards'

import { FACE_UP_OFFSET_RATIO } from '@/components/CardSizeContext'
import { computeGameLayout, fitCardWidthToHeight } from '@/components/gameLayout'
import { clampCardWidthForHeight } from '@/games/shared/clampCardWidthForHeight'
import { boardHeight, boardWidth, buildCardPositions, CONTROL_ROW_MARGIN_BOTTOM, peaksCardScreenPoint, TRIPEAKS_BOARD_MODEL, tripeaksCardWidth } from '@/games/tripeaks/geometry'

const CARD_W = 60
const CARD_H = CARD_W / CARD_ASPECT
const GAP = 6
const BOARD_W = boardWidth(CARD_W, GAP)
const BOARD_H = boardHeight(CARD_H)

// Independent forward model: a container of local size BOARD_W x BOARD_H whose centre sits at
// (cx, cy) on screen, rotated `rotation` degrees clockwise about that centre. Maps a card's local
// top-left to the top-left of its screen bounding box, and gives the container's own bbox top-left
// (what measureInWindow reports for it).
function model(rotation: number, cx: number, cy: number) {
  const swapped = Math.abs(rotation) === 90
  const rad = (rotation * Math.PI) / 180
  const bboxW = swapped ? BOARD_H : BOARD_W
  const bboxH = swapped ? BOARD_W : BOARD_H
  return {
    measured: { x: cx - bboxW / 2, y: cy - bboxH / 2 },
    cardBBoxTopLeft(left: number, top: number) {
      const relX = left + CARD_W / 2 - BOARD_W / 2
      const relY = top + CARD_H / 2 - BOARD_H / 2
      const sx = cx + relX * Math.cos(rad) - relY * Math.sin(rad)
      const sy = cy + relX * Math.sin(rad) + relY * Math.cos(rad)
      return { x: sx - (swapped ? CARD_H : CARD_W) / 2, y: sy - (swapped ? CARD_W : CARD_H) / 2 }
    }
  }
}

describe('peaksCardScreenPoint', () => {
  const positions = buildCardPositions(CARD_W, CARD_H, GAP)

  it.each([0, 90, -90, 180])('matches the rotated-container forward model for all 28 cells at %i degrees', (rotation) => {
    const m = model(rotation, 210, 433)
    positions.forEach(({ left, top }) => {
      const got = peaksCardScreenPoint(m.measured, BOARD_W, BOARD_H, left, top, CARD_W, rotation)
      const want = m.cardBBoxTopLeft(left, top)
      expect(got.x).toBeCloseTo(want.x, 6)
      expect(got.y).toBeCloseTo(want.y, 6)
    })
  })

  it('is exactly measured origin + local offset at 0 degrees', () => {
    positions.forEach(({ left, top }) => {
      expect(peaksCardScreenPoint({ x: 13.5, y: 201.25 }, BOARD_W, BOARD_H, left, top, CARD_W, 0)).toEqual({ x: 13.5 + left, y: 201.25 + top })
    })
  })
})

describe('tripeaksCardWidth', () => {
  it('is the original clamp, unchanged, in portrait', () => {
    for (const [w, h, top, bottom] of [
      [402, 874, 59, 34],
      [375, 667, 20, 0],
      [430, 932, 59, 34],
      [320, 568, 20, 0],
      [768, 1024, 24, 20]
    ]) {
      const layout = computeGameLayout(w, h, { top, right: 0, bottom, left: 0 })
      expect(layout.isWide).toBe(false)
      const widthCardWidth = Math.min(96, (layout.contentWidth - 12) / 10)
      // The old TriPeaksScreen computation, inlined: useTableauMaxHeight(widthCardWidth) then clamp.
      const oldAvailable = Math.max(0, layout.availableHeight - widthCardWidth / CARD_ASPECT - 16 - 20)
      const old = clampCardWidthForHeight(widthCardWidth, oldAvailable, 3, FACE_UP_OFFSET_RATIO, CARD_ASPECT)
      expect(tripeaksCardWidth(widthCardWidth, layout.isWide, layout.availableHeight, oldAvailable)).toBe(old)
    }
  })

  it('fits the real board (stock row + peaks) into the wide layout height', () => {
    const layout = computeGameLayout(874, 402, { top: 0, right: 0, bottom: 21, left: 59 })
    expect(layout.isWide).toBe(true)
    const cw = tripeaksCardWidth(96, true, layout.availableHeight, 0)
    const ch = cw / CARD_ASPECT
    const total = ch + CONTROL_ROW_MARGIN_BOTTOM + boardHeight(ch)
    expect(total).toBeCloseTo(layout.availableHeight, 6)
    expect(cw).toBe(fitCardWidthToHeight(96, layout.availableHeight, TRIPEAKS_BOARD_MODEL))
  })

  it('never exceeds the width-derived card width', () => {
    const layout = computeGameLayout(1200, 2000, { top: 0, right: 0, bottom: 0, left: 0 })
    expect(tripeaksCardWidth(40, true, 5000, 0)).toBe(40)
    expect(layout.isWide).toBe(false)
  })
})
