import { CARD_ASPECT, CardSizeProvider } from '@tastic/cards'
import { act, render, screen } from '@testing-library/react-native'
import { ReactNode, useEffect } from 'react'
import { makeMutable, SharedValue } from 'react-native-reanimated'

import { DraggableCard } from '@/components/dragdrop/DraggableCard'
import { DragFlightHandle, DragGhostController, DragGhostProvider, useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { dropSpringFor, FLIGHT_SPRING, SNAP_BACK_SPRING, springSettleMs } from '@/components/dragdrop/dragSpring'
import { PileView } from '@/components/PileView'
import { Card } from '@/engine/types'

// ---------------------------------------------------------------------------------------------------------------------
// The REAL DragGhostProvider (plus the real PileView / DraggableCard driving it), with stand-ins only for what needs native views:
//   - react-native-reanimated: `makeMutable`/`useSharedValue` give values whose `withSpring` assignments really move over (fake) time along
//     Reanimated's own critically damped curve, and `useAnimatedStyle` hands back its worklet so a test can read where a ghost is DRAWN.
//   - react-native-gesture-handler: the pan callbacks are captured, so a test can run a drag (onStart/onUpdate/onEnd) exactly as the UI thread does.
//   - PlayingCard / overlay frame / sounds.
// What it pins is the ghost's lifetime and independence: a flight is retired at springSettleMs (not the bare duration), and a quick next drag from
// the SAME slot/column (which shares the persistent gesture values) can never cut an earlier flight short - both fly to their own landing.
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
  function AnimatedView({ style, children }: { style?: unknown; children?: ReactNode }) {
    const first = (require('react').Children.toArray(children) as { key?: string; props?: { card?: { id: string } } }[])[0]
    const testID = first?.props?.card ? `board:${first.props.card.id}` : first?.key != null ? `ghost:${String(first.key).replace(/^\.\$/, '')}` : undefined
    return (
      <View testID={testID} style={style}>
        {children}
      </View>
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
jest.mock('@/components/PlayingCard', () => {
  const { View } = require('react-native')
  return { PlayingCard: ({ card }: { card: { id: string } }) => <View testID={`card:${card.id}`} />, EmptySlot: () => <View /> }
})
jest.mock('@/components/overlayFrame', () => {
  // toLocal with this frame is the identity on a screen point (the overlay sits at the window origin, unrotated).
  const frame = { rotation: { value: 0 }, cx: { value: 200 }, cy: { value: 400 }, lw: { value: 400 }, lh: { value: 800 } }
  return { useOverlayFrame: () => ({ overlayRef: { current: null }, frame }), toLocal: jest.requireActual('@/components/overlayFrameMath').toLocal }
})
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => mockFeedback }))

// ------------------------------------------------------------------------------------------------ harness

let ghost: DragGhostController
/** Hands the provider's controller to the test (from an effect, like any consumer would reach it). */
function Probe({ onController }: { onController: (controller: DragGhostController) => void }) {
  const controller = useDragGhost()
  useEffect(() => onController(controller), [controller, onController])
  return null
}
const captureGhost = (controller: DragGhostController) => {
  ghost = controller
}
const tree = (children?: ReactNode) => (
  <CardSizeProvider width={64}>
    <DragGhostProvider>
      <Probe onController={captureGhost} />
      {children}
    </DragGhostProvider>
  </CardSizeProvider>
)
async function mountProvider(children?: ReactNode) {
  return render(tree(children))
}
const card = (id: string): Card => ({ id, suit: 'spades', rank: 9, faceUp: true }) as Card
const contentOf = (...cards: Card[]) => ({ cards, offsetStep: 0, cardWidth: 64 })
type Values = { originX: SharedValue<number>; originY: SharedValue<number>; dx: SharedValue<number>; dy: SharedValue<number> }
const persistentValues = (): Values => ({ originX: makeMutable(0), originY: makeMutable(0), dx: makeMutable(0), dy: makeMutable(0) })

