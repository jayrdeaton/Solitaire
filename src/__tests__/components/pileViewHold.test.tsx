import { CARD_ASPECT, CardSizeProvider, faceUpFanOffset } from '@tastic/cards'
import { act, render, screen } from '@testing-library/react-native'
import { ReactNode } from 'react'

import { isGhostPending, markGhostPending } from '@/components/cardFacePaint'
import { MIN_FAN_SCALE } from '@/components/columnTops'
import { DraggableCard } from '@/components/dragdrop/DraggableCard'
import { DragGhostProvider } from '@/components/dragdrop/DragGhostLayer'
import { PileView } from '@/components/PileView'
import { Card } from '@/engine/types'

// ---------------------------------------------------------------------------------------------------------------------
// PileView's (and DraggableCard's) side of the take-off hold (cardFacePaint.ts): a ghost is a fresh Image, invisible until
// its face has painted, and while it is, the card's SOURCE keeps drawing it - so a card never flashes blank, or vanishes,
// as it takes off.
//   - A card picked up by a drag stays drawn where it is until its drag ghost is on screen (PileView's isCardHidden,
//     DraggableCard's hiddenForDrag). Every drag in dragGhostLayer.test.tsx paints its ghost in the commit it mounts, so
//     nothing there sees the card before that.
//   - A card that has left a column stays drawn where it was (PileView's `departing`), and a column compressed to fit its
//     maxHeight keeps the fan it was drawn with under it until it goes: the cards left in the column don't move, a second
//     card leaving meanwhile is held where IT was drawn, and a card arriving meanwhile takes the slot the held card left.
// The REAL DragGhostProvider drives it, with the stand-ins dragGhostLayer.test.tsx uses (copied, not imported: jest.mock
// factories are per file).
// ---------------------------------------------------------------------------------------------------------------------

/** What Reanimated's measure() answers for the card being picked up (its screen origin). */
const mockMeasured = { x: 10, y: 400 }
const mockPans: { onStart?: (e: { absoluteX: number; absoluteY: number }) => void; onUpdate?: (e: { absoluteX: number; absoluteY: number }) => void; onEnd?: (e: { absoluteX: number; absoluteY: number }) => void }[] = []
const mockFeedback = { playCardSound: jest.fn(), playInvalidSound: jest.fn(), hapticCard: jest.fn(), hapticInvalid: jest.fn() }

