import { FACE_UP_OFFSET_RATIO } from '@/components/CardSizeContext'
import { centerVertically, PREVIEW_CANVAS_WIDTH, PREVIEW_CARD_HEIGHT, PREVIEW_CARD_WIDTH, PREVIEW_SEED, PreviewCardPlacement } from '@/components/previewCanvas'

import { flatIndex, PyramidController } from './rules'

// Mirrors PyramidScreen.tsx's own triangleWidth/cardPosition (7-row triangle, base row laid out
// edge-adjacent, each row above centered and cascading down over the row below it) so the
// thumbnail's triangle shape matches the real board's proportions, just at preview scale.
const ROWS = 7
const COL_GAP = 3

function triangleWidth(): number {
  return PREVIEW_CARD_WIDTH * ROWS + COL_GAP * (ROWS - 1)
}

function cardPosition(row: number, col: number): { left: number; top: number } {
  const rowWidth = PREVIEW_CARD_WIDTH * (row + 1) + COL_GAP * row
  const rowLeftStart = (triangleWidth() - rowWidth) / 2
  const left = rowLeftStart + col * (PREVIEW_CARD_WIDTH + COL_GAP)
  const top = row * (PREVIEW_CARD_HEIGHT * FACE_UP_OFFSET_RATIO)
  return { left, top }
}

export function buildPyramidPreview(): PreviewCardPlacement[] {
  const state = PyramidController.newGame(PREVIEW_SEED)
  const offsetX = (PREVIEW_CANVAS_WIDTH - triangleWidth()) / 2

  const placements: PreviewCardPlacement[] = []
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col <= row; col++) {
      const card = state.pyramid[flatIndex(row, col)]
      if (!card) continue
      const { left, top } = cardPosition(row, col)
      placements.push({ x: offsetX + left, y: top, card, faceUp: card.faceUp })
    }
  }

  return centerVertically(placements)
}
