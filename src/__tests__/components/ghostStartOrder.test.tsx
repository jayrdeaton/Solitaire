import { CardSizeProvider } from '@tastic/cards'
import { act, render, screen } from '@testing-library/react-native'
import { ReactNode, useEffect } from 'react'
import { makeMutable, SharedValue } from 'react-native-reanimated'

import { GHOST_PAINT_MAX_MS, isGhostPending, trackFaceLoad } from '@/components/cardFacePaint'
import { DragGhostController, DragGhostProvider, useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { FLIGHT_SPRING, springSettleMs } from '@/components/dragdrop/dragSpring'
import { Card } from '@/engine/types'

// ---------------------------------------------------------------------------------------------------------------------
// A show() flight is never let go before every show() flight started ahead of it has shown its ghost (DragGhostProvider's
// start queue), so flights SENT (flyTo) in start order - every one of them taking the same FLIGHT_SPRING - land in that
// order. A flight can start moving only once its ghost turns visible, and that moment varies per flight: a fresh ghost
// waits for its face bitmap (useGhostPaintGate, up to GHOST_PAINT_MAX_MS from its own commit), while an adopted ghost
// (already painted) or a face-down one shows in its first commit. Without the queue a later card (an auto-play stream's
// next one, adopting its own just-landed ghost) could start, and land, before an earlier card whose fresh face was slow to
// come back - on a shared foundation the overtaken card showed on the pile with its ghost over it.
//
// The queue orders gate OPENINGS, not flyTo calls: a flight moves at the later of its gate and its own flyTo, so one shown
// earlier but sent later starts, and lands, later. The last describe block (and the shown-but-not-sent case above it) pins
// that limit, which show()'s doc states - so the doc can't drift back to promising more than the code does.
//
// The real DragGhostProvider, with stand-ins only for what needs native views (the same harness as dragGhostLayer.test.tsx):
//   - react-native-reanimated: `makeMutable` gives values whose `withSpring` assignments really move over (fake) time, and
//     `useAnimatedStyle` hands back its worklet so a test can read where a ghost is DRAWN - so "has its flight started" is
//     "has its ghost left its origin".
//   - PlayingCard: a ghost face reports its bitmap painted once mounted, unless its card is in `mockPaint.deferIds`, when
//     the report waits for paint(id) - a slow face.
// ---------------------------------------------------------------------------------------------------------------------

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
  // A ghost's own host view, tagged with its (first) card's id so a test finds it.
  function AnimatedView({ style, children }: { style?: unknown; children?: ReactNode }) {
    const first = (require('react').Children.toArray(children) as { key?: string }[])[0]
    const testID = first?.key != null ? `ghost:${String(first.key).replace(/^\.\$/, '')}` : undefined
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
    useAnimatedStyle: (worklet: () => unknown) => ({ __worklet: worklet }),
    withSpring: (toValue: number, config: { duration: number }) => ({ __spring: true, toValue, config }),
    withTiming: (value: unknown) => value
  }
})
/** Ghost faces report their bitmap painted once mounted, as a loaded Image does - unless their card is in `deferIds`, when the
 * reports wait in `waiting` for paint(id). `mounts` counts each card's PlayingCard mounts (an adopted ghost mounts nothing new). */