jest.mock('react-native-reanimated', () => {
  const { useRef } = require('react')
  const { View } = require('react-native')
  // A shared value whose spring assignments animate over (fake) time: critically damped, real end at 1.5 x duration.
  class Mutable {
    private base: number
    private anim: { from: number; to: number; start: number; duration: number } | null = null
    constructor(value: number) {
      this.base = value
    }
    get value(): number {
      const a = this.anim
      if (!a) return this.base
      const t = Date.now() - a.start
      if (t >= 1.5 * a.duration) {
        this.base = a.to
        this.anim = null
        return a.to
      }
      const u = (8.233 * t) / a.duration
      return a.to + (a.from - a.to) * (1 + u) * Math.exp(-u)
    }
    set value(next: number | { __spring: true; toValue: number; config: { duration: number } }) {
      if (typeof next === 'object') this.anim = { from: this.value, to: next.toValue, start: Date.now(), duration: next.config.duration }
      else {
        this.anim = null
        this.base = next
      }
    }
  }
  // The card's own host view, tagged so a test finds it: a ghost (its children are keyed card wrappers) or a board card (its child is a PlayingCard).
  // A fanned ghost's own cards are animated views too (each carries its fan step), so nothing inside a ghost is tagged.
  const InGhost = require('react').createContext(false)
  function AnimatedView({ style, children }: { style?: unknown; children?: ReactNode }) {
    const inGhost = require('react').useContext(InGhost)
    const first = (require('react').Children.toArray(children) as { key?: string; props?: { card?: { id: string } } }[])[0]
    const isGhost = !first?.props?.card && first?.key != null
    const testID = inGhost ? undefined : first?.props?.card ? `board:${first.props.card.id}` : isGhost ? `ghost:${String(first.key).replace(/^\.\$/, '')}` : undefined
    const view = (
      <View testID={testID} style={style}>
        {children}
      </View>
    )
    return isGhost ? <InGhost.Provider value>{view}</InGhost.Provider> : view
  }
  const shared = jest.requireActual('../../__mocks__/react-native-reanimated')
  return {
    __esModule: true,
    default: { View: AnimatedView },
    // PileView's fan glide: an inert layout transition (see the shared mock).
    Easing: shared.Easing,
    LinearTransition: shared.LinearTransition,
    makeMutable: (value: number) => new Mutable(value),
    useSharedValue: (value: number) => useRef(new Mutable(value)).current,
    useAnimatedRef: () => useRef({ current: null }).current,
    useAnimatedStyle: (worklet: () => unknown) => ({ __worklet: worklet }),
    withSpring: (toValue: number, config: { duration: number }) => ({ __spring: true, toValue, config }),
    withSequence: (...values: unknown[]) => values[values.length - 1],
    withTiming: (value: unknown) => value,
    measure: () => ({ pageX: mockMeasured.x, pageY: mockMeasured.y }),
    runOnJS: (fn: unknown) => fn
  }
})
jest.mock('react-native-gesture-handler', () => {
  const pan = () => {
    const handlers: (typeof mockPans)[number] = {}
    mockPans.push(handlers)
    const g = {
      minDistance: () => g,
      enabled: () => g,
      onStart: (fn: (typeof handlers)['onStart']) => {
        handlers.onStart = fn
        return g
      },
      onUpdate: (fn: (typeof handlers)['onUpdate']) => {
        handlers.onUpdate = fn
        return g
      },
      onEnd: (fn: (typeof handlers)['onEnd']) => {
        handlers.onEnd = fn
        return g
      }
    }
    return g
  }
  return { Gesture: { Pan: pan }, GestureDetector: ({ children }: { children: unknown }) => children }
})
/** Ghost faces report their bitmap painted once mounted, as a loaded Image does (a ghost is invisible until then - see
 * cardFacePaint.ts's useGhostPaintGate) - unless `defer` is on, when the reports wait in `waiting` for paintAll(). */
const mockPaint = { defer: false, waiting: [] as (() => void)[] }
jest.mock('@/components/PlayingCard', () => {
  const { View } = require('react-native')
  const { useEffect: useMockEffect } = require('react')
  function MockPlayingCard({ card, onFacePainted }: { card: { id: string }; onFacePainted?: () => void }) {
    useMockEffect(() => {
      if (!onFacePainted) return
      if (mockPaint.defer) mockPaint.waiting.push(onFacePainted)
      else onFacePainted()
    }, [onFacePainted])
    return <View testID={`card:${card.id}`} />
  }
  return { PlayingCard: MockPlayingCard, EmptySlot: () => <View /> }
})
jest.mock('@/components/overlayFrame', () => {
  // toLocal with this frame is the identity on a screen point (the overlay sits at the window origin, unrotated).
  const frame = { rotation: { value: 0 }, cx: { value: 200 }, cy: { value: 400 }, lw: { value: 400 }, lh: { value: 800 } }
  return { useOverlayFrame: () => ({ overlayRef: { current: null }, frame }), toLocal: jest.requireActual('@/components/overlayFrameMath').toLocal }
})
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => mockFeedback }))

// ------------------------------------------------------------------------------------------------ harness

const CARD_WIDTH = 64
const tree = (children: ReactNode) => (
  <CardSizeProvider width={CARD_WIDTH}>
    <DragGhostProvider>{children}</DragGhostProvider>
  </CardSizeProvider>
)
const card = (id: string): Card => ({ id, suit: id.split('-')[0], rank: Number(id.split('-')[1]), faceUp: true }) as Card
/** A drag config with nowhere to drop (these tests are about the pick-up), every card the head of a run to the top. */
const drag = { registry: { hitTest: async () => null }, getRunCount: (indexFromTop: number) => indexFromTop + 1, onDrop: async () => false }
const pile = (cards: Card[], props: Partial<React.ComponentProps<typeof PileView>> = {}) => tree(<PileView cards={cards} drag={drag as never} onPressCard={() => {}} {...props} />)

