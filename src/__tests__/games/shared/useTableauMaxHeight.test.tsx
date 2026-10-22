import { CARD_ASPECT } from '@tastic/cards'
import { renderHook } from '@testing-library/react-native'

import { tableauMaxHeightFor, useTableauMaxHeight } from '@/games/shared/useTableauMaxHeight'

// Every column gets exactly the height left on screen, in both layouts: no per-game floor. The floors this hook used to
// take (300-460pt in portrait) made every column box taller than an iPhone SE or a 640pt Android, so the board scrolled
// there from the first deal, with every column short. A column that needs more than its share compresses (down to
// its tightest (columnTops' MIN_FACE_UP_FAN_SCALE)) and only then runs past the bottom.

const mockLayout = { isWide: false, availableHeight: 360 }
jest.mock('@/components/gameLayout', () => ({
  ...jest.requireActual('@/components/gameLayout'),
  useGameLayout: () => mockLayout
}))

describe('useTableauMaxHeight', () => {
  it.each([false, true])('has no floor (wide layout: %s): a short window gets exactly what fits', async (isWide) => {
    Object.assign(mockLayout, { isWide, availableHeight: 360 })
    const { result } = await renderHook(() => useTableauMaxHeight(50))
    expect(result.current).toBe(tableauMaxHeightFor(360, 50, 1))
    expect(result.current).toBeLessThan(300) // below every one of the old portrait floors
  })

  it('never goes negative on a window too short for even the top row', async () => {
    Object.assign(mockLayout, { isWide: false, availableHeight: 40 })
    const { result } = await renderHook(() => useTableauMaxHeight(50))
    expect(result.current).toBe(0)
  })

  it("budgets no top row when there is none (Scorpion's wide layout)", async () => {
    Object.assign(mockLayout, { isWide: true, availableHeight: 360 })
    const { result } = await renderHook(() => useTableauMaxHeight(50, { topRowCards: 0 }))
    expect(result.current).toBe(tableauMaxHeightFor(360, 50, 0))
  })

  it('reserves one card-tall top row plus its 16pt margin and the 20pt tableau padding by default, and no row for topRowCards 0', () => {
    expect(tableauMaxHeightFor(500, 50)).toBeCloseTo(500 - 50 / CARD_ASPECT - 16 - 20, 9)
    expect(tableauMaxHeightFor(500, 50, 1)).toBe(tableauMaxHeightFor(500, 50))
    expect(tableauMaxHeightFor(500, 50, 0)).toBeCloseTo(500 - 20, 9)
  })
})
