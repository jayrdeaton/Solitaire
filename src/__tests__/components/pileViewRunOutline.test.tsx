import { CARD_ASPECT, CardSizeProvider, faceUpFanOffset } from '@tastic/cards'
import { render, screen } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'

import { PileView } from '@/components/PileView'
import type { Card } from '@/engine/types'

// A hinted or selected RUN is drawn with one outline around the whole run (RunOutline), not a ring on every card: per-card
// rings drew a ladder of lines across the run, and each hint glow spilled over the face of the card above. A single card
// keeps its own ring.

const mockRings: Record<string, { hinted: boolean; selected: boolean }> = {}
const mockGhost = { cardRegistry: { register: jest.fn(), unregister: jest.fn() }, showLive: jest.fn() }

jest.mock('@/components/PlayingCard', () => {
  const { View } = require('react-native')
  return {
    PlayingCard: ({ card, hinted, selected }: { card: { id: string }; hinted?: boolean; selected?: boolean }) => {
      mockRings[card.id] = { hinted: !!hinted, selected: !!selected }
      return <View testID={`card-${card.id}`} />
    },
    RunOutline: ({ kind }: { kind: string }) => <View testID={`outline-${kind}`} />,
    EmptySlot: () => <View />
  }
})
jest.mock('@/components/dragdrop/DragGhostLayer', () => ({ useDragGhost: () => mockGhost }))
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => ({ playCardSound: jest.fn() }) }))
jest.mock('react-native-reanimated', () => {
  const { useRef } = require('react')
  const base = jest.requireActual('../../__mocks__/react-native-reanimated')
  return { ...base, useSharedValue: (initial: unknown) => useRef({ value: initial }).current, useAnimatedRef: () => useRef({ current: null }).current }
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
const drag = { registry: { hitTest: async () => null }, getRunCount: () => 1, onDrop: async () => false } as never
const CARD_WIDTH = 64

function pile(props: Partial<React.ComponentProps<typeof PileView>> = {}) {
  return (
    <CardSizeProvider width={CARD_WIDTH}>
      <PileView cards={CARDS} drag={drag} onPressCard={() => {}} {...props} />
    </CardSizeProvider>
  )
}

/** The outline's own box: its parent (PileView's positioned wrapper). */
function outlineBox(kind: string) {
  const outline = screen.getByTestId(`outline-${kind}`)
  return StyleSheet.flatten(outline.parent?.props.style) as { top: number; height: number; width: number; zIndex: number }
}

describe('PileView run outline', () => {
  beforeEach(() => {
    for (const id of Object.keys(mockRings)) delete mockRings[id]
  })

  it('draws one hint outline around a hinted run, from the run head to the bottom card, and rings none of its cards', async () => {
    await render(pile({ hintCount: 3 }))
    expect(screen.getAllByTestId('outline-hint')).toHaveLength(1)
    expect(CARDS.map((c) => mockRings[c.id].hinted)).toEqual([false, false, false, false, false])
    // An uncompressed column of face-up cards: card i sits i fan steps down; the run is cards 2 to 4.
    const step = faceUpFanOffset(CARD_WIDTH)
    const box = outlineBox('hint')
    expect(box.top).toBeCloseTo(2 * step)
    expect(box.height).toBeCloseTo(2 * step + CARD_WIDTH / CARD_ASPECT)
    expect(box.width).toBe(CARD_WIDTH)
    expect(box.zIndex).toBeGreaterThanOrEqual(CARDS.length)
  })

  it('keeps a single hinted card on its own ring, with no outline', async () => {
    await render(pile({ hintCount: 1 }))
    expect(screen.queryByTestId('outline-hint')).toBeNull()
    expect(mockRings[CARDS[4].id].hinted).toBe(true)
  })

  it('does the same for a selected run, and the selection wins over a hint like on a single card', async () => {
    await render(pile({ selectedCount: 2, hintCount: 3 }))
    expect(screen.getAllByTestId('outline-selected')).toHaveLength(1)
    expect(screen.queryByTestId('outline-hint')).toBeNull()
    expect(CARDS.map((c) => mockRings[c.id].selected)).toEqual([false, false, false, false, false])
    expect(CARDS.map((c) => mockRings[c.id].hinted)).toEqual([false, false, false, false, false])
  })

  it('draws no outline while a card of the run is in flight', async () => {
    await render(pile({ hintCount: 3, hiddenCardIds: new Set([CARDS[3].id]) }))
    expect(screen.queryByTestId('outline-hint')).toBeNull()
  })
})