const mockPaint = { deferIds: new Set<string>(), waiting: [] as { id: string; painted: () => void }[], mounts: {} as Record<string, number> }
jest.mock('@/components/PlayingCard', () => {
  const { View } = require('react-native')
  const { useEffect: useMockEffect } = require('react')
  function MockPlayingCard({ card, onFacePainted }: { card: { id: string }; onFacePainted?: () => void }) {
    useMockEffect(() => {
      mockPaint.mounts[card.id] = (mockPaint.mounts[card.id] ?? 0) + 1
    }, [card.id])
    useMockEffect(() => {
      if (!onFacePainted) return
      if (mockPaint.deferIds.has(card.id)) mockPaint.waiting.push({ id: card.id, painted: onFacePainted })
      else onFacePainted()
    }, [card.id, onFacePainted])
    return <View testID={`card:${card.id}`} />
  }
  return { PlayingCard: MockPlayingCard, EmptySlot: () => <View /> }
})
jest.mock('@/components/overlayFrame', () => {
  // toLocal with this frame is the identity on a screen point (the overlay sits at the window origin, unrotated).
  const frame = { rotation: { value: 0 }, cx: { value: 200 }, cy: { value: 400 }, lw: { value: 400 }, lh: { value: 800 } }
  return { useOverlayFrame: () => ({ overlayRef: { current: null }, frame }), toLocal: jest.requireActual('@/components/overlayFrameMath').toLocal }
})
jest.mock('@/components/useCardSounds', () => ({ useCardSoundEffects: () => ({ playCardSound: jest.fn(), playInvalidSound: jest.fn(), hapticCard: jest.fn(), hapticInvalid: jest.fn() }) }))

// ------------------------------------------------------------------------------------------------ harness

let ghost: DragGhostController
function Probe({ onController }: { onController: (controller: DragGhostController) => void }) {
  const controller = useDragGhost()
  useEffect(() => onController(controller), [controller, onController])
  return null
}
const captureGhost = (controller: DragGhostController) => {
  ghost = controller
}
async function mountProvider() {
  return render(
    <CardSizeProvider width={64}>
      <DragGhostProvider>
        <Probe onController={captureGhost} />
      </DragGhostProvider>
    </CardSizeProvider>
  )
}
const card = (id: string, faceUp = true): Card => ({ id, suit: 'spades', rank: 9, faceUp }) as Card
const contentOf = (c: Card) => ({ cards: [c], offsetStep: 0, cardWidth: 64 })
type Values = { originX: SharedValue<number>; originY: SharedValue<number>; dx: SharedValue<number>; dy: SharedValue<number> }
const persistentValues = (): Values => ({ originX: makeMutable(0), originY: makeMutable(0), dx: makeMutable(0), dy: makeMutable(0) })

async function inAct<T>(fn: () => T): Promise<T> {
  let out!: T
  await act(async () => {
    out = fn()
  })
  return out
}
async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}
/** Delivers card `id`'s deferred ghost-face paint reports (its onLoad). */
async function paint(id: string) {
  mockPaint.deferIds.delete(id)
  await inAct(() => {
    const due = mockPaint.waiting.filter((w) => w.id === id)
    mockPaint.waiting = mockPaint.waiting.filter((w) => w.id !== id)
    due.forEach((w) => w.painted())
  })
}
/** Where card `id`'s ghost is DRAWN right now (its animated style worklet, evaluated now): the newest ghost of it. */
function ghostAt(id: string) {
  const nodes = screen.getAllByTestId(`ghost:${id}`)
  const styles = [nodes[nodes.length - 1].props.style].flat(Infinity) as { __worklet?: () => { transform: [{ translateX: number }, { translateY: number }] } }[]
  const { transform } = styles.find((s) => s?.__worklet)!.__worklet!()
  return { x: Math.round(transform[0].translateX * 1e6) / 1e6, y: Math.round(transform[1].translateY * 1e6) / 1e6 }
}
const opacityOf = (id: string) => ([screen.getByTestId(`ghost:${id}`).props.style].flat(Infinity) as { opacity?: number }[]).reduce((o, st) => (st && st.opacity !== undefined ? st.opacity : o), 1)

const A = card('spades-5-0')
const B = card('spades-6-0')
const C = card('spades-7-0')
const FROM_A = { x: 10, y: 20 }
const FROM_B = { x: 10, y: 300 }
const FROM_C = { x: 10, y: 600 }
/** The flight's ghost has started its spring: it has left its origin (every flight here flies 300px to the right). */
const started = (id: string, from: { x: number; y: number }) => ghostAt(id).x > from.x + 1
const SETTLE = springSettleMs(FLIGHT_SPRING)

