import { CardSizeProvider } from '@tastic/cards'
import { act, render, screen } from '@testing-library/react-native'
import { ReactNode, useState } from 'react'
import { View } from 'react-native'

import { isGhostPending, trackFaceLoad } from '@/components/cardFacePaint'
import { DraggableCard } from '@/components/dragdrop/DraggableCard'
import { DragGhostProvider } from '@/components/dragdrop/DragGhostLayer'
import { useTakeOffHold } from '@/components/useTakeOffHold'
import { Card } from '@/engine/types'

// ---------------------------------------------------------------------------------------------------------------------
// DraggableCard's post-drop reveal (its revealToken): after an applied drop the slot shows its next card, the same face
// Image re-sourced - which on iOS keeps the DRAGGED card's bitmap until the next one arrives - so the slot stays hidden
// (its empty fallback showing) until the next card's face has painted.
//
// The case pinned here: a drop applied BEFORE the drag ghost has painted (a quick flick, a busy JS thread), from a slot
// wrapped in useTakeOffHold (the waste top, Canfield's reserve). The hold keeps the slot on the dragged card until the
// ghost shows, so the reveal must not resolve against that (already painted) card: it waits for the ghost, and then for
// the card the hold's end swaps in. The REAL DragGhostProvider drives it, with the stand-ins dragGhostLayer.test.tsx uses
// (copied, not imported: jest.mock factories are per file).
// ---------------------------------------------------------------------------------------------------------------------

const mockPans: { onStart?: (e: { absoluteX: number; absoluteY: number }) => void; onUpdate?: (e: { absoluteX: number; absoluteY: number }) => void; onEnd?: (e: { absoluteX: number; absoluteY: number }) => void }[] = []
const mockFeedback = { playCardSound: jest.fn(), playInvalidSound: jest.fn(), hapticCard: jest.fn(), hapticInvalid: jest.fn() }

jest.mock('react-native-reanimated', () => {
  const { useRef } = require('react')
  const { View: MockView } = require('react-native')
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
  function AnimatedView({ style, children }: { style?: unknown; children?: ReactNode }) {
    const first = (require('react').Children.toArray(children) as { key?: string; props?: { card?: { id: string } } }[])[0]
    const testID = first?.props?.card ? `board:${first.props.card.id}` : first?.key != null ? `ghost:${String(first.key).replace(/^\.\$/, '')}` : undefined
    return (
      <MockView testID={testID} style={style}>
        {children}
      </MockView>
    )
  }
  return {
    __esModule: true,
    default: { View: AnimatedView },
    makeMutable: (value: number) => new Mutable(value),
    useSharedValue: (value: number) => useRef(new Mutable(value)).current,
    useAnimatedRef: () => useRef({ current: null }).current,
    useAnimatedStyle: (worklet: () => unknown) => ({ __worklet: worklet }),
    withSpring: (toValue: number, config: { duration: number }) => ({ __spring: true, toValue, config }),
    withSequence: (...values: unknown[]) => values[values.length - 1],
    withTiming: (value: unknown) => value,
    measure: () => ({ pageX: 10, pageY: 400 }),
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
  const { View: MockView } = require('react-native')
  const { useEffect: useMockEffect } = require('react')
  function MockPlayingCard({ card, onFacePainted }: { card: { id: string }; onFacePainted?: () => void }) {
    useMockEffect(() => {
      if (!onFacePainted) return
      if (mockPaint.defer) mockPaint.waiting.push(onFacePainted)
      else onFacePainted()
    }, [onFacePainted])
    return <MockView testID={`card:${card.id}`} />
  }
  return { PlayingCard: MockPlayingCard, EmptySlot: () => <MockView /> }
})
jest.mock('@/components/overlayFrame', () => {
  // toLocal with this frame is the identity on a screen point (the overlay sits at the window origin, unrotated).
  const frame = { rotation: { value: 0 }, cx: { value: 200 }, cy: { value: 400 }, lw: { value: 400 }, lh: { value: 800 } }
  return { useOverlayFrame: () => ({ overlayRef: { current: null }, frame }), toLocal: jest.requireActual('@/components/overlayFrameMath').toLocal }
})
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => mockFeedback }))

// ------------------------------------------------------------------------------------------------ harness

const card = (id: string): Card => ({ id, suit: 'hearts', rank: Number(id.split('-')[1]), faceUp: true }) as Card
const DRAGGED = card('hearts-4-0')
const NEXT = card('hearts-3-0')