/** Runs `fn` inside act(), for anything that reaches React state from outside it (ghost.show/flyTo/hide, a pan callback). */
async function inAct<T>(fn: () => T): Promise<T> {
  let out!: T
  await act(async () => {
    out = fn()
  })
  return out
}
async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms) // also lets the promise chains the timers resolve (a hit test, a drop) run
  })
}
const ghostIds = () =>
  screen
    .queryAllByTestId(/^ghost:/)
    .map((n) => (n.props.testID as string).replace('ghost:', ''))
    .sort()
/** Where every ghost of card `id` is DRAWN (its animated style worklet, evaluated now), in the order the flights started. */
function ghostsAt(id: string) {
  return screen.getAllByTestId(`ghost:${id}`).map((node) => {
    const styles = [node.props.style].flat(Infinity) as { __worklet?: () => { transform: [{ translateX: number }, { translateY: number }] } }[]
    const { transform } = styles.find((s) => s?.__worklet)!.__worklet!()
    return { x: Math.round(transform[0].translateX * 1e6) / 1e6, y: Math.round(transform[1].translateY * 1e6) / 1e6 }
  })
}
const ghostAt = (id: string) => ghostsAt(id)[0]
/** A board card's own view is invisible (its ghost is standing in for it). */
const boardHidden = (id: string) => ([screen.getByTestId(`board:${id}`).props.style].flat(Infinity) as { opacity?: number }[]).some((s) => s?.opacity === 0)
const A = card('spades-9-0')
const B = card('spades-8-0')

beforeEach(() => {
  jest.useFakeTimers()
  mockPans.length = 0
  mockMeasured.x = 10
  mockMeasured.y = 400
  Object.values(mockFeedback).forEach((fn) => fn.mockClear())
})
afterEach(() => {
  jest.useRealTimers()
})

// ------------------------------------------------------------------------------------------------ the provider

// The ghost's container must never lay out as an exactly-zero frame at the overlay's origin: its only children are
// absolutely positioned card wrappers, so without an explicit size it would. That zero frame trips a React Native
// (Fabric, iOS) view-recycling bug that leaves a recycled UIView at its PREVIOUS life's position - see DealLayer.tsx's
// GhostSlot (slotSize) for the full account, where the same shape put a deal's ghosts on the wrong row for a whole deal.
describe('DragGhostProvider - ghost container frame', () => {
  it('gives the ghost container an explicit, non-zero frame sized to the fanned group', async () => {
    await mountProvider()
    await inAct(() => ghost.show({ cards: [A, B], offsetStep: 20, cardWidth: 64 }, { x: 10, y: 20 }))
    const container = screen.getByTestId(`ghost:${A.id}`)
    const style = ([container.props.style].flat(Infinity) as Record<string, unknown>[]).filter(Boolean).reduce((acc, s) => ({ ...acc, ...s }), {})
    expect(style.width).toBe(64)
    // card height (64 / CARD_ASPECT) plus one fan step for the second card
    expect(style.height).toBeCloseTo(64 / CARD_ASPECT + 20, 5)
  })
})