const flatStyle = (testID: string) => Object.assign({}, ...([screen.getByTestId(testID).props.style].flat(Infinity) as object[]).filter(Boolean)) as { top?: number; opacity?: number }
/** A board card's own view is invisible (its ghost is standing in for it). */
const boardHidden = (id: string) => ([screen.getByTestId(`board:${id}`).props.style].flat(Infinity) as { opacity?: number }[]).some((s) => s?.opacity === 0)
const ghostOpacity = (id: string) => ([screen.getByTestId(`ghost:${id}`).props.style].flat(Infinity) as { opacity?: number }[]).reduce((o, st) => (st && st.opacity !== undefined ? st.opacity : o), 1)
const topOf = (id: string) => flatStyle(`board:${id}`).top!
const paintAll = () => mockPaint.waiting.splice(0).forEach((painted) => painted())

// The ghost-pending registry is module-level: every mark a test makes is released after it, pass or fail. Marked inside
// act(): the column watches its own cards in it (useGhostPendingAmong), so a mark re-renders it.
const marks: (() => void)[] = []
async function mark(ids: string[]) {
  let release!: () => void
  await act(async () => {
    release = markGhostPending(ids)
  })
  marks.push(release)
  return release
}

beforeEach(() => {
  jest.useFakeTimers()
  mockPaint.defer = false
  mockPaint.waiting.length = 0
  mockPans.length = 0
  mockMeasured.x = 10
  mockMeasured.y = 400
  Object.values(mockFeedback).forEach((fn) => fn.mockClear())
})
afterEach(() => {
  marks.splice(0).forEach((release) => release())
  jest.useRealTimers()
})

// ------------------------------------------------------------------------------------------------ the pick-up

describe('pick-up hold: a card picked up by a drag stays drawn at its source until its drag ghost has painted', () => {
  const PILE = [9, 8, 7, 6, 5].map((rank) => card(`spades-${rank}-0`))
  const TOP = PILE[4]
  const SECOND = PILE[3]

  it('PileView', async () => {
    await render(pile(PILE))
    mockPaint.defer = true // a fresh drag: no snap-back ghost to adopt, so its ghost waits for its face
    await act(async () => {
      mockPans[4].onStart!({ absoluteX: 100, absoluteY: 500 })
    })
    expect(isGhostPending(TOP.id)).toBe(true)
    expect(ghostOpacity(TOP.id)).toBe(0) // the ghost is not on screen yet...
    expect(boardHidden(TOP.id)).toBe(false) // ...so the card is still drawn in the column
    await act(async () => paintAll())
    expect(isGhostPending(TOP.id)).toBe(false)
    expect(ghostOpacity(TOP.id)).toBe(1)
    expect(boardHidden(TOP.id)).toBe(true) // the ghost has taken over
  })

  it('PileView, a run: every card of it stays drawn until the whole ghost has painted', async () => {
    await render(pile(PILE))
    mockPaint.defer = true
    await act(async () => {
      mockPans[3].onStart!({ absoluteX: 100, absoluteY: 500 }) // the second card: picks up it and the top card
    })
    expect(mockPaint.waiting).toHaveLength(2)
    expect(ghostOpacity(SECOND.id)).toBe(0)
    expect([boardHidden(SECOND.id), boardHidden(TOP.id)]).toEqual([false, false])
    await act(async () => mockPaint.waiting.shift()!()) // one face in: the ghost still waits for the other
    expect(ghostOpacity(SECOND.id)).toBe(0)
    expect([boardHidden(SECOND.id), boardHidden(TOP.id)]).toEqual([false, false])
    await act(async () => paintAll())
    expect(ghostOpacity(SECOND.id)).toBe(1)
    expect([boardHidden(SECOND.id), boardHidden(TOP.id)]).toEqual([true, true])
    expect(boardHidden(PILE[2].id)).toBe(false) // the card under the run was never part of it
  })

  it('DraggableCard', async () => {
    const C = card('hearts-4-0')
    await render(tree(<DraggableCard card={C} onDrop={async () => false} />))
    mockPaint.defer = true
    await act(async () => {
      mockPans[0].onStart!({ absoluteX: 50, absoluteY: 320 })
    })
    expect(isGhostPending(C.id)).toBe(true)
    expect(ghostOpacity(C.id)).toBe(0)
    expect(boardHidden(C.id)).toBe(false)
    await act(async () => paintAll())
    expect(isGhostPending(C.id)).toBe(false)
    expect(ghostOpacity(C.id)).toBe(1)
    expect(boardHidden(C.id)).toBe(true)
  })
})

