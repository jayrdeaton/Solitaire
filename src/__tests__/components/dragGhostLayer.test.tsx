import { CARD_ASPECT, CardSizeProvider, faceUpFanOffset } from '@tastic/cards'
import { act, render, screen } from '@testing-library/react-native'
import { ReactNode, useEffect } from 'react'
import { makeMutable, SharedValue } from 'react-native-reanimated'

import { GHOST_PAINT_MAX_MS, isGhostPending, markGhostPending, trackFaceLoad } from '@/components/cardFacePaint'
import { columnTops } from '@/components/columnTops'
import { DraggableCard } from '@/components/dragdrop/DraggableCard'
import { DragFlightHandle, DragGhostController, DragGhostProvider, LANDED_GHOST_MAX_MS, useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { dropSpringFor, FLIGHT_SPRING, SNAP_BACK_SPRING, springSettleMs } from '@/components/dragdrop/dragSpring'
import { clearFanTop, setFanTop } from '@/components/dragdrop/fanTops'
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
const mockPans: { onStart?: (e: { absoluteX: number; absoluteY: number }) => void; onUpdate?: (e: { absoluteX: number; absoluteY: number }) => void; onEnd?: (e: { absoluteX: number; absoluteY: number }) => void; enabled?: boolean }[] = []
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
  // A fanned ghost's own cards are animated views too (each carries its fan step): tagged `fan:` rather than `board:`.
  const InGhost = require('react').createContext(false)
  function AnimatedView({ style, children }: { style?: unknown; children?: ReactNode }) {
    const inGhost = require('react').useContext(InGhost)
    const first = (require('react').Children.toArray(children) as { key?: string; props?: { card?: { id: string } } }[])[0]
    const isGhost = !first?.props?.card && first?.key != null
    const testID = first?.props?.card ? `${inGhost ? 'fan' : 'board'}:${first.props.card.id}` : isGhost && !inGhost ? `ghost:${String(first.key).replace(/^\.\$/, '')}` : undefined
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
      enabled: (on: boolean) => {
        handlers.enabled = on
        return g
      },
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
const mockPaint = { defer: false, waiting: [] as (() => void)[], mounts: {} as Record<string, number> }
jest.mock('@/components/PlayingCard', () => {
  const { View } = require('react-native')
  const { useEffect: useMockEffect } = require('react')
  function MockPlayingCard({ card, onFacePainted }: { card: { id: string }; onFacePainted?: () => void }) {
    useMockEffect(() => {
      mockPaint.mounts[card.id] = (mockPaint.mounts[card.id] ?? 0) + 1
    }, [card.id])
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
  mockPaint.defer = false
  mockPaint.waiting.length = 0
  for (const key of Object.keys(mockPaint.mounts)) delete mockPaint.mounts[key]
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

// The real card a ghost lands on is revealed in the settle's commit, and its face is an Image whose bitmap React Native
// delivers asynchronously - often a frame or two after the view appears, a blank face until then (cardFacePaint.ts). So
// a landed ghost stays over the card until its face has painted. Here a board face "loading" is trackFaceLoad, called
// from the arrival (the commit the real card mounts in), and "loaded" is calling what it returns.
describe('DragGhostProvider - a landed ghost waits for the card under it to paint', () => {
  // The registry is module-level: whatever a test leaves loading would hold back every later landing of that card.
  const loadingFaces: (() => void)[] = []
  const faceLoading = (id: string) => {
    const done = trackFaceLoad(id)
    loadingFaces.push(done)
    return done
  }
  afterEach(() => loadingFaces.splice(0).forEach((done) => done()))

  async function landWithFaceLoading(id: Card, at: { x: number; y: number }) {
    const flight = await inAct(() => ghost.show(contentOf(id), { x: 0, y: 0 }))
    let loaded!: () => void
    const arrived = jest.fn(() => {
      loaded = faceLoading(id.id)
    })
    await inAct(() => flight.flyTo(at.x, at.y, arrived))
    await advance(springSettleMs(FLIGHT_SPRING))
    return { arrived, loaded: () => loaded() }
  }

  it('stays over the revealed card while its face is still loading, and goes the moment it has loaded', async () => {
    await mountProvider()
    const { arrived, loaded } = await landWithFaceLoading(A, { x: 200, y: 0 })
    expect(arrived).toHaveBeenCalledTimes(1) // the real card was revealed at the settle, as before
    expect(ghostIds()).toEqual([A.id]) // but its face is not there yet: the ghost still covers it
    await inAct(() => loaded())
    expect(ghostIds()).toEqual([])
  })

  it('goes at the settle, as before, when nothing under it is loading', async () => {
    await mountProvider()
    const flight = await inAct(() => ghost.show(contentOf(A), { x: 0, y: 0 }))
    await inAct(() => flight.flyTo(200, 0, () => {}))
    await advance(springSettleMs(FLIGHT_SPRING))
    expect(ghostIds()).toEqual([])
  })

  it('waits no longer than LANDED_GHOST_MAX_MS for a face that never reports', async () => {
    await mountProvider()
    const { loaded } = await landWithFaceLoading(A, { x: 200, y: 0 })
    await advance(LANDED_GHOST_MAX_MS - 1)
    expect(ghostIds()).toEqual([A.id])
    await advance(1)
    expect(ghostIds()).toEqual([])
    loaded()
  })

  it('a new flight of the same card ends the wait at once - the card is leaving that spot, and must not be drawn there too', async () => {
    await mountProvider()
    const { loaded } = await landWithFaceLoading(A, { x: 200, y: 0 })
    await inAct(() => ghost.show(contentOf(A), { x: 200, y: 0 }))
    expect(ghostsAt(A.id)).toHaveLength(1) // only the new flight's ghost
    loaded()
  })

  it('a card landing on the spot of a ghost still waiting there retires it - it would otherwise be drawn over the newer card', async () => {
    await mountProvider()
    const { loaded } = await landWithFaceLoading(A, { x: 200, y: 0 })
    const next = await inAct(() => ghost.show(contentOf(B), { x: 0, y: 300 }))
    await inAct(() => next.flyTo(200, 10, () => {}))
    await advance(springSettleMs(FLIGHT_SPRING))
    expect(ghostIds()).toEqual([])
    loaded()
  })

  it('a ghost waiting elsewhere is left alone by a landing that does not overlap it', async () => {
    await mountProvider()
    const first = await inAct(() => ghost.show(contentOf(A), { x: 0, y: 0 }))
    let loaded!: () => void
    await inAct(() => first.flyTo(200, 0, () => (loaded = faceLoading(A.id))))
    const next = await inAct(() => ghost.show(contentOf(B), { x: 0, y: 300 }))
    await advance(100)
    await inAct(() => next.flyTo(0, 500, () => {}))
    await advance(springSettleMs(FLIGHT_SPRING) - 100) // A lands, its face still loading
    expect(ghostIds()).toEqual([A.id, B.id].sort())
    await advance(100) // B lands far from A, well inside A's wait
    expect(ghostIds()).toEqual([A.id])
    await inAct(() => loaded())
    expect(ghostIds()).toEqual([])
  })
})

// The take-off side (cardFacePaint.ts): a ghost is a fresh Image too, blank for a frame or two, so it stays invisible -
// and its flight does not start - until its face has painted, while its source keeps drawing the card (a ghost-pending
// hold, released in the commit the ghost shows).
describe('DragGhostProvider - a new ghost shows only once its face has painted', () => {
  const opacityOf = (id: string) => ([screen.getByTestId(`ghost:${id}`).props.style].flat(Infinity) as { opacity?: number }[]).reduce((o, st) => (st && st.opacity !== undefined ? st.opacity : o), 1)
  const paintAll = () => mockPaint.waiting.splice(0).forEach((painted) => painted())

  it('is invisible, does not move, and holds its source until its face has painted - then shows, releases the hold and flies', async () => {
    mockPaint.defer = true
    await mountProvider()
    const flight = await inAct(() => ghost.show(contentOf(A), { x: 10, y: 20 }))
    const arrived = jest.fn()
    await inAct(() => flight.flyTo(310, 20, arrived))
    expect(opacityOf(A.id)).toBe(0)
    expect(isGhostPending(A.id)).toBe(true)
    await advance(50)
    expect(ghostAt(A.id)).toEqual({ x: 10, y: 20 }) // not on its way yet
    await inAct(() => paintAll())
    expect(opacityOf(A.id)).toBe(1)
    expect(isGhostPending(A.id)).toBe(false)
    await advance(springSettleMs(FLIGHT_SPRING)) // its settle clock started when it showed
    expect(arrived).toHaveBeenCalledTimes(1)
  })

  it('shows (and flies) anyway after GHOST_PAINT_MAX_MS if its face never reports', async () => {
    mockPaint.defer = true
    await mountProvider()
    const flight = await inAct(() => ghost.show(contentOf(A), { x: 10, y: 20 }))
    await inAct(() => flight.flyTo(310, 20, () => {}))
    await advance(GHOST_PAINT_MAX_MS)
    expect(opacityOf(A.id)).toBe(1)
    expect(isGhostPending(A.id)).toBe(false)
  })

  it('hide() before the ghost ever showed releases the hold - the source must not keep drawing a card that has gone', async () => {
    mockPaint.defer = true
    await mountProvider()
    const flight = await inAct(() => ghost.show(contentOf(A), { x: 0, y: 0 }))
    expect(isGhostPending(A.id)).toBe(true)
    await inAct(() => flight.hide())
    expect(isGhostPending(A.id)).toBe(false)
  })

  it("a new flight of exactly a landed ghost's cards carries on with that (painted) ghost: no fresh mount, no hold, on screen at once", async () => {
    await mountProvider()
    const first = await inAct(() => ghost.show(contentOf(A), { x: 0, y: 0 }))
    let loaded!: () => void
    await inAct(() => first.flyTo(200, 0, () => (loaded = trackFaceLoad(A.id))))
    await advance(springSettleMs(FLIGHT_SPRING)) // landed, waiting for the board face
    const mountsBefore = mockPaint.mounts[A.id]
    mockPaint.defer = true // a fresh ghost would now stay invisible
    const again = await inAct(() => ghost.show(contentOf(A), { x: 200, y: 0 }))
    expect(isGhostPending(A.id)).toBe(false)
    expect(mockPaint.mounts[A.id]).toBe(mountsBefore)
    expect(ghostIds()).toEqual([A.id])
    expect(opacityOf(A.id)).toBe(1)
    const arrived = jest.fn()
    await inAct(() => again.flyTo(0, 300, arrived))
    await advance(springSettleMs(FLIGHT_SPRING))
    expect(arrived).toHaveBeenCalledTimes(1)
    await inAct(() => loaded())
  })

  it('a landed ghost stays while its card is taking off again with a ghost not on screen yet (it is the only painted copy), and goes once that one shows', async () => {
    await mountProvider()
    const flight = await inAct(() => ghost.show(contentOf(A), { x: 0, y: 0 }))
    await inAct(() => flight.flyTo(200, 0, () => {}))
    const elsewhere = markGhostPending([A.id]) // e.g. Spider sweeping the run this card just completed
    await advance(springSettleMs(FLIGHT_SPRING))
    expect(ghostIds()).toEqual([A.id])
    await inAct(() => elsewhere())
    expect(ghostIds()).toEqual([])
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

// A tap on a card whose run reaches into cards still flying in to its column sends them on from mid-air (games/shared/inAirRun.ts), but a
// drag's ghost follows the finger, with nothing to hand those cards to: it used to pick the whole run up, drawing the cards in the air twice.
describe('PileView - a run still landing on its column', () => {
  const runDrag = { registry: { hitTest: async () => null }, getRunCount: (indexFromTop: number) => indexFromTop + 1, onDrop: async () => false }
  const LANDING = card('spades-4-0')

  it('can not be picked up by a drag until all of it has landed', async () => {
    const { rerender } = await mountProvider(<PileView cards={PILE} drag={runDrag as never} hiddenCount={2} onPressCard={() => {}} />)
    expect(mockPans).toHaveLength(3) // the two cards still in the air are only their landing spots
    expect(mockPans.map((p) => p.enabled)).toEqual([false, false, false])

    await rerender(tree(<PileView cards={PILE} drag={runDrag as never} onPressCard={() => {}} />))
    expect(mockPans.map((p) => p.enabled)).toEqual([true, true, true, true, true])
  })

  it('a drag already under way is never cut off by a card starting to land on its column', async () => {
    const { rerender } = await mountProvider(<PileView cards={PILE} drag={runDrag as never} onPressCard={() => {}} />)
    await dragCard(3, { x: 10, y: 340 }, { dx: 3, dy: 4 }, false) // the 6 and the 5
    await rerender(tree(<PileView cards={[...PILE, LANDING]} drag={runDrag as never} hiddenCount={1} onPressCard={() => {}} />))
    expect(mockPans.map((p) => p.enabled)).toEqual([false, false, false, true, true])
  })
})

describe('DraggableCard - rapid drags from one slot', () => {
  const SLOT_CARD = card('hearts-4-0')

  it("an applied drop keeps the slot as it looked during the drag until the NEXT card's face has painted - not the dragged card's stale bitmap", async () => {
    const NEXT = card('hearts-3-0')
    const onDrop = async () => true
    const view = await mountProvider(<DraggableCard card={SLOT_CARD} onDrop={onDrop} />)
    await act(async () => {
      mockPans[0].onStart!({ absoluteX: 50, absoluteY: 320 })
    })
    expect(boardHidden(SLOT_CARD.id)).toBe(true)
    // The drop applies: the slot now shows the next card - the same Image re-sourced, its bitmap still loading.
    const loaded = trackFaceLoad(NEXT.id)
    await view.rerender(tree(<DraggableCard card={NEXT} onDrop={onDrop} />))
    await act(async () => {
      mockPans[0].onEnd!({ absoluteX: 80, absoluteY: 380 })
    })
    expect(boardHidden(NEXT.id)).toBe(true)
    await act(async () => loaded())
    expect(boardHidden(NEXT.id)).toBe(false)
  })

  it('a re-grab of a card whose snap-back is still returning carries on with that (painted) ghost: no fresh mount, no hold', async () => {
    const onDrop = async () => false
    await mountProvider(<DraggableCard card={SLOT_CARD} onDrop={onDrop} />)
    await act(async () => {
      mockPans[0].onStart!({ absoluteX: 50, absoluteY: 320 })
    })
    await act(async () => {
      mockPans[0].onEnd!({ absoluteX: 120, absoluteY: 420 }) // invalid: snaps back
    })
    const mountsBefore = mockPaint.mounts[SLOT_CARD.id]
    mockPaint.defer = true // a fresh ghost would stay invisible, the card held back at its slot
    await act(async () => {
      mockPans[0].onStart!({ absoluteX: 50, absoluteY: 320 })
    })
    expect(mockPaint.mounts[SLOT_CARD.id]).toBe(mountsBefore)
    expect(isGhostPending(SLOT_CARD.id)).toBe(false)
    expect(boardHidden(SLOT_CARD.id)).toBe(true)
    expect(ghostsAt(SLOT_CARD.id)).toHaveLength(1)
  })

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

// ------------------------------------------------------------------------------------------------ a run's fan step

/** Where each of these cards is drawn down its ghost's fan, from the run's first card (each card's animated offset, evaluated now). */
function ghostFan(cards: Card[]): number[] {
  return cards.map((c) => {
    const styles = [screen.getByTestId(`fan:${c.id}`).props.style].flat(Infinity) as { __worklet?: () => { transform: [{ translateY: number }] } }[]
    return Math.round(styles.find((s) => s?.__worklet)!.__worklet!().transform[0].translateY * 1e6) / 1e6
  })
}

/** The animated style of every ghost card wrapper of card `id` (evaluated now), in the order the flights started. */
function slotStyles(id: string) {
  return screen.getAllByTestId(`fan:${id}`).map((node) => {
    const styles = [node.props.style].flat(Infinity) as { __worklet?: () => { opacity?: number; transform?: [{ translateY: number }] } }[]
    return styles.find((s) => s?.__worklet)!.__worklet!()
  })
}
const slotStyle = (id: string) => slotStyles(id)[0]

// Columns compress their fans to fit the screen (columnTops), so a run's ghost must not fan at the natural step: it stretched the moment a
// run lifted off a compressed column and snapped shorter as it landed on one. It takes the spacing the run has in the column it leaves and
// eases to the spacing of the column it lands on, in step with its flight (fanTops.ts).
describe('DragGhostProvider - a run is fanned like the columns it leaves and lands on', () => {
  const C = card('spades-7-0')
  const RUN = [A, B, C]
  const NATURAL = faceUpFanOffset(64)
  const source = {}
  const destination = {}
  const layOut = (owner: object, top: number, step: number) => RUN.forEach((c, i) => setFanTop(c.id, owner, top + i * step))
  afterEach(() => {
    RUN.forEach((c) => {
      clearFanTop(c.id, source)
      clearFanTop(c.id, destination)
    })
  })

  it('lifts off at the spacing of the compressed column it leaves, and eases to the spacing of the one it lands on as it flies', async () => {
    await mountProvider()
    layOut(source, 300, 16)
    const flight = await inAct(() => ghost.show({ cards: RUN, offsetStep: NATURAL, cardWidth: 64 }, { x: 10, y: 300 }))
    expect(ghostFan(RUN)).toEqual([0, 16, 32]) // not the natural 28.8

    // The move commits: the run is laid out in the column it lands on, at that column's spacing, and the ghost flies there.
    RUN.forEach((c) => clearFanTop(c.id, source))
    layOut(destination, 500, 24)
    const arrived = jest.fn()
    await inAct(() => flight.flyTo(10, 500, arrived))
    await advance(FLIGHT_SPRING.duration! / 3)
    const [, mid] = ghostFan(RUN)
    expect(mid).toBeGreaterThan(16)
    expect(mid).toBeLessThan(24)

    await advance(springSettleMs(FLIGHT_SPRING) - FLIGHT_SPRING.duration! / 3 - 2)
    ghostFan(RUN).forEach((y, i) => expect(y).toBeCloseTo(i * 24, 1)) // as the real cards under it are laid out when it lands
    expect(arrived).not.toHaveBeenCalled()
  })

  it('a run that is not laid out in a column flies at the step it was given, and a stack with no fan stays stacked', async () => {
    await mountProvider()
    const flight = await inAct(() => ghost.show({ cards: [A, B], offsetStep: 20, cardWidth: 64 }, { x: 10, y: 300 }))
    expect(ghostFan([A, B])).toEqual([0, 20])
    await inAct(() => flight.flyTo(10, 500, () => {}))
    await advance(FLIGHT_SPRING.duration!)
    expect(ghostFan([A, B])).toEqual([0, 20])
    await advance(3000)

    layOut(source, 300, 16)
    await inAct(() => ghost.show({ cards: RUN, offsetStep: 0, cardWidth: 64 }, { x: 10, y: 300 }))
    // No fan to animate: every card sits on the first (its wrapper only ever hides a card peeled off the stack, never moves it).
    RUN.forEach((c) => expect(slotStyle(c.id).transform).toBeUndefined())
  })

  it("a run dragged out of a compressed PileView is drawn at that column's own spacing", async () => {
    const cards = [9, 8, 7, 6, 5, 4, 3, 2, 1, 13, 12, 11].map((rank) => ({ id: `hearts-${rank}-0`, suit: 'hearts', rank, faceUp: true }) as Card)
    const MAX_HEIGHT = 350
    const drag = { registry: { hitTest: async () => null }, getRunCount: (indexFromTop: number) => indexFromTop + 1, onDrop: async () => false }
    await mountProvider(<PileView cards={cards} drag={drag as never} onPressCard={() => {}} maxHeight={MAX_HEIGHT} />)
    const { tops } = columnTops(cards, [], NATURAL, (64 / CARD_ASPECT) * 0.13, 64 / CARD_ASPECT, MAX_HEIGHT)
    const step = tops[10] - tops[9]
    expect(step).toBeLessThan(NATURAL - 1) // the column really is compressed

    await dragCard(9, { x: 10, y: 400 }, { dx: 30, dy: 60 }, false) // the last three cards
    ghostFan(cards.slice(9)).forEach((y, i) => expect(y).toBeCloseTo(i * step, 6))
  })
})

// ------------------------------------------------------------------------------------------------ peeling cards off a flight

// A held Undo in Yukon stalled whenever the next undo needed cards the one before it was still flying back: it waited for them to land,
// then sent them off again (Jay's recording, 2026-10-16: ~0.5s gaps in a ~0.1s stream). peel() takes the top cards of a flight still in
// the air and gives them a flight of their own, turning back from exactly where they are drawn, while the rest of the run lands as before.
describe('DragGhostProvider - peeling cards off a flight still in the air', () => {
  const RUN = [card('peel-1'), card('peel-2'), card('peel-3')]
  const run = { cards: RUN, offsetStep: 20, cardWidth: 64 }
  const single = (c: Card) => ({ cards: [c], offsetStep: 0, cardWidth: 64 })
  const paintAll = () => mockPaint.waiting.splice(0).forEach((painted) => painted())

  it('only the top cards of a flight that has shown its ghost and not landed yet can be peeled', async () => {
    await mountProvider()
    mockPaint.defer = true
    const flight = await inAct(() => ghost.show(run, { x: 10, y: 20 }))
    expect(ghost.canPeel(single(RUN[2]))).toBe(false) // nothing on screen to turn back yet
    await inAct(() => paintAll())

    expect(ghost.canPeel(single(RUN[2]))).toBe(true)
    expect(ghost.canPeel({ cards: RUN.slice(1), offsetStep: 20, cardWidth: 64 })).toBe(true)
    expect(ghost.canPeel(run)).toBe(true)
    expect(ghost.canPeel(single(RUN[1]))).toBe(false) // not the top of the run
    expect(ghost.canPeel({ cards: [RUN[2], RUN[1]], offsetStep: 20, cardWidth: 64 })).toBe(false)
    expect(ghost.canPeel(single({ ...RUN[2], faceUp: false }))).toBe(false)
    expect(ghost.canPeel({ ...single(RUN[2]), cardWidth: 50 })).toBe(false)

    await inAct(() => flight.flyTo(10, 320, () => {}))
    await advance(springSettleMs(FLIGHT_SPRING))
    expect(ghost.canPeel(single(RUN[2]))).toBe(false) // landed: the card is on the board now
  })

  it('a drag can not be peeled', async () => {
    await mountProvider()
    await inAct(() => ghost.showLive(single(RUN[2]), persistentValues()))
    expect(ghost.canPeel(single(RUN[2]))).toBe(false)
    expect(ghost.peel(single(RUN[2]))).toBeNull()
  })

  it('a peeled card rides along until its own flight starts, then turns back from exactly where it is drawn while the rest of the run lands as before', async () => {
    await mountProvider()
    const flight = await inAct(() => ghost.show(run, { x: 10, y: 20 }))
    const landed = jest.fn()
    await inAct(() => flight.flyTo(10, 320, landed))
    await advance(100)

    const peeled = (await inAct(() => ghost.peel(single(RUN[2]))))!
    expect(peeled).not.toBeNull()
    expect(ghost.canPeel(single(RUN[2]))).toBe(false) // taken
    expect(ghost.canPeel(single(RUN[1]))).toBe(true) // and the card under it is the run's top now
    // Drawn over the third card of the run (two fan steps down from its first), which the run still draws too.
    const run0 = ghostAt(RUN[0].id)
    expect(ghostAt(RUN[2].id)).toEqual({ x: run0.x, y: run0.y + 40 })
    expect(slotStyles(RUN[2].id).map((style) => style.opacity)).toEqual([1, 1])
    await advance(30)
    const riding = ghostAt(RUN[2].id)
    expect(riding).toEqual({ x: ghostAt(RUN[0].id).x, y: ghostAt(RUN[0].id).y + 40 }) // still with the run, which is still moving
    expect(riding.y).toBeGreaterThan(run0.y + 40)

    const arrived = jest.fn()
    await inAct(() => peeled.flyTo(200, 60, arrived))
    expect(ghostAt(RUN[2].id)).toEqual(riding) // no jump as it takes over
    expect(slotStyles(RUN[2].id).map((style) => style.opacity)).toEqual([0, 1]) // the run no longer draws it; its own ghost does
    expect(slotStyle(RUN[1].id).opacity).toBe(1)

    await advance(springSettleMs(FLIGHT_SPRING) - 130)
    expect(landed).toHaveBeenCalledTimes(1) // the run lands on its own clock
    expect(arrived).not.toHaveBeenCalled()
    await advance(128)
    const end = ghostAt(RUN[2].id)
    expect(Math.abs(end.x - 200)).toBeLessThan(1)
    expect(Math.abs(end.y - 60)).toBeLessThan(1) // its lift down the old fan sprang back to 0 on the way
    await advance(2)
    expect(arrived).toHaveBeenCalledTimes(1)
  })

  it('a card peeled off a peeled flight follows that flight where it is now', async () => {
    await mountProvider()
    const flight = await inAct(() => ghost.show(run, { x: 10, y: 20 }))
    await inAct(() => flight.flyTo(10, 320, () => {}))
    await advance(100)
    const tail = (await inAct(() => ghost.peel({ cards: RUN.slice(1), offsetStep: 20, cardWidth: 64 })))!
    expect(ghost.canPeel(single(RUN[2]))).toBe(false) // its flight has not taken over yet: nothing of its own to follow
    await inAct(() => tail.flyTo(300, 60, () => {}))
    await advance(50)
    expect(ghost.canPeel(single(RUN[2]))).toBe(true)

    const last = (await inAct(() => ghost.peel(single(RUN[2]))))!
    const head = ghostsAt(RUN[1].id)[0]
    expect(ghostAt(RUN[2].id)).toEqual({ x: head.x, y: head.y + 20 }) // one step down the peeled run, wherever its lift has it
    await inAct(() => last.flyTo(10, 600, () => {}))
    expect(slotStyles(RUN[2].id).map((style) => style.opacity)).toEqual([0, 0, 1])
  })

  // A tap can peel a run's cards off a flight a moment before it lands (inAirRun.ts). The peeled ghost is a fresh one, invisible until its
  // faces paint, and the flight it rides along with is the only one drawing those cards meanwhile: landed, it used to go at once (the cards
  // it still drew were not counted), so they vanished until the peeled ghost showed.
  it('a flight that lands before the ghost of its peeled cards shows keeps drawing them until it does', async () => {
    await mountProvider()
    const flight = await inAct(() => ghost.show(run, { x: 10, y: 20 }))
    await inAct(() => flight.flyTo(10, 320, () => {}))
    await advance(springSettleMs(FLIGHT_SPRING) - 10)
    mockPaint.defer = true
    const peeled = (await inAct(() => ghost.peel(single(RUN[2]))))!
    await advance(20) // the run lands; the peeled card's ghost has not painted
    expect(ghostsAt(RUN[0].id)).toHaveLength(1)
    expect(slotStyles(RUN[2].id).map((style) => style.opacity)).toEqual([1, 1]) // the run still draws it, over its own invisible ghost

    await inAct(() => paintAll())
    expect(screen.queryAllByTestId(`ghost:${RUN[0].id}`)).toEqual([]) // its own ghost is on screen: the landed run can go
    expect(slotStyle(RUN[2].id).opacity).toBe(1)
    await inAct(() => peeled.flyTo(200, 60, () => {}))
  })

  it('a peeled flight hidden before it takes over: the run stops drawing its cards all the same', async () => {
    await mountProvider()
    const flight = await inAct(() => ghost.show(run, { x: 10, y: 20 }))
    await inAct(() => flight.flyTo(10, 320, () => {}))
    await advance(100)
    const peeled = (await inAct(() => ghost.peel(single(RUN[2]))))!
    await inAct(() => peeled.hide())
    expect(slotStyle(RUN[2].id).opacity).toBe(0)
    expect(screen.queryAllByTestId(`ghost:${RUN[2].id}`)).toEqual([])
  })

  it('a ghost with cards peeled off is never adopted by a later flight of the whole run', async () => {
    await mountProvider()
    const flight = await inAct(() => ghost.show(run, { x: 10, y: 20 }))
    await inAct(() => flight.flyTo(10, 320, () => {}))
    await advance(100)
    const peeled = (await inAct(() => ghost.peel(single(RUN[2]))))!
    await inAct(() => peeled.flyTo(200, 60, () => {}))
    const loaded = trackFaceLoad(RUN[0].id) // the run's landing reveals a card whose face is still loading: its landed ghost stays
    await advance(springSettleMs(FLIGHT_SPRING) - 100)
    expect(ghostsAt(RUN[0].id)).toHaveLength(1)
    await inAct(() => ghost.show(run, { x: 10, y: 320 }))
    // A fresh ghost beside the landed one (and the peeled card's own), not the landed one carrying on with a card missing.
    expect(ghostsAt(RUN[0].id)).toHaveLength(2)
    expect(slotStyles(RUN[2].id)).toHaveLength(3)
    await inAct(() => loaded())
  })
})