describe('DragGhostProvider - when a flight is settled', () => {
  it('a flight keeps its ghost up until springSettleMs - not the bare duration, which retired it with the card still short of its target', async () => {
    await mountProvider()
    const flight = await inAct(() => ghost.show(contentOf(A), { x: 10, y: 20 }))
    const arrived = jest.fn()
    const config = FLIGHT_SPRING
    await inAct(() => flight.flyTo(310, 20, arrived))
    const settle = springSettleMs(config)

    await advance((config.duration ?? 0) + 1) // the old timer would have fired here
    expect(ghostIds()).toEqual([A.id])
    expect(arrived).not.toHaveBeenCalled()
    expect(Math.abs(ghostAt(A.id).x - 310)).toBeGreaterThan(0.01) // it is still on its way

    await advance(settle - (config.duration ?? 0) - 2)
    expect(ghostIds()).toEqual([A.id])
    expect(Math.abs(ghostAt(A.id).x - 310)).toBeLessThan(1) // and about to land: within a pixel of its target when it goes

    await advance(2)
    expect(ghostIds()).toEqual([])
    expect(arrived).toHaveBeenCalledTimes(1)
  })

  it('every flight takes the same time however far it goes - a short hop and a long flight started together land together', async () => {
    await mountProvider()
    const near = await inAct(() => ghost.show(contentOf(A), { x: 10, y: 20 }))
    const far = await inAct(() => ghost.show(contentOf(B), { x: 10, y: 20 }))
    const nearArrived = jest.fn()
    const farArrived = jest.fn()
    await inAct(() => {
      near.flyTo(40, 20, nearArrived) // a 30px hop
      far.flyTo(810, 20, farArrived) // and an 800px flight
    })

    await advance(springSettleMs(FLIGHT_SPRING) - 1)
    expect(nearArrived).not.toHaveBeenCalled()
    expect(farArrived).not.toHaveBeenCalled()
    await advance(1)
    expect(nearArrived).toHaveBeenCalledTimes(1)
    expect(farArrived).toHaveBeenCalledTimes(1)
  })

  it("a drag's drop is the exception: it only settles the distance the finger left, so a well-aimed one hands over well before a flight would", async () => {
    await mountProvider()
    const values = persistentValues()
    const drop = await inAct(() => ghost.showLive(contentOf(A), values))
    values.originX.value = 10
    values.originY.value = 20
    values.dx.value = 290 // carried to (300, 20) - 10px short of its spot
    const arrived = jest.fn()
    await inAct(() => {
      drop.release()
      drop.flyTo(310, 20, arrived)
    })
    const settle = springSettleMs(dropSpringFor(10))
    expect(settle).toBeLessThan(springSettleMs(FLIGHT_SPRING))

    await advance(settle - 1)
    expect(arrived).not.toHaveBeenCalled()
    await advance(1)
    expect(arrived).toHaveBeenCalledTimes(1)
  })

  it('a flight started in the very stretch that shows its ghost starts moving - and its settle clock starts - only once the ghost is mounted, so it never first appears partway along its path', async () => {
    await mountProvider()
    const arrived = jest.fn()
    const config = FLIGHT_SPRING
    let flight!: DragFlightHandle
    await act(async () => {
      flight = ghost.show(contentOf(A), { x: 10, y: 20 })
      flight.flyTo(310, 20, arrived) // the screen's own re-render (and the ghost's mount) are still ahead...
      jest.advanceTimersByTime(120) // ...and that commit is slow: 120ms pass before it lands
    })
    expect(ghostAt(A.id)).toEqual({ x: 10, y: 20 }) // it appears at its origin, not 120ms into its flight

    await advance(springSettleMs(config) - 1)
    expect(arrived).not.toHaveBeenCalled() // the settle clock started at the mount, not at flyTo
    expect(ghostAt(A.id).x).toBeGreaterThan(300) // and by then it has flown its whole way
    await advance(1)
    expect(arrived).toHaveBeenCalledTimes(1)
    expect(ghostIds()).toEqual([])
  })

  it('a flight hidden before its ghost ever mounted still reports its arrival once, and never animates afterwards', async () => {
    await mountProvider()
    const arrived = jest.fn()
    await act(async () => {
      const flight = ghost.show(contentOf(A), { x: 10, y: 20 })
      flight.flyTo(310, 20, arrived)
      flight.hide()
    })
    expect(arrived).toHaveBeenCalledTimes(1) // hide() flushes the pending arrival, as ever
    expect(ghostIds()).toEqual([])
    await advance(3000)
    expect(arrived).toHaveBeenCalledTimes(1)
  })

  it('a snap-back settles at springSettleMs of SNAP_BACK_SPRING, then plays the invalid feedback once and reveals the source', async () => {
    await mountProvider()
    const values = persistentValues()
    const flight = await inAct(() => ghost.showLive(contentOf(A), values))
    values.originX.value = 10
    values.originY.value = 20
    values.dx.value = 80
    values.dy.value = 120
    const settled = jest.fn()
    await inAct(() => flight.snapBack(settled))

    await advance((SNAP_BACK_SPRING.duration ?? 0) + 1)
    expect(settled).not.toHaveBeenCalled()
    expect(ghostIds()).toEqual([A.id])
    await advance(springSettleMs(SNAP_BACK_SPRING) - (SNAP_BACK_SPRING.duration ?? 0))
    expect(settled).toHaveBeenCalledTimes(1)
    expect(mockFeedback.playInvalidSound).toHaveBeenCalledTimes(1)
    expect(mockFeedback.hapticInvalid).toHaveBeenCalledTimes(1)
    expect(ghostIds()).toEqual([])
  })

  it('hide() retires the ghost and runs its pending arrival once, at once - the timer then does not run it again', async () => {
    await mountProvider()
    const flight = await inAct(() => ghost.show(contentOf(A), { x: 0, y: 0 }))
    const arrived = jest.fn()
    await inAct(() => flight.flyTo(200, 0, arrived))
    await inAct(() => flight.hide())
    expect(ghostIds()).toEqual([])
    expect(arrived).toHaveBeenCalledTimes(1)
    await advance(2000)
    expect(arrived).toHaveBeenCalledTimes(1)
  })
})

