import { CardSizeProvider } from '@tastic/cards'
import { act, render, screen } from '@testing-library/react-native'
import { Text, View } from 'react-native'

import { GHOST_PAINT_MAX_MS, GHOST_PENDING_MAX_MS, isGhostPending, markGhostPending, useGhostPaintGate } from '@/components/cardFacePaint'
import { PileView } from '@/components/PileView'
import { useTakeOffHold } from '@/components/useTakeOffHold'
import type { Card } from '@/engine/types'

// The take-off side of the blank-face fix (cardFacePaint.ts): a ghost is a fresh Image, invisible until its face has
// painted, and while it is, the card's SOURCE keeps drawing it - the same, already-painted instance - so the card never
// flashes blank, or vanishes, as it takes off. "Taking off" here is markGhostPending; the ghost "showing" is its release.

const mockMounts: Record<string, number> = {}
const mockGhost = { cardRegistry: { register: jest.fn(), unregister: jest.fn() }, showLive: jest.fn() }
jest.mock('@/components/PlayingCard', () => {
  const { View: MockView } = require('react-native')
  const { useEffect: useMockEffect } = require('react')
  function MockPlayingCard({ card }: { card: { id: string } }) {
    useMockEffect(() => {
      mockMounts[card.id] = (mockMounts[card.id] ?? 0) + 1
    }, [card.id])
    return <MockView testID={`card-${card.id}`} />
  }
  return { PlayingCard: MockPlayingCard, EmptySlot: () => <MockView testID='empty-slot' /> }
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

const card = (rank: number, suit = 'spades'): Card => ({ id: `${suit}-${rank}-0`, suit, rank, faceUp: true }) as Card

// The registry is module-level: every mark a test makes is released after it, pass or fail.
const marks: (() => void)[] = []
// Inside act: a mark notifies the subscribed piles, which re-render.
async function mark(ids: string[]) {
  let release!: () => void
  await act(async () => {
    release = markGhostPending(ids)
  })
  marks.push(release)
  return release
}
beforeEach(() => {
  for (const key of Object.keys(mockMounts)) delete mockMounts[key]
})
afterEach(() => marks.splice(0).forEach((release) => release()))

function Slot({ card: c }: { card: Card | undefined }) {
  const { shown, holding } = useTakeOffHold(c)
  return <Text testID='slot'>{`${shown?.id ?? 'none'}${holding ? ' (held)' : ''}`}</Text>
}
const slot = () => screen.getByTestId('slot').props.children as string

describe('useTakeOffHold', () => {
  it('keeps drawing a card that has just left while its ghost is not on screen, then follows the pile', async () => {
    const X = card(9)
    const Y = card(8)
    const r = await render(<Slot card={X} />)
    const release = await mark([X.id])
    await r.rerender(<Slot card={Y} />)
    expect(slot()).toBe(`${X.id} (held)`)
    await act(async () => release())
    expect(slot()).toBe(Y.id)
  })

  it('holds a card that leaves the pile empty too', async () => {
    const X = card(9)
    const r = await render(<Slot card={X} />)
    const release = await mark([X.id])
    await r.rerender(<Slot card={undefined} />)
    expect(slot()).toBe(`${X.id} (held)`)
    await act(async () => release())
    expect(slot()).toBe('none')
  })

  it('follows a change at once when the card that left is not taking off (a card landing here, an undo, a new deal)', async () => {
    const r = await render(<Slot card={card(9)} />)
    await r.rerender(<Slot card={card(8)} />)
    expect(slot()).toBe(card(8).id)
  })

  it("never holds the pile's own arriving card: only the card it drew last, and only once it has left", async () => {
    const X = card(9)
    const D = card(4, 'hearts')
    const r = await render(<Slot card={X} />)
    const release = await mark([D.id]) // D is being drawn onto this pile, not leaving it
    await r.rerender(<Slot card={D} />)
    expect(slot()).toBe(D.id)
    await act(async () => release())
  })
})

const drag = { registry: { hitTest: async () => null }, getRunCount: () => 1, onDrop: async () => false } as never
function pile(cards: Card[], props: Partial<React.ComponentProps<typeof PileView>> = {}) {
  return (
    <CardSizeProvider width={64}>
      <PileView cards={cards} drag={drag} onPressCard={() => {}} {...props} />
    </CardSizeProvider>
  )
}

describe('PileView take-off hold', () => {
  it('keeps a card that left the column drawn - the SAME instance, never remounted - until its ghost is on screen', async () => {
    const [K, Q] = [card(13), card(12)]
    const r = await render(pile([K, Q]))
    const release = await mark([Q.id])
    await r.rerender(pile([K]))
    expect(screen.getByTestId(`card-${Q.id}`)).toBeTruthy()
    expect(mockMounts[Q.id]).toBe(1)
    await act(async () => release())
    expect(screen.queryByTestId(`card-${Q.id}`)).toBeNull()
  })

  it('a held card is inert and unregistered: a tap meant for the card it uncovered goes through, and the card is measured where it went, never here', async () => {
    const [K, Q] = [card(13), card(12)]
    const r = await render(pile([K, Q]))
    mockGhost.cardRegistry.unregister.mockClear()
    const release = await mark([Q.id])
    await r.rerender(pile([K]))
    expect(mockGhost.cardRegistry.unregister).toHaveBeenCalledWith(Q.id, expect.anything())
    // The card's own positioned wrapper (the Animated.View carrying its `top`).
    let node = screen.getByTestId(`card-${Q.id}`).parent
    const styleOf = (n: typeof node) => Object.assign({}, ...([n?.props.style].flat(Infinity) as object[]).filter(Boolean)) as { position?: string; pointerEvents?: string }
    while (node && styleOf(node).position !== 'absolute') node = node.parent
    expect(styleOf(node).pointerEvents).toBe('none')
    await act(async () => release())
  })

  it('holds the last card out of a column too, over the empty slot', async () => {
    const A = card(1)
    const r = await render(pile([A]))
    const release = await mark([A.id])
    await r.rerender(pile([]))
    expect(screen.getByTestId(`card-${A.id}`)).toBeTruthy()
    expect(screen.getByTestId('empty-slot')).toBeTruthy()
    expect(mockMounts[A.id]).toBe(1)
    await act(async () => release())
    expect(screen.queryByTestId(`card-${A.id}`)).toBeNull()
  })

  it('does not hold a card it never drew (its own flight in had not landed - a FlyingCardSlot, nothing painted to keep)', async () => {
    const [K, Q] = [card(13), card(12)]
    const r = await render(pile([K, Q], { hiddenCount: 1 }))
    const release = await mark([Q.id])
    await r.rerender(pile([K]))
    expect(screen.queryByTestId(`card-${Q.id}`)).toBeNull()
    await act(async () => release())
  })

  it('does not hold a card whose ghost is already on screen (a dropped drag: its drag ghost has been showing all along)', async () => {
    const [K, Q] = [card(13), card(12)]
    const r = await render(pile([K, Q]))
    await r.rerender(pile([K]))
    expect(screen.queryByTestId(`card-${Q.id}`)).toBeNull()
  })

  it('a held entry is gone for good once its hold ends: the same card taking off again later (from wherever it went) is not drawn back here', async () => {
    const [K, Q] = [card(13), card(12)]
    const r = await render(pile([K, Q]))
    const first = await mark([Q.id])
    await r.rerender(pile([K]))
    await act(async () => first())
    const again = await mark([Q.id])
    await r.rerender(pile([K]))
    expect(screen.queryByTestId(`card-${Q.id}`)).toBeNull()
    await act(async () => again())
  })
})

function Gate({ ids, onShown }: { ids: string[]; onShown: () => void }) {
  const { shown, markPainted } = useGhostPaintGate(ids, onShown)
  return (
    <View>
      <Text testID='gate'>{shown ? 'shown' : 'hidden'}</Text>
      {ids.map((id) => (
        <Text key={id} testID={`paint-${id}`} onPress={() => markPainted(id)}>
          {id}
        </Text>
      ))}
    </View>
  )
}

describe('useGhostPaintGate', () => {
  it('shows once every face has painted, calling onShown in that commit', async () => {
    const onShown = jest.fn()
    await render(<Gate ids={['a', 'b']} onShown={onShown} />)
    expect(screen.getByTestId('gate').props.children).toBe('hidden')
    await act(async () => screen.getByTestId('paint-a').props.onPress())
    expect(screen.getByTestId('gate').props.children).toBe('hidden')
    await act(async () => screen.getByTestId('paint-b').props.onPress())
    expect(screen.getByTestId('gate').props.children).toBe('shown')
    expect(onShown).toHaveBeenCalledTimes(1)
  })

  it('shows at once with nothing to wait for (face-down cards are SVG)', async () => {
    const onShown = jest.fn()
    await render(<Gate ids={[]} onShown={onShown} />)
    expect(screen.getByTestId('gate').props.children).toBe('shown')
    expect(onShown).toHaveBeenCalledTimes(1)
  })

  it('shows anyway after GHOST_PAINT_MAX_MS if a face never reports', async () => {
    jest.useFakeTimers()
    try {
      await render(<Gate ids={['a']} onShown={() => {}} />)
      await act(async () => {
        await jest.advanceTimersByTimeAsync(GHOST_PAINT_MAX_MS)
      })
      expect(screen.getByTestId('gate').props.children).toBe('shown')
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('markGhostPending', () => {
  it('counts overlapping holds on one card, and a release called twice counts once', () => {
    const a = markGhostPending(['x'])
    const b = markGhostPending(['x'])
    a()
    a()
    expect(isGhostPending('x')).toBe(true)
    b()
    expect(isGhostPending('x')).toBe(false)
  })

  it('releases itself after GHOST_PENDING_MAX_MS if nothing does (a flight dropped before its ghost ever mounted)', () => {
    jest.useFakeTimers()
    try {
      markGhostPending(['y'])
      jest.advanceTimersByTime(GHOST_PENDING_MAX_MS - 1)
      expect(isGhostPending('y')).toBe(true)
      jest.advanceTimersByTime(1)
      expect(isGhostPending('y')).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })
})