/**
 * A waste-like slot: one DraggableCard showing the pile's top through useTakeOffHold, as StockWaste/ReserveCell do. Its
 * drop is applied (returns true); `nextTop` is what the pile's top becomes then - the card under the dragged one, or the
 * dragged card itself (a drop the screen applied without taking it, which must never leave the slot hidden).
 */
function Slot({ nextTop }: { nextTop: Card }) {
  const [top, setTop] = useState(DRAGGED)
  const { shown, holding } = useTakeOffHold(top)
  if (!shown) return null
  const onDrop = async () => {
    setTop(nextTop)
    return true
  }
  return <DraggableCard card={shown} disabled={holding} registryId={holding ? top.id : undefined} onDrop={onDrop} emptyFallback={<View testID='fallback' />} />
}
const tree = (children: ReactNode) => (
  <CardSizeProvider width={64}>
    <DragGhostProvider>{children}</DragGhostProvider>
  </CardSizeProvider>
)
/** A board card's own view is invisible. */
const boardHidden = (id: string) => ([screen.getByTestId(`board:${id}`).props.style].flat(Infinity) as { opacity?: number }[]).some((s) => s?.opacity === 0)
const paintAll = () => mockPaint.waiting.splice(0).forEach((painted) => painted())

// The registry is module-level: every face load a test opens is closed after it, pass or fail.
const loads: (() => void)[] = []
function faceLoading(id: string) {
  const done = trackFaceLoad(id)
  loads.push(done)
  return done
}

beforeEach(() => {
  jest.useFakeTimers()
  mockPaint.defer = false
  mockPaint.waiting.length = 0
  mockPans.length = 0
})
afterEach(() => {
  loads.splice(0).forEach((done) => done())
  jest.useRealTimers()
})

/** Picks the slot's card up and drops it (applied) - with the drag ghost's face held back, so it has not shown yet. */
async function flickBeforeTheGhostPaints() {
  mockPaint.defer = true
  await act(async () => {
    mockPans[0].onStart!({ absoluteX: 50, absoluteY: 320 })
  })
  expect(isGhostPending(DRAGGED.id)).toBe(true)
  expect(boardHidden(DRAGGED.id)).toBe(false) // the drag's own take-off hold: still drawn until its ghost shows
  await act(async () => {
    mockPans[0].onEnd!({ absoluteX: 80, absoluteY: 380 })
  })
  // The drop has applied, but the hold keeps the slot on the dragged card: its ghost is still not on screen.
  expect(boardHidden(DRAGGED.id)).toBe(false)
}

describe('DraggableCard - a drop applied before its drag ghost has painted', () => {
  it("keeps the slot hidden after the ghost shows until the NEXT card's face has painted - not the dragged card's stale bitmap", async () => {
    await render(tree(<Slot nextTop={NEXT} />))
    await flickBeforeTheGhostPaints()
    // The hold's end re-sources the slot's Image to the next card: its face starts loading in that commit.
    const loaded = faceLoading(NEXT.id)
    await act(async () => paintAll())
    expect(isGhostPending(DRAGGED.id)).toBe(false)
    expect(boardHidden(NEXT.id)).toBe(true)
    expect(screen.getByTestId('fallback')).toBeTruthy() // the slot as it looked during the drag
    await act(async () => loaded())
    expect(boardHidden(NEXT.id)).toBe(false)
    expect(screen.queryByTestId('fallback')).toBeNull()
  })

  it('is never left hidden when the slot still draws the dragged card once its ghost shows (a drop that left it on top)', async () => {
    await render(tree(<Slot nextTop={DRAGGED} />))
    await flickBeforeTheGhostPaints()
    await act(async () => paintAll())
    expect(boardHidden(DRAGGED.id)).toBe(false)
  })

  it('a drop applied after the ghost has painted (no hold) waits for the next face the same way', async () => {
    await render(tree(<Slot nextTop={NEXT} />))
    await act(async () => {
      mockPans[0].onStart!({ absoluteX: 50, absoluteY: 320 })
    })
    expect(boardHidden(DRAGGED.id)).toBe(true) // the ghost painted at once: the card is hidden under it
    const loaded = faceLoading(NEXT.id)
    await act(async () => {
      mockPans[0].onEnd!({ absoluteX: 80, absoluteY: 380 })
    })
    expect(boardHidden(NEXT.id)).toBe(true)
    await act(async () => loaded())
    expect(boardHidden(NEXT.id)).toBe(false)
  })
})