describe('DragGhostProvider - a drag ghost and its persistent gesture values', () => {
  it('follows the persistent values while the drag is in progress, then keeps its position on values of its own once released - with no remount', async () => {
    await mountProvider()
    const values = persistentValues()
    const flight = await inAct(() => ghost.showLive(contentOf(A), values))
    values.originX.value = 50
    values.originY.value = 60
    values.dx.value = 7
    values.dy.value = 9
    expect(ghostAt(A.id)).toEqual({ x: 57, y: 69 })

    const before = screen.getByTestId(`ghost:${A.id}`)
    await inAct(() => flight.release())
    expect(screen.getByTestId(`ghost:${A.id}`)).toBe(before) // the same mounted view: nothing was torn down and rebuilt (no seam)
    expect(ghostAt(A.id)).toEqual({ x: 57, y: 69 })

    // A later drag from the same source writes the persistent values (its worklet's onStart) - the released ghost does not care.
    values.originX.value = 500
    values.dx.value = -300
    values.dy.value = 40
    expect(ghostAt(A.id)).toEqual({ x: 57, y: 69 })
    // ...and the handle answers with the ghost's own position (Pyramid reads it to hand a dragged card on).
    expect(flight.originX.value + flight.dx.value).toBe(57)
    expect(flight.originY.value + flight.dy.value).toBe(69)
  })

  it('release() twice, or before a flyTo that would do it anyway, changes nothing', async () => {
    await mountProvider()
    const values = persistentValues()
    const flight = await inAct(() => ghost.showLive(contentOf(A), values))
    values.originX.value = 10
    values.originY.value = 20
    values.dx.value = 30
    values.dy.value = 60
    await inAct(() => {
      flight.release()
      flight.release()
    })
    expect(ghostAt(A.id)).toEqual({ x: 40, y: 80 })

    // flyTo with no explicit release does the hand-off itself, from the position the drag left it at.
    const other = persistentValues()
    const flight2 = await inAct(() => ghost.showLive(contentOf(B), other))
    other.originX.value = 100
    other.originY.value = 100
    other.dx.value = 5
    other.dy.value = 5
    await inAct(() => flight2.flyTo(400, 100, jest.fn()))
    other.dx.value = 999 // a stale write to the persistent values
    expect(ghostAt(B.id).x).toBeLessThan(400)
    expect(ghostAt(B.id).x).toBeGreaterThanOrEqual(105)
  })

  it('a quick next drag from the SAME source never cuts the earlier flight short: both ghosts fly to their own landing, each arrival fires once, at its own time', async () => {
    await mountProvider()
    const values = persistentValues()

    // Drag 1: carried to (40, 80), dropped, and its ghost flies on to (300, 400) once the destination has been measured.
    const first = await inAct(() => ghost.showLive(contentOf(A), values))
    values.originX.value = 10
    values.originY.value = 20
    values.dx.value = 30
    values.dy.value = 60
    const arrivedFirst = jest.fn()
    await inAct(() => {
      first.release() // what PileView/DraggableCard do the instant the drag ends
      first.flyTo(300, 400, arrivedFirst)
    })
    const settleFirst = springSettleMs(dropSpringFor(Math.hypot(260, 320)))

    // 40ms later the player grabs the next card from the same column/slot: its worklet re-seeds the SAME persistent values, then showLive.
    await advance(40)
    values.originX.value = 12
    values.originY.value = 24
    values.dx.value = 0
    values.dy.value = 0
    const second = await inAct(() => ghost.showLive(contentOf(B), values))
    values.dx.value = 5
    values.dy.value = 8

    expect(ghostIds()).toEqual([A.id, B.id].sort()) // the first ghost was NOT retired by the second drag's claim
    expect(arrivedFirst).not.toHaveBeenCalled()
    expect(ghostAt(B.id)).toEqual({ x: 17, y: 32 }) // the second follows the persistent values, as ever
    const firstNow = ghostAt(A.id)
    expect(firstNow.x).toBeGreaterThan(40) // the first is on its OWN path from (40, 80) toward (300, 400)...
    expect(firstNow.y).toBeGreaterThan(80)
    expect(firstNow).not.toEqual({ x: 17, y: 32 }) // ...not dragged onto the second drag's position

    const arrivedSecond = jest.fn()
    await advance(60)
    await inAct(() => {
      second.release()
      second.flyTo(50, 300, arrivedSecond)
    })
    const secondStartedAt = 100

    // Each lands exactly when ITS OWN timer says, whatever the other is doing.
    const landings: [number, jest.Mock][] = [
      [settleFirst, arrivedFirst],
      [secondStartedAt + springSettleMs(dropSpringFor(Math.hypot(50 - 17, 300 - 32))), arrivedSecond]
    ]
    landings.sort((a, b) => a[0] - b[0])
    let now = secondStartedAt
    for (const [at, arrived] of landings) {
      await advance(at - now - 1)
      expect(arrived).not.toHaveBeenCalled()
      await advance(1)
      expect(arrived).toHaveBeenCalledTimes(1)
      now = at
    }
    expect(ghostIds()).toEqual([])
    await advance(3000)
    expect(arrivedFirst).toHaveBeenCalledTimes(1)
    expect(arrivedSecond).toHaveBeenCalledTimes(1)
  })

  it('a snap-back in progress IS ended by picking the same source up again: its settle runs at once (revealing the source) and never runs a second time', async () => {
    await mountProvider()
    const values = persistentValues()
    const first = await inAct(() => ghost.showLive(contentOf(A), values))
    values.originX.value = 10
    values.originY.value = 20
    values.dx.value = 80
    values.dy.value = 120
    const settledFirst = jest.fn()
    await inAct(() => first.snapBack(settledFirst))
    await advance(100)
    expect(settledFirst).not.toHaveBeenCalled()

    await inAct(() => ghost.showLive(contentOf(B), values))
    expect(settledFirst).toHaveBeenCalledTimes(1) // ended by the pick-up, before the new drag hides the source
    expect(ghostIds()).toEqual([B.id])
    await advance(2000)
    expect(settledFirst).toHaveBeenCalledTimes(1)
  })

  it('a drag that never released (its end never arrived) is still cut by the next claim on its values', async () => {
    await mountProvider()
    const values = persistentValues()
    await inAct(() => ghost.showLive(contentOf(A), values))
    await inAct(() => ghost.showLive(contentOf(B), values))
    expect(ghostIds()).toEqual([B.id])
  })
})

