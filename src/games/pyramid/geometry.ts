// Pure geometry for the Pyramid board: the analytic cell layout, the wide-layout card fit, and the
// composition of a cell's SCREEN point under rotation. Kept out of PyramidScreen so it can be tested
// without rendering.

import { CARD_ASPECT } from '@tastic/cards'

import { FACE_UP_OFFSET_RATIO } from '@/components/CardSizeContext'
import { BoardHeightModel, CARD_HEIGHT_RATIO, fitCardWidthToHeight } from '@/components/gameLayout'
import { localOffsetToScreenPoint } from '@/components/overlayFrameMath'
import { clampCardWidthForHeight } from '@/games/shared/clampCardWidthForHeight'

export const ROWS = 7

/** The margins Pyramid's own styles put under its control row and under the triangle. */
export const CONTROL_ROW_MARGIN_BOTTOM = 20
export const TRIANGLE_MARGIN_BOTTOM = 20

/** The triangle's widest row is the base: ROWS cards laid out with no overlap. */
export function triangleWidth(cardWidth: number, gap: number): number {
  return cardWidth * ROWS + gap * (ROWS - 1)
}

export function triangleHeight(cardWidth: number): number {
  const cardHeight = cardWidth / CARD_ASPECT
  return (ROWS - 1) * cardHeight * FACE_UP_OFFSET_RATIO + cardHeight
}

/** A cell's LOCAL top-left inside the triangle container (its own unrotated axes). `gap` is the
 * render-scoped horizontal gap from cardLayoutForRow; rows cascade vertically like a FreeCell
 * cascade, so only the row below (higher zIndex) overlaps the bottom of the row above. */
export function cardPosition(row: number, col: number, cardWidth: number, cardHeight: number, gap: number): { left: number; top: number } {
  const width = triangleWidth(cardWidth, gap)
  const rowWidth = cardWidth * (row + 1) + gap * row
  const rowLeftStart = (width - rowWidth) / 2
  const left = rowLeftStart + col * (cardWidth + gap)
  const top = row * (cardHeight * FACE_UP_OFFSET_RATIO)
  return { left, top }
}

/** The screen-space bounding-box top-left of the card at (row, col), given the triangle container's
 * MEASURED screen bbox top-left. Plain `origin + cardPosition` is only right at 0deg - see
 * localOffsetToScreenPoint. */
export function pyramidCellScreenPoint(triangleOrigin: { x: number; y: number }, row: number, col: number, cardWidth: number, gap: number, rotation: number): { x: number; y: number } {
  const cardHeight = cardWidth / CARD_ASPECT
  const { left, top } = cardPosition(row, col, cardWidth, cardHeight, gap)
  return localOffsetToScreenPoint(triangleOrigin, triangleWidth(cardWidth, gap), triangleHeight(cardWidth), left, top, cardWidth, cardHeight, rotation)
}

/** Pyramid's real board height as `perWidth * cardWidth + fixed`: the control row (one card tall +
 * its margin) stacked on the triangle (ROWS-1 cascade steps + one card + its margin). The wide
 * layout has no other bands (chrome paddings are already in availableHeight). */
export const PYRAMID_BOARD_MODEL: BoardHeightModel = {
  perWidth: CARD_HEIGHT_RATIO * (1 + (ROWS - 1) * FACE_UP_OFFSET_RATIO + 1),
  fixed: CONTROL_ROW_MARGIN_BOTTOM + TRIANGLE_MARGIN_BOTTOM
}

/** Pyramid's final card width. Portrait keeps its original derivation (`portraitAvailableHeight` is
 * useTableauMaxHeight's budget, a second-order approximation of the same question), capped by the real board
 * model: that budget counts 36pt of margins where the board has 40, so where the clamp just binds (near-square
 * portrait windows) the board ran up to 4pt past the screen, and GameChrome's board now scrolls for anything
 * over a point. Wherever the old size fit, the cap is no tighter, so it is unchanged. The wide layout solves the
 * real board model against the layout's available height. */
export function pyramidCardWidth(widthCardWidth: number, isWide: boolean, layoutAvailableHeight: number, portraitAvailableHeight: number): number {
  const fitted = fitCardWidthToHeight(widthCardWidth, layoutAvailableHeight, PYRAMID_BOARD_MODEL)
  if (isWide) return fitted
  return Math.min(clampCardWidthForHeight(widthCardWidth, portraitAvailableHeight, ROWS - 1, FACE_UP_OFFSET_RATIO, CARD_ASPECT), fitted)
}
