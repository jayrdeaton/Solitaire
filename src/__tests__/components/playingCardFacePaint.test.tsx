import { CardSizeProvider } from '@tastic/cards'
import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { FaceLoadTrackingContext, isAnyFaceLoading } from '@/components/cardFacePaint'
import { PlayingCard } from '@/components/PlayingCard'
import type { Card } from '@/engine/types'

// A card face is one <Image> whose bitmap React Native delivers a frame or two after the view appears (cardFacePaint.ts).
// The face reports itself as loading until its onLoad, and a card turned face-up in place keeps its back drawn over the
// new face until then. "Loaded" here is firing the face Image's load event.

jest.mock('@/stores/profiles', () => ({ useProfiles: () => ({ activeProfile: null, tableColorOverride: undefined }) }))
jest.mock('@/hooks/useSettings', () => {
  const actual = jest.requireActual('@/redux/settingsSlice')
  const value = { settings: { ...actual.DEFAULT_SETTINGS } }
  return { useSettings: () => value }
})
jest.mock('@tastic/cards', () => {
  const { View } = require('react-native')
  const actual = jest.requireActual('@tastic/cards')
  return { ...actual, CardFace: () => <View />, CardBack: () => <View testID='card-back' />, DecoratedCardBack: () => <View testID='card-back' /> }
})

const NINE = (faceUp: boolean, deck = 0): Card => ({ id: `spades-9-${deck}`, suit: 'spades', rank: 9, faceUp }) as Card

function playing(card: Card, tracking = true) {
  return (
    <CardSizeProvider width={64}>
      <FaceLoadTrackingContext.Provider value={tracking}>
        <PlayingCard card={card} />
      </FaceLoadTrackingContext.Provider>
    </CardSizeProvider>
  )
}
const face = () => screen.getByLabelText('9 of spades')
const loadFace = async () => {
  await act(async () => {
    fireEvent(face(), 'load', { nativeEvent: {} })
  })
}

describe('PlayingCard face paint', () => {
  it('reports its face as loading from the commit it mounts until its onLoad', async () => {
    const r = await render(playing(NINE(true)))
    expect(isAnyFaceLoading(['spades-9-0'])).toBe(true)
    await loadFace()
    expect(isAnyFaceLoading(['spades-9-0'])).toBe(false)
    await r.unmount()
  })

  it('stops reporting when it unmounts before loading', async () => {
    const r = await render(playing(NINE(true)))
    await r.unmount()
    expect(isAnyFaceLoading(['spades-9-0'])).toBe(false)
  })

  it('does not report a bitmap it has already painted (a twin card in a two-deck game shows the same one) - no new load would ever close it', async () => {
    const r = await render(playing(NINE(true, 0)))
    await loadFace()
    await r.rerender(playing(NINE(true, 1)))
    expect(isAnyFaceLoading(['spades-9-1'])).toBe(false)
    await r.unmount()
  })

  it('a ghost does not report its face (its faces are not the board)', async () => {
    const r = await render(playing(NINE(true), false))
    expect(isAnyFaceLoading(['spades-9-0'])).toBe(false)
    await r.unmount()
  })
})

describe('PlayingCard turned face-up in place', () => {
  it('keeps its back drawn over the new face until that face has loaded, then shows the face', async () => {
    const r = await render(playing(NINE(false)))
    expect(screen.queryAllByTestId('card-back')).toHaveLength(1)
    await r.rerender(playing(NINE(true)))
    expect(face()).toBeTruthy() // the face is mounted (and loading) ...
    expect(screen.queryAllByTestId('card-back')).toHaveLength(1) // ... under the back, which still shows
    await loadFace()
    expect(screen.queryAllByTestId('card-back')).toHaveLength(0)
    await r.unmount()
  })

  it('shows the face anyway if it never reports', async () => {
    jest.useFakeTimers()
    try {
      const r = await render(playing(NINE(false)))
      await r.rerender(playing(NINE(true)))
      await act(async () => {
        await jest.advanceTimersByTimeAsync(250)
      })
      expect(screen.queryAllByTestId('card-back')).toHaveLength(0)
      await r.unmount()
    } finally {
      jest.useRealTimers()
    }
  })

  it('a card that is face-up from the start never draws a back', async () => {
    const r = await render(playing(NINE(true)))
    expect(screen.queryAllByTestId('card-back')).toHaveLength(0)
    await r.unmount()
  })
})
