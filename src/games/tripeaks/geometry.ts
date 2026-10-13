// TriPeaks' pure board geometry: where each of the 28 cells sits inside the peaks container, how tall
// the whole board is, and how the card width is chosen from the available height. Kept out of the
// screen so the rotation-sensitive composition (container-local offset -> screen point) and the
// portrait-vs-wide sizing can be unit-tested without rendering anything.

import { CARD_ASPECT } from '@tastic/cards'

import { FACE_UP_OFFSET_RATIO } from '@/components/CardSizeContext'
import { BoardHeightModel, CARD_HEIGHT_RATIO, fitCardWidthToHeight } from '@/components/gameLayout'
import { localOffsetToScreenPoint } from '@/components/overlayFrameMath'
import { clampCardWidthForHeight } from '@/games/shared/clampCardWidthForHeight'

import { childIndices, flatIndex, ROW_WIDTHS } from './rules'

// The base row (rules.ts's ROW_WIDTHS[3]) is the board's widest row and sets its overall width
// unit - same idea as Pyramid's own TRIANGLE_WIDTH_UNITS = ROWS.
export const BASE_WIDTH = ROW_WIDTHS[3]

/** Gap between the stock/waste row and the peaks below it (the control row's own marginBottom). */
export const CONTROL_ROW_MARGIN_BOTTOM = 20

export function boardWidth(cardWidth: number, gap: number): number {
  return cardWidth * BASE_WIDTH + gap * (BASE_WIDTH - 1)
}

export function boardHeight(cardHeight: number): number {
  // 3 = the deepest row index (rows 0-3) - same cascading-rows idea as Pyramid's own triangle height.
  return 3 * cardHeight * FACE_UP_OFFSET_RATIO + cardHeight
}

/**
 * One {left, top} position per flat tableau index (see rules.ts's flatIndex/rowColOf), relative to
 * the board container's own top-left corner. Computed bottom-up:
 *   - Row 3 (the base, 10 cards): fixed, non-overlapping slots spanning the full board width - same
 *     idea as Pyramid's own bottom row.
 *   - Rows 2, 1, 0: each card's horizontal center is the exact midpoint between its own two
 *     childIndices cards' centers (already computed one row down) - reusing rules.ts's childIndices
 *     directly (not a second, independently-derived copy of the same peak adjacency) guarantees
 *     every card visually sits centered on the two cards it actually rests on, which is what makes
 *     the 3-peak shape read correctly instead of collapsing into one flat triangle.
 * Vertical offset cascades the same way Pyramid's own cardPosition does (row * cardHeight *
 * FACE_UP_OFFSET_RATIO), so each row peeks out from under the row above it.
 */
export function buildCardPositions(cardWidth: number, cardHeight: number, gap: number): { left: number; top: number }[] {
  const positions: { left: number; top: number }[] = new Array(28)
  for (let col = 0; col < ROW_WIDTHS[3]; col++) {
    positions[flatIndex(3, col)] = { left: col * (cardWidth + gap), top: 3 * cardHeight * FACE_UP_OFFSET_RATIO }
  }
  for (let row = 2; row >= 0; row--) {
    for (let col = 0; col < ROW_WIDTHS[row]; col++) {
      const [a, b] = childIndices(row, col)!
      const center = (positions[a].left + positions[b].left) / 2 + cardWidth / 2
      positions[flatIndex(row, col)] = { left: center - cardWidth / 2, top: row * cardHeight * FACE_UP_OFFSET_RATIO }
    }
  }
  return positions
}

/**
 * The screen-space bounding-box top-left of the card at (`left`, `top`) inside the peaks container -
 * what a deal ghost is handed as its landing point. `containerOrigin` is the container's MEASURED
 * (measureInWindow) top-left, which under a +/-90/180 rotation is the top-left of its rotated
 * footprint, so a plain `origin + offset` is only right at 0deg - see localOffsetToScreenPoint.
 * `containerWidth`/`containerHeight` are the container's own unrotated size (what it renders with).
 */
export function peaksCardScreenPoint(containerOrigin: { x: number; y: number }, containerWidth: number, containerHeight: number, left: number, top: number, cardWidth: number, rotation: number): { x: number; y: number } {
  // Bit-exact at 0deg (the going-through-the-centre route can differ by an ulp), so portrait deals land
  // on exactly the numbers they always did.
  if (rotation === 0) return { x: containerOrigin.x + left, y: containerOrigin.y + top }
  return localOffsetToScreenPoint(containerOrigin, containerWidth, containerHeight, left, top, cardWidth, cardWidth / CARD_ASPECT, rotation)
}

/**
 * TriPeaks' real board height as an affine function of card width: the stock/waste row (one card
 * tall) above the peaks, CONTROL_ROW_MARGIN_BOTTOM between them, then the peaks (boardHeight above =
 * 3 * cardHeight * FACE_UP_OFFSET_RATIO + cardHeight). Unlike the column games there is no tableau
 * paddingBottom. Used by the wide layout only (see tripeaksCardWidth).
 */
export const TRIPEAKS_BOARD_MODEL: BoardHeightModel = {
  perWidth: CARD_HEIGHT_RATIO * (1 + 3 * FACE_UP_OFFSET_RATIO + 1),
  fixed: CONTROL_ROW_MARGIN_BOTTOM
}

/**
 * The card width TriPeaks renders with.
 *  - Portrait keeps the original two-axis clamp exactly as it was: `tableauMaxHeight` is
 *    useTableauMaxHeight(widthCardWidth) (the column-game budget, which subtracts a top row plus
 *    the tableau's own paddings) fed through clampCardWidthForHeight - untouched, so portrait numbers
 *    are unchanged.
 *  - The wide layout fits the REAL board (TRIPEAKS_BOARD_MODEL) to the layout's available height.
 */
export function tripeaksCardWidth(widthCardWidth: number, isWide: boolean, layoutAvailableHeight: number, tableauMaxHeight: number): number {
  if (isWide) return fitCardWidthToHeight(widthCardWidth, layoutAvailableHeight, TRIPEAKS_BOARD_MODEL)
  return clampCardWidthForHeight(widthCardWidth, tableauMaxHeight, 3, FACE_UP_OFFSET_RATIO, CARD_ASPECT)
}
