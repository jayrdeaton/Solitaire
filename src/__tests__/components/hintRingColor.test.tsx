import { getTonalColor, getTriadicPalette } from '@rific/auto-paper'
import { renderHook } from '@testing-library/react-native'

import { previewCardBack, useTableColors } from '@/components/theme'
import { HINT_RING_TONE, THEME_HARMONY } from '@/constants/theme'

// The hint ring (PlayingCard's hintRing, TableColors' hintGreen slot) is the app theme's tertiary, lifted: not the card
// back's own hue, so a ringed card in a stack never blends into the backs beside it, and well away from the felt.

let mockDark = false
let mockOverride: string | null = null
jest.mock('react-native-paper', () => ({ ...jest.requireActual('react-native-paper'), useTheme: () => ({ dark: mockDark }) }))
jest.mock('@/stores/profiles', () => ({ useProfiles: () => ({ tableColorOverride: mockOverride }) }))

function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d === 0) return 0
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}
const hueGap = (a: string, b: string) => {
  const d = Math.abs(hue(a) - hue(b)) % 360
  return Math.min(d, 360 - d)
}

describe('hint ring color', () => {
  const seeds = ['#e91e63', '#ff9800', '#009688', '#2196f3', '#9c27b0', '#4caf50', '#f44336', '#ffeb3b']

  it.each(seeds.flatMap((seed) => [false, true].map((dark) => [seed, dark] as const)))('%s (dark %s): the theme tertiary of the card back, lifted, apart from the back and the felt', async (seed, dark) => {
    mockDark = dark
    mockOverride = seed
    const { result } = await renderHook(() => useTableColors())
    const { cardBack, hintGreen, tableFelt } = result.current
    expect(cardBack).toBe(previewCardBack(seed, dark))
    expect(hintGreen).toBe(getTonalColor(getTriadicPalette(cardBack, THEME_HARMONY).tertiary, HINT_RING_TONE))
    expect(hueGap(hintGreen, cardBack)).toBeGreaterThan(90)
    expect(hueGap(hintGreen, tableFelt)).toBeGreaterThan(40)
  })

  it('follows the profile color', async () => {
    mockDark = false
    mockOverride = '#e91e63'
    const rose = (await renderHook(() => useTableColors())).result.current.hintGreen
    mockOverride = '#ff9800'
    const orange = (await renderHook(() => useTableColors())).result.current.hintGreen
    expect(rose).not.toBe(orange)
  })
})
