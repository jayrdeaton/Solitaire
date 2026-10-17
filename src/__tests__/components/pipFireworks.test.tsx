import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { darkColors, lightColors } from '@/components/palettes'
import { PipFireworks } from '@/components/winning/PipFireworks'

// The win's pip bursts draw each pip the way the player's own cards draw it (Jay, 2026-10-17): the card's ink, ringed in the card's face color.
// So the black suits are black with a white ring, turn light with a dark ring under Invert Dark Mode Colors in dark mode, and the tarot deck
// throws its own suits in its own inks.

let mockDark = false
let mockSettings: { cardStyle: string; invertDarkModeColors: boolean } = { cardStyle: 'compact', invertDarkModeColors: false }
jest.mock('react-native-paper', () => ({ ...jest.requireActual('react-native-paper'), useTheme: () => ({ dark: mockDark }) }))
jest.mock('@/stores/profiles', () => ({ useProfiles: () => ({ tableColorOverride: null }) }))
jest.mock('@/hooks/useSettings', () => {
  const actual = jest.requireActual('@/redux/settingsSlice')
  return { useSettings: () => ({ settings: { ...actual.DEFAULT_SETTINGS, ...mockSettings } }) }
})
jest.mock('@tastic/cards', () => {
  const { View: MockView } = require('react-native')
  return { ...jest.requireActual('@tastic/cards'), SuitPip: (props: Record<string, unknown>) => <MockView testID='pip' {...props} /> }
})

type Drawn = { color: string; outline: { color: string; width: number }; theme: string }

/** Lets the show run until it has thrown every suit, and returns how each suit's pips were drawn. */
async function drawnBySuit(): Promise<Record<string, Drawn>> {
  await render(<PipFireworks />)
  await fireEvent(screen.getByTestId('pip-fireworks'), 'layout', { nativeEvent: { layout: { width: 400, height: 800 } } })
  const seen: Record<string, Drawn> = {}
  for (let i = 0; i < 20 && Object.keys(seen).length < 4; i++) {
    for (const pip of screen.queryAllByTestId('pip')) {
      const { suit, color, outline, theme } = pip.props as Drawn & { suit: string }
      seen[suit] = { color, outline, theme }
    }
    await act(async () => {
      jest.advanceTimersByTime(200)
    })
  }
  return seen
}

describe('PipFireworks', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockDark = false
    mockSettings = { cardStyle: 'compact', invertDarkModeColors: false }
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('throws one suit per burst, every suit in turn', async () => {
    expect(Object.keys(await drawnBySuit()).sort()).toEqual(['clubs', 'diamonds', 'hearts', 'spades'])
  })

  it('draws black suits black and red suits red, each ringed in white like a card face', async () => {
    const drawn = await drawnBySuit()
    expect(drawn.spades.color).toBe(lightColors.textBlack)
    expect(drawn.clubs.color).toBe(lightColors.textBlack)
    expect(drawn.hearts.color).toBe(lightColors.textRed)
    expect(drawn.diamonds.color).toBe(lightColors.textRed)
    Object.values(drawn).forEach((d) => {
      expect(d.outline.color).toBe('#FFFFFF')
      expect(d.outline.width).toBeGreaterThan(0)
      expect(d.theme).toBe('standard')
    })
  })

  it('turns the black suits light with a dark ring under Invert Dark Mode Colors in dark mode', async () => {
    mockDark = true
    mockSettings = { cardStyle: 'compact', invertDarkModeColors: true }
    const drawn = await drawnBySuit()
    expect(drawn.spades.color).toBe(darkColors.textBlackInverted)
    expect(drawn.hearts.color).toBe(darkColors.textRed)
    Object.values(drawn).forEach((d) => expect(d.outline.color).toBe(darkColors.cardFaceInverted))
  })

  it('ignores Invert Dark Mode Colors in light mode, as the cards do', async () => {
    mockSettings = { cardStyle: 'compact', invertDarkModeColors: true }
    const drawn = await drawnBySuit()
    expect(drawn.spades.color).toBe(lightColors.textBlack)
    Object.values(drawn).forEach((d) => expect(d.outline.color).toBe('#FFFFFF'))
  })

  it('throws the tarot suits in their own inks with the tarot deck', async () => {
    mockSettings = { cardStyle: 'tarot', invertDarkModeColors: false }
    const drawn = await drawnBySuit()
    Object.values(drawn).forEach((d) => expect(d.theme).toBe('tarot'))
    const inks = new Set(Object.values(drawn).map((d) => d.color))
    expect(inks.size).toBe(4)
    expect(inks).not.toContain(lightColors.textBlack)
    expect(inks).not.toContain(lightColors.textRed)
  })

  it('throws the standard suits with every other card style', async () => {
    for (const cardStyle of ['decorated', 'numeric']) {
      mockSettings = { cardStyle, invertDarkModeColors: false }
      const drawn = await drawnBySuit()
      Object.values(drawn).forEach((d) => expect(d.theme).toBe('standard'))
      await screen.unmount()
    }
  })
})
