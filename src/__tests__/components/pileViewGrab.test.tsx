import { CardSizeProvider, faceUpFanOffset } from '@tastic/cards'
import { act, render } from '@testing-library/react-native'

import { HOLD_CANCELS_TAP_MS } from '@/components/dragdrop/holdGuard'
import { PileView } from '@/components/PileView'
import type { Card } from '@/engine/types'

// Two ways a touch on a tableau card went wrong in Spider (a coworker of Jay's, 2026-10-22):
// - a card pressed and held in place, then let go without a drag, played itself as a tap (tap-to-move sent it off);
// - a finger aimed at the head of a run but landing on the card above it (face-down, or above a break in the run) did
//   nothing at all. With the column's `grabRunBelow`, that touch acts on the run below, as if its head had been touched.

type Handlers = { onPress?: () => void; onPressIn?: () => void }
const mockCards: Record<string, Handlers> = {}
const mockPans: { enabled: boolean; onStart?: (e: { absoluteX: number; absoluteY: number }) => void }[] = []
const mockGhost = { cardRegistry: { register: jest.fn(), unregister: jest.fn() }, showLive: jest.fn(() => ({ release: jest.fn(), snapBack: jest.fn() })) }
let mockOrigin = { pageX: 0, pageY: 0 }

jest.mock('@/components/PlayingCard', () => {
  const { View } = require('react-native')
  return {
    PlayingCard: ({ card, onPress, onPressIn }: { card: { id: string } } & Handlers) => {
      mockCards[card.id] = { onPress, onPressIn }
      return <View testID={`card-${card.id}`} />
    },
    RunOutline: () => <View />,
    EmptySlot: () => <View />
  }
})
jest.mock('@/components/dragdrop/DragGhostLayer', () => ({ useDragGhost: () => mockGhost }))
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => ({ playCardSound: jest.fn(), hapticCard: jest.fn() }) }))
jest.mock('react-native-reanimated', () => {
  const { useRef } = require('react')
  const base = jest.requireActual('../../__mocks__/react-native-reanimated')
  const sharedValue = (initial: unknown) => ({
    value: initial,
    get() {
      return this.value
    },
    set(next: unknown) {
      this.value = next
    }
  })
  return { ...base, measure: () => mockOrigin, useSharedValue: (initial: unknown) => useRef(sharedValue(initial)).current, useAnimatedRef: () => useRef({ current: null }).current }
})
jest.mock('react-native-gesture-handler', () => {
  const pan = () => {
    const entry: (typeof mockPans)[number] = { enabled: true }
    mockPans.push(entry)
    const g: Record<string, unknown> = {}
    g.minDistance = () => g
    g.onStart = (fn: (typeof mockPans)[number]['onStart']) => ((entry.onStart = fn), g)
    g.onUpdate = () => g
    g.onEnd = () => g
    g.enabled = (on: boolean) => ((entry.enabled = on), g)
    return g
  }
  return { Gesture: { Pan: pan }, GestureDetector: ({ children }: { children: unknown }) => children }
})

const card = (id: string, rank: number, faceUp = true): Card => ({ id, suit: id.startsWith('h') ? 'hearts' : 'spades', rank, faceUp }) as Card
// A face-down card, a nine of hearts that breaks the run, then a movable 8-7-6 of spades.
const DOWN = card('s-down', 2, false)
const BREAK = card('h-9', 9)
const RUN = [card('s-8', 8), card('s-7', 7), card('s-6', 6)]
const CARDS = [DOWN, BREAK, ...RUN]
const runCount = (indexFromTop: number) => (indexFromTop < RUN.length ? indexFromTop + 1 : 0)
const CARD_WIDTH = 64

function pile(grabRunBelow: boolean, onPressCard = jest.fn()) {
  const drag = { registry: { hitTest: async () => null }, getRunCount: runCount, grabRunBelow, onDrop: async () => false }
  return (
    <CardSizeProvider width={CARD_WIDTH}>
      <PileView cards={CARDS} drag={drag as never} onPressCard={onPressCard} />
    </CardSizeProvider>
  )
}

