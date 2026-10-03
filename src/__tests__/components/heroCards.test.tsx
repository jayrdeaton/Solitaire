import { act, render, screen } from '@testing-library/react-native'
import { AppState, StyleSheet } from 'react-native'
import { cancelAnimation, withRepeat } from 'react-native-reanimated'

import { HeroCards } from '@/components/HeroCards'
import { HERO_FAN_CARDS, HERO_FAN_HEIGHT, HERO_FAN_SPAN } from '@/components/heroFan'

// The real HeroCards over the repo's Reanimated stand-in, with withRepeat counted. What is under test is that the
// fan's forever-running wave is ONE clock: the old fan started a separate repeating sequence per card, and those
// drifted apart frame by frame until the left-to-right ripple was scrambled (see heroFan.ts's heroBumpAt).
jest.mock('react-native-reanimated', () => {
  const stand = jest.requireActual('../../__mocks__/react-native-reanimated')
  return { ...stand, withRepeat: jest.fn(stand.withRepeat) }
})
const mockFocus = { value: true }
jest.mock('expo-router', () => ({ useIsFocused: () => mockFocus.value }))
jest.mock('@/stores/profiles', () => ({ useProfiles: () => ({ activeProfile: null }) }))
jest.mock('@/stores/settings', () => {
  const actual = jest.requireActual('@/stores/settings')
  const value = { settings: { ...actual.DEFAULT_SETTINGS } }
  return { ...actual, useSettings: () => value }
})
jest.mock('@/components/theme', () => {
  const actual = jest.requireActual('@/components/theme')
  return { ...actual, useTableColors: () => actual.lightColors }
})
// The card art is irrelevant here (and heavy).
jest.mock('@tastic/cards', () => {
  const { View: MockView } = require('react-native')
  return { CardBack: () => <MockView testID='hero-card-back' />, DecoratedCardBack: () => <MockView testID='hero-card-back' /> }
})

let appStateHandler: ((state: string) => void) | undefined
const removeAppStateListener = jest.fn()

beforeEach(() => {
  mockFocus.value = true
  jest.mocked(withRepeat).mockClear()
  jest.mocked(cancelAnimation).mockClear()
  removeAppStateListener.mockClear()
  appStateHandler = undefined
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, handler: (s: string) => void) => {
    appStateHandler = handler
    return { remove: removeAppStateListener }
  }) as never)
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('HeroCards', () => {
  it('drives all five cards from one wave clock', async () => {
    await render(<HeroCards />)
    expect(screen.getAllByTestId('hero-card-back')).toHaveLength(HERO_FAN_CARDS.length)
    expect(withRepeat).toHaveBeenCalledTimes(1)
  })

  it('restarts that one clock (not one per card) when the app comes back to the foreground', async () => {
    await render(<HeroCards />)
    await act(async () => appStateHandler?.('background'))
    expect(withRepeat).toHaveBeenCalledTimes(1)
    await act(async () => appStateHandler?.('active'))
    expect(withRepeat).toHaveBeenCalledTimes(2)
  })

  it('stops the clock while Home is covered and starts it once on return', async () => {
    const { rerender } = await render(<HeroCards />)
    mockFocus.value = false
    await rerender(<HeroCards />)
    expect(cancelAnimation).toHaveBeenCalledTimes(1)
    expect(removeAppStateListener).toHaveBeenCalledTimes(1)
    mockFocus.value = true
    await rerender(<HeroCards />)
    expect(withRepeat).toHaveBeenCalledTimes(2)
  })

  it.each([1, 0.8])("lays its row out as the fan's resting box (scale %p)", async (scale) => {
    await render(<HeroCards scale={scale} />)
    // the row is the component's root view
    const row = screen.toJSON() as { props: { style?: unknown } }
    expect(StyleSheet.flatten(row.props.style as never)).toMatchObject({ width: HERO_FAN_SPAN * scale, height: HERO_FAN_HEIGHT * scale })
  })
})
