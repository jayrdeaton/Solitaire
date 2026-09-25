import { render, screen } from '@testing-library/react-native'

import Home from '@/app/index'

// Home's half of the how-to-play guide: it asks @tastic/hud/guide to auto-show the cards, and holds
// that back whenever it is about to <Redirect> into a saved game, so the guide can never open over a
// live deal (whose clock would keep running under it). The menu itself is covered by homeScreen.test.tsx;
// here the rotated frame renders a stand-in, so only Home's own decision is under test.

let mockResume: string | null = null
const mockUseAutoShowGuide = jest.fn((_enabled?: boolean) => {})

jest.mock('@tastic/hud/guide', () => ({ ...jest.requireActual('@tastic/hud/guide'), useAutoShowGuide: (enabled?: boolean) => mockUseAutoShowGuide(enabled) }))
jest.mock('@/stores/lastActiveGame', () => ({ useLastActiveGame: () => ({ consumeResumeGame: () => mockResume }) }))
jest.mock('@/components/useFontsPreload', () => ({ CARD_FONT_FAMILY: 'TestSerif' }))
jest.mock('expo-router', () => {
  const { Text } = require('react-native')
  return {
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), dismissTo: jest.fn() }),
    useIsFocused: () => true,
    Link: ({ children }: { children: unknown }) => children,
    Redirect: ({ href }: { href: string }) => <Text testID='redirect'>{href}</Text>
  }
})
jest.mock('@/components/RotatedScreen', () => {
  const { View } = require('react-native')
  return { RotatedScreen: () => <View testID='home-menu' /> }
})

beforeEach(() => {
  mockResume = null
  mockUseAutoShowGuide.mockClear()
})

describe('Home: the how-to-play auto-show', () => {
  it('asks for the guide on a plain Home launch', async () => {
    await render(<Home />)

    expect(screen.getByTestId('home-menu')).toBeTruthy()
    expect(mockUseAutoShowGuide).toHaveBeenCalled()
    expect(mockUseAutoShowGuide.mock.calls.every(([enabled]) => enabled === true)).toBe(true)
  })

  it('holds the guide back on every render while redirecting into a saved game', async () => {
    mockResume = 'klondike'
    await render(<Home />)

    expect(screen.getByTestId('redirect').props.children).toBe('/klondike')
    expect(screen.queryByTestId('home-menu')).toBeNull()
    // Still called (hooks run unconditionally, before the early return), but never enabled.
    expect(mockUseAutoShowGuide).toHaveBeenCalled()
    expect(mockUseAutoShowGuide.mock.calls.every(([enabled]) => enabled === false)).toBe(true)
  })
})