// ------------------------------------------------------------------------------------------------ PileView + DraggableCard driving it

const PILE = [9, 8, 7, 6, 5].map((rank) => ({ id: `spades-${rank}-0`, suit: 'spades', rank, faceUp: true }) as Card)
const TOP = PILE[4]
const SECOND = PILE[3]
const HIT_MS = 20

interface DropCall {
  count: number
  anchorCardId: string
  flight: DragFlightHandle
}
function pileWith(drops: DropCall[], hit: () => { zone: string; index: number } | null = () => ({ zone: 'tableau', index: 1 }), cards: Card[] = PILE) {
  const drag = {
    registry: { hitTest: () => new Promise((resolve) => setTimeout(() => resolve(hit()), HIT_MS)) },
    getRunCount: () => 1,
    onDrop: async (_to: unknown, count: number, anchorCardId: string, flight: DragFlightHandle) => {
      drops.push({ count, anchorCardId, flight })
      return true
    }
  }
  return <PileView cards={cards} drag={drag as never} onPressCard={() => {}} />
}
/** Runs a drag of the pile's card `index` as the UI thread does: onStart (re-seeds the persistent values), moves, onEnd. */
async function dragCard(index: number, from: { x: number; y: number }, by: { dx: number; dy: number }, end = true) {
  mockMeasured.x = from.x
  mockMeasured.y = from.y
  await act(async () => {
    mockPans[index].onStart!({ absoluteX: 100, absoluteY: 500 })
  })
  await act(async () => {
    mockPans[index].onUpdate!({ absoluteX: 100 + by.dx, absoluteY: 500 + by.dy })
  })
  if (end)
    await act(async () => {
      mockPans[index].onEnd!({ absoluteX: 100 + by.dx, absoluteY: 500 + by.dy })
    })
}