// The registry is module-level: a face left loading would hold back every later landing of that card.
const loadingFaces: (() => void)[] = []
beforeEach(() => {
  jest.useFakeTimers()
  mockPaint.deferIds.clear()
  mockPaint.waiting = []
  for (const key of Object.keys(mockPaint.mounts)) delete mockPaint.mounts[key]
})
afterEach(() => {
  loadingFaces.splice(0).forEach((done) => done())
  jest.useRealTimers()
})

/** show() + flyTo 300px to the right, in one stretch (as every screen does once it has its destination). */
async function fly(c: Card, from: { x: number; y: number }, arrived: () => void) {
  return inAct(() => {
    const flight = ghost.show(contentOf(c), from)
    flight.flyTo(from.x + 300, from.y, arrived)
    return flight
  })
}

describe('DragGhostProvider - a show() flight is not let go before every one started ahead of it has shown its ghost', () => {
  it('a later flight whose ghost shows first waits, visible at its origin and with its source let go, until the earlier ghost has shown - then both fly and land in start order', async () => {
    await mountProvider()
    mockPaint.deferIds.add(A.id) // A's face is slow to come back
    const arrivedA = jest.fn()
    const arrivedB = jest.fn()
    await fly(A, FROM_A, arrivedA)
    await fly(B, FROM_B, arrivedB) // B's face paints at once

    expect(opacityOf(A.id)).toBe(0)
    expect(opacityOf(B.id)).toBe(1) // B is on screen...
    expect(isGhostPending(B.id)).toBe(false) // ...so its source has let go of it
    await advance(40)
    expect(started(B.id, FROM_B)).toBe(false) // but it has not started: A, started before it, has not
    expect(ghostAt(B.id)).toEqual(FROM_B) // it sits exactly at its origin
    expect(started(A.id, FROM_A)).toBe(false)

    await paint(A.id) // A shows: both go, A first
    expect(opacityOf(A.id)).toBe(1)
    await advance(20)
    expect(started(A.id, FROM_A)).toBe(true)
    expect(started(B.id, FROM_B)).toBe(true)

    // Both settle clocks started at A's paint, not B's: B does not land early, and A lands no later than B.
    await advance(SETTLE - 21)
    expect(arrivedA).not.toHaveBeenCalled()
    expect(arrivedB).not.toHaveBeenCalled()
    await advance(1)
    expect(arrivedA).toHaveBeenCalledTimes(1)
    expect(arrivedB).toHaveBeenCalledTimes(1)
    expect(arrivedA.mock.invocationCallOrder[0]).toBeLessThan(arrivedB.mock.invocationCallOrder[0])
  })

  it('an ADOPTED ghost (painted already, on screen in its first commit) still waits its turn behind an earlier flight whose fresh ghost has not shown', async () => {
    await mountProvider()
    // B lands with its board face still loading, so its ghost waits there - the auto-play stream's next card, about to take off again.
    await fly(B, FROM_B, () => loadingFaces.push(trackFaceLoad(B.id)))
    await advance(SETTLE + 60) // landed (its spring's tail run out too), well inside LANDED_GHOST_MAX_MS
    const landedAt = { x: FROM_B.x + 300, y: FROM_B.y }
    expect(ghostAt(B.id)).toEqual(landedAt)

    mockPaint.deferIds.add(A.id)
    const arrivedA = jest.fn()
    const arrivedB = jest.fn()
    await fly(A, FROM_A, arrivedA) // the earlier card: a fresh ghost, its face slow
    const mountsBefore = mockPaint.mounts[B.id]
    await fly(B, landedAt, arrivedB) // then B leaves again, carrying on with its landed ghost
    expect(mockPaint.mounts[B.id]).toBe(mountsBefore) // adopted: nothing new mounted, nothing to wait for
    expect(opacityOf(B.id)).toBe(1)
    expect(isGhostPending(B.id)).toBe(false)

    await advance(40)
    expect(started(B.id, landedAt)).toBe(false) // it has not overtaken A
    expect(ghostAt(B.id)).toEqual(landedAt)

    await paint(A.id)
    await advance(20)
    expect(started(A.id, FROM_A)).toBe(true)
    expect(started(B.id, landedAt)).toBe(true)
    await advance(SETTLE - 20)
    expect(arrivedA).toHaveBeenCalledTimes(1)
    expect(arrivedB).toHaveBeenCalledTimes(1)
    expect(arrivedA.mock.invocationCallOrder[0]).toBeLessThan(arrivedB.mock.invocationCallOrder[0])
  })

  it('waits for every earlier flight, not just the first: a third ready flight goes only once both earlier ghosts have shown', async () => {
    await mountProvider()
    mockPaint.deferIds.add(A.id)
    mockPaint.deferIds.add(B.id)
    await fly(A, FROM_A, () => {})
    await fly(B, FROM_B, () => {})
    await fly(C, FROM_C, () => {})
    await paint(B.id) // the middle one shows first
    await advance(20)
    expect(started(B.id, FROM_B)).toBe(false)
    expect(started(C.id, FROM_C)).toBe(false)
    await paint(A.id)
    await advance(20)
    expect(started(A.id, FROM_A)).toBe(true)
    expect(started(B.id, FROM_B)).toBe(true)
    expect(started(C.id, FROM_C)).toBe(true)
  })

  it('an earlier ghost that never reports holds a later flight back no longer than its own GHOST_PAINT_MAX_MS', async () => {
    await mountProvider()
    mockPaint.deferIds.add(A.id) // and never painted
    await fly(A, FROM_A, () => {})
    await fly(B, FROM_B, () => {})
    await advance(GHOST_PAINT_MAX_MS - 1)
    expect(started(B.id, FROM_B)).toBe(false)
    await advance(1) // A's cap: it shows, and both go
    await advance(20)
    expect(started(A.id, FROM_A)).toBe(true)
    expect(started(B.id, FROM_B)).toBe(true)
  })
})