// ------------------------------------------------------------------------------------------------ a compressed column

describe('PileView - a compressed column under a card still taking off from it', () => {
  // Ten face-up cards in 310pt: a fan of 9 x 28.8pt plus a 93pt card does not fit, so the column is compressed (a long
  // FreeCell/Spider/Yukon column, or almost any column in landscape) - and one card fewer is a looser fan. Every fan here
  // stays above MIN_FAN_SCALE (ten cards: 0.84), so each fits its maxHeight exactly.
  const MAX_HEIGHT = 310
  const STEP = faceUpFanOffset(CARD_WIDTH)
  const CARD_HEIGHT = CARD_WIDTH / CARD_ASPECT
  /** The i-th card's top in a freshly laid out column of n face-up cards. */
  const fitTop = (i: number, n: number) => i * STEP * Math.min(1, (MAX_HEIGHT - CARD_HEIGHT) / ((n - 1) * STEP))
  const COLUMN = [13, 12, 11, 10, 9, 8, 7, 6, 5, 4].map((rank) => card(`hearts-${rank}-0`))
  const C = COLUMN[9]
  const B = COLUMN[8]
  const column = (cards: Card[]) => pile(cards, { maxHeight: MAX_HEIGHT })
  const topsOf = (cards: Card[]) => cards.map((c) => topOf(c.id))
  const expectTops = (cards: Card[], expected: number[]) => topsOf(cards).forEach((top, i) => expect(top).toBeCloseTo(expected[i], 6))

  it('(the setup really is compressed, and one card fewer really is a looser fan)', async () => {
    await render(column(COLUMN))
    expectTops(
      COLUMN,
      COLUMN.map((_, i) => fitTop(i, 10))
    )
    expect(fitTop(8, 9) - fitTop(8, 10)).toBeGreaterThan(10)
  })

  it('the cards left in the column keep their tops while the card that left is held over them, and re-spread once it has gone', async () => {
    const r = await render(column(COLUMN))
    const before = topsOf(COLUMN)
    const release = await mark([C.id])
    await r.rerender(column(COLUMN.slice(0, 9)))
    expectTops(COLUMN, before) // the held card where it was drawn, and nothing under it moved
    await act(async () => release())
    expect(screen.queryByTestId(`board:${C.id}`)).toBeNull()
    expectTops(
      COLUMN.slice(0, 9),
      COLUMN.slice(0, 9).map((_, i) => fitTop(i, 9))
    )
  })

  it('a second card leaving while the first is still held is held where IT was drawn - not where a column without the first would put it', async () => {
    const r = await render(column(COLUMN))
    const before = topsOf(COLUMN)
    const releaseC = await mark([C.id])
    await r.rerender(column(COLUMN.slice(0, 9)))
    const releaseB = await mark([B.id]) // e.g. the next card of an auto-play stream, while C's ghost is still waiting for its face
    await r.rerender(column(COLUMN.slice(0, 8)))
    expectTops(COLUMN, before) // B too: it is still drawn exactly where it was painted, under C
    // C's ghost shows first (it mounted first). B is still drawn where it was painted, in the ten-card fan - so the cards
    // under it must keep that fan too, not re-spread to one sized by the highest slot still held (nine cards): that slid
    // the card under B ~12pt up under it, its corner index mostly covered, for the rest of B's hold.
    await act(async () => releaseC())
    expect(screen.queryByTestId(`board:${C.id}`)).toBeNull()
    expectTops(COLUMN.slice(0, 9), before.slice(0, 9))
    await act(async () => releaseB())
    expectTops(
      COLUMN.slice(0, 8),
      COLUMN.slice(0, 8).map((_, i) => fitTop(i, 8))
    )
  })

  it('a card arriving after the first of two holds ends, during the second, does not move anything under the card still held either: it lands in that fan, and the column re-spreads once, when the hold ends', async () => {
    // The cost columnTops documents: the newcomer's slot is where the held card's fan puts it, not where it will stay. The
    // other way round (sized by the highest slot still held) would put it where it stays, but only by moving every card
    // under the held one while it is still drawn over them.
    const X = card('clubs-3-0')
    const r = await render(column(COLUMN))
    const before = topsOf(COLUMN)
    const releaseC = await mark([C.id])
    await r.rerender(column(COLUMN.slice(0, 9)))
    const releaseB = await mark([B.id])
    await r.rerender(column(COLUMN.slice(0, 8)))
    await act(async () => releaseC())
    await r.rerender(column([...COLUMN.slice(0, 8), X]))
    expectTops(COLUMN.slice(0, 9), before.slice(0, 9))
    expect(topOf(X.id)).toBeCloseTo(before[8], 6) // exactly under B: nothing of it shows past B's edges
    await act(async () => releaseB())
    expect(screen.queryByTestId(`board:${B.id}`)).toBeNull()
    expectTops(
      [...COLUMN.slice(0, 8), X],
      COLUMN.slice(0, 9).map((_, i) => fitTop(i, 9))
    )
  })

  it('a card arriving while one is held takes the slot the held card left: nothing under them is compressed one card tighter, and nothing moves when the hold ends', async () => {
    const X = card('clubs-3-0')
    const r = await render(column(COLUMN))
    const before = topsOf(COLUMN)
    const release = await mark([C.id])
    await r.rerender(column(COLUMN.slice(0, 9)))
    await r.rerender(column([...COLUMN.slice(0, 9), X]))
    expectTops(COLUMN, before)
    expect(topOf(X.id)).toBeCloseTo(before[9], 6) // where it will stay - any flight into the column measures it there
    await act(async () => release())
    expect(screen.queryByTestId(`board:${C.id}`)).toBeNull()
    expectTops([...COLUMN.slice(0, 9), X], before)
  })

  /** The column's own box: the nearest ancestor of a card's view sized as the column (card-wide, with a height). */
  const boxHeightOf = (id: string) => {
    let node = screen.getByTestId(`board:${id}`).parent
    while (node) {
      const style = Object.assign({}, ...([node.props?.style].flat(Infinity) as object[]).filter(Boolean)) as { width?: number; height?: number }
      if (style.width === CARD_WIDTH && style.height !== undefined && node.props?.testID === undefined) return style.height
      node = node.parent
    }
    return undefined
  }

  it('a column that fits keeps a box exactly maxHeight tall', async () => {
    await render(column(COLUMN))
    expect(boxHeightOf(COLUMN[0].id)).toBe(MAX_HEIGHT)
  })

  it('a column too long for MIN_FAN_SCALE stops compressing there and grows its box past maxHeight (what the board scrolls to)', async () => {
    const LONG = Array.from({ length: 30 }, (_, i) => card(`spades-${(i % 13) + 1}-${i}`))
    await render(column(LONG))
    expect(topOf(LONG[1].id) - topOf(LONG[0].id)).toBeCloseTo(STEP * MIN_FAN_SCALE, 6)
    expect(boxHeightOf(LONG[0].id)).toBeCloseTo(29 * STEP * MIN_FAN_SCALE + CARD_HEIGHT, 6)
  })
})
