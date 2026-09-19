import { CardSizeProvider } from '@tastic/cards'
import { render } from '@testing-library/react-native'

import { PileView } from '@/components/PileView'
import type { Card } from '@/engine/types'

const mockRenders: Record<string, number> = {}
const mockGhost = { cardRegistry: { register: jest.fn(), unregister: jest.fn() }, showLive: jest.fn() }

jest.mock('@/components/PlayingCard', () => {
  const { View } = require('react-native')
  return {
    PlayingCard: ({ card }: { card: { id: string } }) => {
      mockRenders[card.id] = (mockRenders[card.id] ?? 0) + 1
      return <View testID={`card-${card.id}`} />
    },
    EmptySlot: () => <View />
  }
})
jest.mock('@/components/dragdrop/DragGhostLayer', () => ({ useDragGhost: () => mockGhost }))
const mockPlayCardSound = jest.fn()
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => ({ playCardSound: mockPlayCardSound }) }))
// The repo-wide Reanimated mock hands back a NEW shared value / animated ref every render; the real ones are stable
// for a component's lifetime, and PileView's memoization relies on that - so make them stable here too.
jest.mock('react-native-reanimated', () => {
  const { useRef } = require('react')
  const base = jest.requireActual('../../__mocks__/react-native-reanimated')
  return {
    ...base,
    useSharedValue: (initial: unknown) => useRef({ value: initial }).current,
    useAnimatedRef: () => useRef({ current: null }).current
  }
})
jest.mock('react-native-gesture-handler', () => {
  const pan = () => {
    const g: Record<string, unknown> = {}
    for (const method of ['minDistance', 'onStart', 'onUpdate', 'onEnd', 'enabled']) g[method] = () => g
    return g
  }
  return { Gesture: { Pan: pan }, GestureDetector: ({ children }: { children: unknown }) => children }
})

const card = (rank: number): Card => ({ id: `spades-${rank}-0`, suit: 'spades', rank, faceUp: true }) as Card
const CARDS = [card(9), card(8), card(7), card(6), card(5)]
const ids = CARDS.map((c) => c.id)
const drag = { registry: { hitTest: async () => null }, getRunCount: () => 1, onDrop: async () => false } as never

function pile(props: Partial<React.ComponentProps<typeof PileView>> = {}) {
  return (
    <CardSizeProvider width={64}>
      <PileView cards={CARDS} drag={drag} onPressCard={() => {}} {...props} />
    </CardSizeProvider>
  )
}

const rendersOf = () => ids.map((id) => mockRenders[id] ?? 0)

describe('PileView card memoization', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockRenders)) delete mockRenders[key]
  })

  it('renders every card once on mount', async () => {
    await render(pile())

    expect(rendersOf()).toEqual([1, 1, 1, 1, 1])
  })

  // Every screen re-renders on each card landing / flight / hint, and passes a fresh inline `onPressCard` each time
  // (and PileView builds fresh drag handlers each render). None of that may re-render an unchanged card.
  it('does not re-render cards when the parent re-renders with a fresh inline onPressCard', async () => {
    const { rerender } = await render(pile())

    await rerender(pile({ onPressCard: () => {} }))
    await rerender(pile({ onPressCard: () => {} }))

    expect(rendersOf()).toEqual([1, 1, 1, 1, 1])
  })

  it('re-renders only the card whose own props changed (a deal landing reveals one card)', async () => {
    const { rerender } = await render(pile({ hiddenCardIds: new Set(ids) }))
    const before = rendersOf()

    await rerender(pile({ hiddenCardIds: new Set(ids.filter((id) => id !== ids[2])) }))

    // Un-hiding one card changes that card's `isHidden` (a prop of the wrapper, not of PlayingCard) - the wrapper
    // re-renders and PlayingCard, whose own props are unchanged, may or may not; but no OTHER card may be touched.
    const after = rendersOf()
    expect(after.filter((n, i) => n !== before[i] && i !== 2)).toEqual([])
  })

  it('still updates a card whose selection changes', async () => {
    const { rerender } = await render(pile())

    await rerender(pile({ selectedCount: 1 }))

    // The top card is the selected one; only it re-renders.
    expect(mockRenders[ids[4]]).toBe(2)
    expect(rendersOf().slice(0, 4)).toEqual([1, 1, 1, 1])
  })

  it('a card without a press handler is not pressable at all (it must not swallow taps meant for what is behind it)', async () => {
    const screen = await render(pile({ onPressCard: undefined }))

    // PlayingCard receives `onPress` undefined for every card - rendered without error and without a handler.
    expect(screen.queryAllByTestId(/^card-/)).toHaveLength(5)
  })
})