describe('DragGhostProvider - a flight that goes never blocks the ones behind it', () => {
  it('hide() of an earlier flight still waiting for its paint lets the later one go at once', async () => {
    await mountProvider()
    mockPaint.deferIds.add(A.id)
    const first = await fly(A, FROM_A, () => {})
    const arrivedB = jest.fn()
    await fly(B, FROM_B, arrivedB)
    await advance(30)
    expect(started(B.id, FROM_B)).toBe(false)

    await inAct(() => first.hide()) // a refused move, a New Game
    await advance(20)
    expect(started(B.id, FROM_B)).toBe(true)
    await advance(SETTLE - 21)
    expect(arrivedB).not.toHaveBeenCalled()
    await advance(1) // its settle clock started at the hide
    expect(arrivedB).toHaveBeenCalledTimes(1)
  })

  it('an earlier flight hidden before its ghost ever mounted holds nothing back', async () => {
    await mountProvider()
    mockPaint.deferIds.add(A.id)
    await inAct(() => {
      const first = ghost.show(contentOf(A), FROM_A)
      first.flyTo(FROM_A.x + 300, FROM_A.y, () => {})
      first.hide() // gone in the same stretch: its ghost never renders
    })
    const arrivedB = jest.fn()
    await fly(B, FROM_B, arrivedB)
    await advance(20)
    expect(started(B.id, FROM_B)).toBe(true)
    await advance(SETTLE - 20)
    expect(arrivedB).toHaveBeenCalledTimes(1)
  })
})