describe('PileView - rapid drags from one column', () => {
  it("the next card grabbed from the column while the last one's flight is still in the air does not cut it short: both fly to their own landing", async () => {
    const drops: DropCall[] = []
    const { rerender } = await mountProvider(pileWith(drops))
    expect(mockPans).toHaveLength(5)

    // Drag 1: the top card, carried to (40, 460), dropped and applied; the screen commits the move (the card leaves the column) and flies its ghost on.
    await dragCard(4, { x: 10, y: 400 }, { dx: 30, dy: 60 })
    await advance(HIT_MS)
    expect(drops).toHaveLength(1)
    const arrivedFirst = jest.fn()
    await inAct(() => drops[0].flight.flyTo(300, 700, arrivedFirst))
    await rerender(tree(pileWith(drops, undefined, PILE.slice(0, 4))))

    // Drag 2: 40ms later, the card that is now on top of the SAME column. Its worklet re-seeds the persistent values (dx back to 0, a new origin)...
    await advance(40)
    await dragCard(3, { x: 10, y: 340 }, { dx: 3, dy: 4 }, false)
    expect(ghostIds()).toEqual([SECOND.id, TOP.id].sort()) // ...and the first ghost is still up
    expect(arrivedFirst).not.toHaveBeenCalled()
    expect(ghostAt(SECOND.id)).toEqual({ x: 13, y: 344 }) // the second follows the finger
    expect(ghostAt(TOP.id).x).toBeGreaterThan(40) // the first is on its OWN path from (40, 460) toward (300, 700)
    expect(ghostAt(TOP.id).y).toBeGreaterThan(460)
    expect(ghostAt(TOP.id)).not.toEqual({ x: 13, y: 344 })

    // Drag 2 is dropped too; both ghosts then fly to their own landing, each arrival firing exactly once.
    await act(async () => {
      mockPans[3].onEnd!({ absoluteX: 103, absoluteY: 504 })
    })
    await advance(HIT_MS)
    expect(drops).toHaveLength(2)
    expect(drops[1].anchorCardId).toBe(SECOND.id)
    const arrivedSecond = jest.fn()
    await inAct(() => drops[1].flight.flyTo(200, 650, arrivedSecond))
    expect(ghostIds()).toEqual([SECOND.id, TOP.id].sort())

    await advance(3000)
    expect(arrivedFirst).toHaveBeenCalledTimes(1)
    expect(arrivedSecond).toHaveBeenCalledTimes(1)
    expect(ghostIds()).toEqual([])
  })

  it("a card grabbed again while its last drop is still resolving: the drop is applied with the FIRST drag's own ghost (position and all), neither ghost is cut, and the late 'applied' does not reveal the card under the new drag", async () => {
    const drops: DropCall[] = []
    await mountProvider(pileWith(drops))

    // Drag 1: the top card, carried to (40, 460) and released; the hit test is still resolving.
    await dragCard(4, { x: 10, y: 400 }, { dx: 30, dy: 60 })
    expect(ghostsAt(TOP.id)).toEqual([{ x: 40, y: 460 }])
    expect(boardHidden(TOP.id)).toBe(true)

    // Drag 2 begins 5ms later on the same card: its worklet re-seeds the persistent values under the first, released ghost.
    await advance(5)
    await dragCard(4, { x: 10, y: 400 }, { dx: 3, dy: 4 }, false)
    expect(ghostsAt(TOP.id)).toEqual([
      { x: 40, y: 460 }, // the first ghost did not move...
      { x: 13, y: 404 } // ...and the second follows the finger
    ])

    // The first drop resolves: applied, and with the FIRST drag's ghost - not whatever the column's latest drag is.
    await advance(HIT_MS)
    expect(drops).toHaveLength(1)
    expect(drops[0].flight.originX.value + drops[0].flight.dx.value).toBe(40)
    expect(drops[0].flight.originY.value + drops[0].flight.dy.value).toBe(460)
    expect(boardHidden(TOP.id)).toBe(true) // the card the SECOND drag holds stays hidden: the first drop's late outcome is not the second's
    expect(ghostsAt(TOP.id)).toHaveLength(2)

    const arrivedFirst = jest.fn()
    await inAct(() => drops[0].flight.flyTo(300, 700, arrivedFirst))
    await act(async () => {
      mockPans[4].onEnd!({ absoluteX: 103, absoluteY: 504 })
    })
    await advance(HIT_MS)
    expect(drops).toHaveLength(2)
    expect(drops[1].flight).not.toBe(drops[0].flight)
    expect(drops[1].flight.originX.value + drops[1].flight.dx.value).toBe(13)
    const arrivedSecond = jest.fn()
    await inAct(() => drops[1].flight.flyTo(200, 650, arrivedSecond))
    await advance(3000)
    expect(arrivedFirst).toHaveBeenCalledTimes(1)
    expect(arrivedSecond).toHaveBeenCalledTimes(1)
    expect(ghostIds()).toEqual([])
    expect(boardHidden(TOP.id)).toBe(false) // the second drag's own (applied) outcome cleared its own hiding
  })

  it('a drag re-grabbed while its snap-back is returning ends that ghost at once and stays hidden under the NEW drag - the old return never reveals the card mid-drag', async () => {
    const drops: DropCall[] = []
    await mountProvider(pileWith(drops, () => null)) // nowhere to drop: every release snaps back
    await dragCard(4, { x: 10, y: 400 }, { dx: 30, dy: 60 })
    await advance(HIT_MS + 30) // the hit test finds no target: the ghost is on its way back
    expect(ghostIds()).toEqual([TOP.id])
    expect(boardHidden(TOP.id)).toBe(true)

    await dragCard(4, { x: 10, y: 400 }, { dx: 5, dy: 5 }, false) // picked up again
    expect(ghostIds()).toEqual([TOP.id]) // ONE ghost: the returning one was ended by the pick-up
    expect(boardHidden(TOP.id)).toBe(true)
    await advance(2000) // long past the old return's own settle time
    expect(boardHidden(TOP.id)).toBe(true) // the new drag is still in progress: the stale settle did not reveal the card
    expect(ghostAt(TOP.id)).toEqual({ x: 15, y: 405 })
  })

  it('a snap-back that only begins after the next drag has started (the last release was still finding its target) does not reveal the card under the new drag when it lands', async () => {
    const drops: DropCall[] = []
    await mountProvider(pileWith(drops, () => null)) // no target: the first release will snap back - but only once its hit test resolves
    await dragCard(4, { x: 10, y: 400 }, { dx: 30, dy: 60 })
    await advance(5)
    await dragCard(4, { x: 10, y: 400 }, { dx: 3, dy: 4 }, false) // grabbed again inside the hit test
    expect(ghostsAt(TOP.id)).toHaveLength(2)

    await advance(HIT_MS) // the first hit test comes back empty: its ghost starts returning...
    await advance(springSettleMs(SNAP_BACK_SPRING) + 50) // ...and lands
    expect(ghostsAt(TOP.id)).toEqual([{ x: 13, y: 404 }]) // only the second drag's ghost is left, still following the finger
    expect(boardHidden(TOP.id)).toBe(true) // and the returning ghost's landing did not un-hide the card the second drag is holding
  })

  it('a plain drag is unchanged: the ghost tracks the finger, an invalid drop snaps it back, a valid one hands the same ghost to onDrop', async () => {
    const drops: DropCall[] = []
    let target: { zone: string; index: number } | null = null
    await mountProvider(pileWith(drops, () => target))

    await dragCard(4, { x: 10, y: 400 }, { dx: 30, dy: 60 }, false)
    expect(ghostAt(TOP.id)).toEqual({ x: 40, y: 460 })
    await act(async () => {
      mockPans[4].onUpdate!({ absoluteX: 160, absoluteY: 620 })
    })
    expect(ghostAt(TOP.id)).toEqual({ x: 70, y: 520 }) // still the persistent values while the finger is down

    await act(async () => {
      mockPans[4].onEnd!({ absoluteX: 160, absoluteY: 620 })
    })
    await advance(HIT_MS)
    expect(drops).toHaveLength(0) // no target
    await advance(springSettleMs(SNAP_BACK_SPRING))
    expect(ghostIds()).toEqual([])
    expect(boardHidden(TOP.id)).toBe(false) // snapped back, source revealed
    expect(mockFeedback.playInvalidSound).toHaveBeenCalledTimes(1)

    target = { zone: 'tableau', index: 2 }
    await dragCard(4, { x: 10, y: 400 }, { dx: 30, dy: 60 })
    await advance(HIT_MS)
    expect(drops).toHaveLength(1)
    expect(drops[0].flight.originX.value + drops[0].flight.dx.value).toBe(40)
    expect(boardHidden(TOP.id)).toBe(false) // an applied drop lets the column reveal (the screen's own move takes the card away)
    expect(ghostIds()).toEqual([TOP.id]) // ...while the ghost stays up for the screen to fly
    await inAct(() => drops[0].flight.hide())
    expect(ghostIds()).toEqual([])
  })
})

