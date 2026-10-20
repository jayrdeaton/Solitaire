import { FACE_UP_OFFSET_RATIO } from '@/components/CardSizeContext'
import { PREVIEW_CARD_HEIGHT, PREVIEW_CARD_WIDTH, PREVIEW_GAP, PREVIEW_SEED, PreviewCardPlacement } from '@/components/previewCanvas'

import { childIndices, createTriPeaksController, flatIndex, ROW_WIDTHS } from './rules'

// Mirrors TriPeaksScreen.tsx's own buildCardPositions: the base row (widest) is laid out
// edge-adjacent, then each row above is centered on the midpoint of the two cards it actually
// rests on (via rules.ts's own childIndices) - that's what makes the 3-peak shape read correctly
// instead of collapsing into one flat triangle like Pyramid's.
const BASE_WIDTH = ROW_WIDTHS[3]

function buildPositions(): { left: number; top: number }[] {
  const positions: { left: number; top: number }[] = new Array(28)
  for (let col = 0; col < BASE_WIDTH; col++) {
    positions[flatIndex(3, col)] = { left: col * (PREVIEW_CARD_WIDTH + PREVIEW_GAP), top: 3 * PREVIEW_CARD_HEIGHT * FACE_UP_OFFSET_RATIO }
  }
  for (let row = 2; row >= 0; row--) {
    for (let col = 0; col < ROW_WIDTHS[row]; col++) {
      const [a, b] = childIndices(row, col)!
      const center = (positions[a].left + positions[b].left) / 2 + PREVIEW_CARD_WIDTH / 2
      positions[flatIndex(row, col)] = { left: center - PREVIEW_CARD_WIDTH / 2, top: row * PREVIEW_CARD_HEIGHT * FACE_UP_OFFSET_RATIO }
    }
  }
  return positions
}

export function buildTriPeaksPreview(): PreviewCardPlacement[] {
  const state = createTriPeaksController(false).newGame(PREVIEW_SEED)
  const positions = buildPositions()

  const placements: PreviewCardPlacement[] = []
  state.tableau.forEach((card, index) => {
    if (!card) return
    const { left, top } = positions[index]
    placements.push({ x: left, y: top, card, faceUp: card.faceUp })
  })

  return placements
}