describe('DragGhostProvider - a flight with no unopened gate ahead of it is not delayed', () => {
  it('a lone flight starts the moment its ghost shows', async () => {
    await mountProvider()
    const arrived = jest.fn()
    await fly(B, FROM_B, arrived)
    await advance(20)
    expect(started(B.id, FROM_B)).toBe(true)
    await advance(SETTLE - 21)
    expect(arrived).not.toHaveBeenCalled()
    await advance(1)
    expect(arrived).toHaveBeenCalledTimes(1)
  })

  it('an earlier flight that has SHOWN but not been sent anywhere yet (its destination still being measured) does not hold a later one back - which then lands first', async () => {
    await mountProvider()
    const first = await inAct(() => ghost.show(contentOf(A), FROM_A)) // on screen, no flyTo yet
    const arrivedB = jest.fn()
    await fly(B, FROM_B, arrivedB)
    await advance(20)
    expect(started(B.id, FROM_B)).toBe(true)
    expect(ghostAt(A.id)).toEqual(FROM_A)
    const arrivedA = jest.fn()
    await inAct(() => first.flyTo(FROM_A.x + 300, FROM_A.y, arrivedA)) // and it flies at once when sent
    await advance(20)
    expect(started(A.id, FROM_A)).toBe(true)
    await advance(SETTLE - 20)
    expect(arrivedA).toHaveBeenCalledTimes(1)
    // Start order is not landing order here: the queue never waits for a flyTo, so B, sent first, landed first.
    expect(arrivedB).toHaveBeenCalledTimes(1)
    expect(arrivedB.mock.invocationCallOrder[0]).toBeLessThan(arrivedA.mock.invocationCallOrder[0])
  })

  it('a drag (showLive) whose ghost has not painted yet does not hold a show() flight back - drags are not in the start queue', async () => {
    await mountProvider()
    mockPaint.deferIds.add(A.id)
    await inAct(() => ghost.showLive(contentOf(A), persistentValues()))
    expect(opacityOf(A.id)).toBe(0)
    await fly(B, FROM_B, () => {})
    await advance(20)
    expect(started(B.id, FROM_B)).toBe(true)
  })

  it('a face-down flight with nothing ahead of it shows and starts in its first commit', async () => {
    await mountProvider()
    const back = card('spades-8-0', false)
    await fly(back, FROM_C, () => {})
    expect(opacityOf(back.id)).toBe(1)
    await advance(20)
    expect(started(back.id, FROM_C)).toBe(true)
  })
})

describe('DragGhostProvider - the queue orders gate openings, not flyTo calls', () => {
  it('an earlier ghost that has not shown holds a later SENT flight back; once it shows, it still moves only at its own flyTo, so the later flight lands first', async () => {
    await mountProvider()
    mockPaint.deferIds.add(A.id)
    const first = await inAct(() => ghost.show(contentOf(A), FROM_A)) // its face slow, and not sent anywhere yet
    const arrivedB = jest.fn()
    await fly(B, FROM_B, arrivedB)
    await advance(40)
    expect(started(B.id, FROM_B)).toBe(false) // held: A's ghost has not shown

    await paint(A.id) // A's gate opens, and B's right behind it...
    await advance(20)
    expect(opacityOf(A.id)).toBe(1)
    expect(started(B.id, FROM_B)).toBe(true) // ...so B, already sent, goes now
    expect(ghostAt(A.id)).toEqual(FROM_A) // while A, open but not sent, stays put

    await advance(30)
    const arrivedA = jest.fn()
    await inAct(() => first.flyTo(FROM_A.x + 300, FROM_A.y, arrivedA)) // A is sent 50ms after its gate opened
    await advance(20)
    expect(started(A.id, FROM_A)).toBe(true)

    // B's settle clock started at A's paint (its gate), A's at its own flyTo: B lands SETTLE after the paint, A 50ms later.
    await advance(SETTLE - 71)
    expect(arrivedB).not.toHaveBeenCalled()
    await advance(1)
    expect(arrivedB).toHaveBeenCalledTimes(1)
    expect(arrivedA).not.toHaveBeenCalled()
    await advance(50)
    expect(arrivedA).toHaveBeenCalledTimes(1)
  })
})
