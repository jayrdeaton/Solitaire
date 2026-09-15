import { CARD_ASPECT } from '@tastic/cards'

import { FACE_UP_OFFSET_RATIO } from '@/components/CardSizeContext'
import { clampCardWidthForHeight } from '@/games/shared/clampCardWidthForHeight'

describe('clampCardWidthForHeight', () => {
  it('leaves the width-derived card width unchanged when height is generous (width is the binding constraint)', () => {
    // deepestRowIndex=1, faceUpOffsetRatio=1, cardAspect=1 -> heightDerivedCardWidth = availableHeight / 2.
    // availableHeight=1000 -> heightDerivedCardWidth=500, comfortably above the 80 width-derived value.
    expect(clampCardWidthForHeight(80, 1000, 1, 1, 1)).toBe(80)
  })

  it('clamps down to the height-derived width once it undercuts the width-derived one', () => {
    // Same simple constants (deepestRowIndex=1, faceUpOffsetRatio=1, cardAspect=1) -> divisor 2.
    // availableHeight=60 -> heightDerivedCardWidth=30, below the 80 width-derived value.
    expect(clampCardWidthForHeight(80, 60, 1, 1, 1)).toBe(30)
  })

  it('never returns less than 28, even when available height is near zero', () => {
    expect(clampCardWidthForHeight(80, 1, 1, 1, 1)).toBe(28)
    expect(clampCardWidthForHeight(80, 0, 1, 1, 1)).toBe(28)
  })

  it('a taller board (larger deepestRowIndex) gets a smaller height-derived cap for the same available height', () => {
    const shallow = clampCardWidthForHeight(200, 300, 2, 1, 1)
    const deep = clampCardWidthForHeight(200, 300, 6, 1, 1)
    expect(deep).toBeLessThan(shallow)
  })

  it('matches Pyramid/TriPeaks real constants: the resulting card height never exceeds availableHeight', () => {
    // Pyramid's own deepestRowIndex (ROWS-1=6) and TriPeaks' (3), against the app's real
    // FACE_UP_OFFSET_RATIO/CARD_ASPECT - confirms the formula's actual wiring, not just its shape in
    // isolation. widthCardWidth deliberately generous (200) so the height cap is what actually binds.
    for (const deepestRowIndex of [6, 3]) {
      const availableHeight = 350
      const cardWidth = clampCardWidthForHeight(200, availableHeight, deepestRowIndex, FACE_UP_OFFSET_RATIO, CARD_ASPECT)
      const cardHeight = cardWidth / CARD_ASPECT
      const boardHeight = deepestRowIndex * cardHeight * FACE_UP_OFFSET_RATIO + cardHeight
      expect(boardHeight).toBeLessThanOrEqual(availableHeight + 1e-9) // floating-point slack
    }
  })
})