describe('DraggableCard - rapid drags from one slot', () => {
  const SLOT_CARD = card('hearts-4-0')

  it("a slow drop that resolves after the next drag has begun applies with the first drag's own ghost, leaves that ghost flying, and does not un-hide the card under the new drag", async () => {
    const flights: DragFlightHandle[] = []
    const resolvers: (() => void)[] = []
    const onDrop = (_x: number, _y: number, flight: DragFlightHandle) => {
      flights.push(flight)
      return new Promise<boolean>((resolve) => resolvers.push(() => resolve(true))) // a drop that takes a while (a deferral, a measurement)
    }
    await mountProvider(<DraggableCard card={SLOT_CARD} onDrop={onDrop} />)
    expect(mockPans).toHaveLength(1)

    mockMeasured.x = 20
    mockMeasured.y = 300
    await act(async () => {
      mockPans[0].onStart!({ absoluteX: 50, absoluteY: 320 })
    })
    await act(async () => {
      mockPans[0].onUpdate!({ absoluteX: 80, absoluteY: 380 })
    })
    await act(async () => {
      mockPans[0].onEnd!({ absoluteX: 80, absoluteY: 380 })
    })
    expect(ghostsAt(SLOT_CARD.id)).toEqual([{ x: 50, y: 360 }])

    // The player grabs the card again while the first drop is still pending.
    await advance(30)
    await act(async () => {
      mockPans[0].onStart!({ absoluteX: 50, absoluteY: 320 })
    })
    await act(async () => {
      mockPans[0].onUpdate!({ absoluteX: 55, absoluteY: 325 })
    })
    expect(ghostsAt(SLOT_CARD.id)).toEqual([
      { x: 50, y: 360 }, // the first was not cut by the second's claim, nor moved by its writes
      { x: 25, y: 305 }
    ])
    expect(boardHidden(SLOT_CARD.id)).toBe(true)

    // The first drop resolves as applied: it must not reveal the card the SECOND drag is holding.
    await act(async () => {
      resolvers[0]()
    })
    expect(boardHidden(SLOT_CARD.id)).toBe(true)
    expect(flights).toHaveLength(1)
    expect(flights[0].originX.value + flights[0].dx.value).toBe(50) // its own position, not the new drag's
    const arrived = jest.fn()
    await inAct(() => flights[0].flyTo(300, 100, arrived))
    await advance(3000)
    expect(arrived).toHaveBeenCalledTimes(1)
    expect(ghostsAt(SLOT_CARD.id)).toEqual([{ x: 25, y: 305 }]) // only the second drag's ghost remains
  })
})