beforeEach(() => {
  jest.useFakeTimers()
  for (const id of Object.keys(mockCards)) delete mockCards[id]
  mockPans.length = 0
  mockGhost.showLive.mockClear()
})

afterEach(() => jest.useRealTimers())

describe('PileView: a press held in place is not a tap', () => {
  it('a quick tap plays the card, one held past HOLD_CANCELS_TAP_MS does not', async () => {
    const onPressCard = jest.fn()
    await render(pile(false, onPressCard))
    const top = mockCards['s-6']
    await act(() => top.onPressIn?.())
    await act(() => jest.advanceTimersByTime(120))
    await act(() => top.onPress?.())
    expect(onPressCard).toHaveBeenCalledTimes(1)

    await act(() => top.onPressIn?.())
    await act(() => jest.advanceTimersByTime(HOLD_CANCELS_TAP_MS + 50))
    await act(() => top.onPress?.())
    expect(onPressCard).toHaveBeenCalledTimes(1)

    // The next quick tap counts again.
    await act(() => top.onPressIn?.())
    await act(() => top.onPress?.())
    expect(onPressCard).toHaveBeenCalledTimes(2)
  })
})

describe('PileView: a touch above the run acts on the run (grabRunBelow)', () => {
  it('without it, the card above the run takes no tap and no drag', async () => {
    await render(pile(false))
    expect(mockCards['h-9'].onPress).toBeUndefined()
    expect(mockPans[CARDS.indexOf(BREAK)].enabled).toBe(false)
    expect(mockPans[CARDS.indexOf(DOWN)].enabled).toBe(false)
  })

  it('a tap on the card above the run reports the head of the run, measured where the head is', async () => {
    const onPressCard = jest.fn()
    await render(pile(true, onPressCard))
    await act(() => mockCards['h-9'].onPress?.())
    expect(onPressCard).toHaveBeenCalledTimes(1)
    const [reported, indexFromTop] = onPressCard.mock.calls[0]
    expect(reported.id).toBe('s-8')
    expect(indexFromTop).toBe(2)
  })

  it('a drag from the card above the run, or from the face-down card, lifts the run with its ghost on the head', async () => {
    await render(pile(true))
    expect(mockPans[CARDS.indexOf(BREAK)].enabled).toBe(true)
    expect(mockPans[CARDS.indexOf(DOWN)].enabled).toBe(true)
    mockOrigin = { pageX: 10, pageY: 100 }
    await act(() => mockPans[CARDS.indexOf(BREAK)].onStart?.({ absoluteX: 20, absoluteY: 110 }))
    expect(mockGhost.showLive).toHaveBeenCalledTimes(1)
    const [content, values] = mockGhost.showLive.mock.calls[0] as unknown as [{ cards: Card[] }, { originX: { value: number }; originY: { value: number } }]
    expect(content.cards.map((c) => c.id)).toEqual(['s-8', 's-7', 's-6'])
    // One face-up step below the nine it touched.
    expect(values.originX.value).toBe(10)
    expect(values.originY.value).toBeCloseTo(100 + faceUpFanOffset(CARD_WIDTH))
  })

  it('a card of the run itself still lifts only from where it is touched', async () => {
    await render(pile(true))
    mockOrigin = { pageX: 10, pageY: 300 }
    await act(() => mockPans[CARDS.indexOf(RUN[1])].onStart?.({ absoluteX: 20, absoluteY: 310 }))
    const [content, values] = mockGhost.showLive.mock.calls[0] as unknown as [{ cards: Card[] }, { originY: { value: number } }]
    expect(content.cards.map((c) => c.id)).toEqual(['s-7', 's-6'])
    expect(values.originY.value).toBe(300)
  })
})
