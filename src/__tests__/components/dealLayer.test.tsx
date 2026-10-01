import { act, fireEvent, render, screen, within } from '@testing-library/react-native'
import { Profiler, useEffect } from 'react'
import { StyleSheet, type ViewStyle } from 'react-native'
import { cancelAnimation, withSpring } from 'react-native-reanimated'

import { type DealAnimator, type DealCardSpec, dealPoolSize, DealProvider, ghostPoolSize, useDealAnimator } from '@/components/dealing/DealLayer'
import { DEAL_SPRING, DEAL_STAGGER_MS } from '@/components/dealing/dealSpring'
import { FLIGHT_SPRING } from '@/components/dragdrop/dragSpring'
import type { Card } from '@/engine/types'

const mockPlayCardSound = jest.fn()
const mockHapticCard = jest.fn()
const mockMounts = { count: 0 }
const mockShown: string[] = []
// Card ids whose FIRST render should take `ms` of wall-clock time (see the absolute-deadline tests): a stand-in for the slow commit of
// a court-card face, which the fake clock cannot otherwise show.
const mockRenderLatency = { ids: new Set<string>(), ms: 60 }

jest.mock('@/components/useCardSounds', () => ({
  useCardSoundEffects: () => ({ playCardSound: mockPlayCardSound, hapticCard: mockHapticCard })
}))
// The repo-wide reanimated mock's useSharedValue returns a FRESH {value} object on every call, which is fine for the
// rest of this file (every existing assertion here reads tx/ty through the SAME closure a slot's own [job] effect
// captured once, never through a re-render), but breaks any assertion that reads a shared value's current position
// off the RENDERED style: useAnimatedStyle's updater is a fresh closure on every render, so on real Reanimated
// (where useSharedValue keeps the same object across a component's whole lifetime, exactly as playingCardDimHold's
// own override already documents) it sees the SAME mutated object checkSettled just wrote to; here, without this,
// it would get yet another freshly-defaulted one on the very next render and silently show the initial value again.
// Only useSharedValue is overridden - everything else (withSpring, withDelay, cancelAnimation, useAnimatedRef...)
// stays exactly the shared mock this file already relies on for its other assertions.
jest.mock('react-native-reanimated', () => {
  const { useRef } = require('react')
  const base = jest.requireActual('../../__mocks__/react-native-reanimated')
  return {
    ...base,
    useSharedValue: (initial: unknown) => {
      const ref: { current: { value: unknown } | null } = useRef(null)
      if (!ref.current) ref.current = { value: initial }
      return ref.current
    }
  }
})
// `ready` needs to be genuinely REACTIVE (a real useState inside the mock, not a closed-over plain
// value) so a test can flip it from false to true on an already-mounted provider and prove the
// deal's own [generation, frameReady] effect re-runs - the exact race the fix closes. `initialReady`
// controls what a fresh render starts at; `setReady` (populated by the hook's own effect while
// mounted) lets a test flip it later. Reset both in afterEach so one test's override never leaks.
const overlayFrameControl: { initialReady: boolean; setReady: ((ready: boolean) => void) | null } = { initialReady: true, setReady: null }
jest.mock('@/components/overlayFrame', () => {
  const { useEffect: useMockEffect, useState: useMockState } = require('react')
  return {
    useOverlayFrame: () => {
      const [ready, setReady] = useMockState(overlayFrameControl.initialReady)
      useMockEffect(() => {
        overlayFrameControl.setReady = setReady
        return () => {
          overlayFrameControl.setReady = null
        }
      }, [setReady])
      return { overlayRef: { current: null }, frame: {}, ready }
    },
    // A pass-through (not a fixed {0,0}) so a test can read a ghost's actual tx/ty off its rendered
    // transform style - needed to verify the settle-verification timeout backstop snaps the ghost to
    // its real destination before notify() fires, not just that notify() eventually fires at all.
    toLocal: (tx: number, ty: number) => ({ x: tx, y: ty })
  }
})
jest.mock('@/components/PlayingCard', () => {
  const { View } = require('react-native')
  const { useEffect: useMockEffect } = require('react')
  return {
    PlayingCard: ({ card }: { card: { id: string } }) => {
      useMockEffect(() => {
        mockMounts.count++
      }, [])
      mockShown.push(card.id)
      if (mockRenderLatency.ids.delete(card.id)) jest.setSystemTime(Date.now() + mockRenderLatency.ms)
      return <View testID={`ghost-${card.id}`} />
    }
  }
})
jest.mock('@tastic/core', () => ({ useRotation: () => 0, rotateInsets: (insets: unknown) => insets }))
// A plain mutable holder, not @infinitetoken/jest-config's usual "stable object" trick (see
// playingCardDimHold.test.tsx) - these tests set it once, before the provider mounts, never mid-render,
// so there's no reactivity to prove here, only what start() does with whatever it read at that point.
const mockReduceMotion = { value: false }
jest.mock('@/stores/settings', () => ({ useSettings: () => ({ settings: { reduceMotion: mockReduceMotion.value } }) }))

const CARD_WIDTH = 64
const LOOKAHEAD_MS = 150
const SETTLE_MAX_EXTRA_MS = 1000

function makeEntries(count: number, prefix = 'c', faceUp = false, stagger = DEAL_STAGGER_MS): DealCardSpec[] {
  return Array.from({ length: count }, (_, i) => {
    const card = { id: `${prefix}${i}`, suit: 'spades', rank: 1, faceUp } as unknown as Card
    return { cardId: card.id, card, from: { x: 0, y: 0 }, to: { x: 10 * i, y: 20 }, delayMs: i * stagger }
  })
}

let controller: DealAnimator
function Capture() {
  const animator = useDealAnimator()
  useEffect(() => {
    controller = animator
  })
  return null
}

const ghosts = () => screen.queryAllByTestId(/^deal-ghost-/)
const styleOf = (node: { props: { style?: unknown } }): ViewStyle => StyleSheet.flatten(node.props.style as ViewStyle) ?? {}
const opacityOf = (node: { props: { style?: unknown } }) => styleOf(node).opacity
// A slot is "flying" (or waiting to) whenever it is not the hidden idle one.
const flying = () => ghosts().filter((node) => opacityOf(node) !== 0)
// The ghost's OWN rendered position - its inner Animated.View (the outer `deal-ghost-*` node's only
// child) carries the translateX/Y that toLocal's pass-through (see the overlayFrame mock above)
// reflects straight from tx.value/ty.value, so this reads the ghost's real current position rather
// than trusting that it settled correctly.
const positionOf = (node: { children: readonly (string | { props: { style?: unknown } })[] }) => {
  const inner = node.children[0] as { props: { style?: unknown } }
  const transform = (styleOf(inner).transform ?? []) as { translateX?: number; translateY?: number }[]
  const x = transform.find((t) => t.translateX !== undefined)?.translateX
  const y = transform.find((t) => t.translateY !== undefined)?.translateY
  return { x, y }
}

// Steps the fake clock in small increments, flushing React between them like real time would - a single big
// jump inside one act() would batch every state update to the very end.
async function advance(ms: number) {
  for (let t = 0; t < ms; t += 25) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(Math.min(25, ms - t))
    })
  }
}

async function renderProvider() {
  return await render(
    <DealProvider>
      <Capture />
    </DealProvider>
  )
}

const totalMs = (count: number, stagger = DEAL_STAGGER_MS) => count * stagger + (DEAL_SPRING.duration ?? 0) + 1000

describe('ghostPoolSize', () => {
  const window = (DEAL_SPRING.duration ?? 0) + LOOKAHEAD_MS

  it('needs nothing for an empty deal and one slot for a single card', () => {
    expect(ghostPoolSize([], 280, LOOKAHEAD_MS, 2)).toBe(0)
    expect(ghostPoolSize([0], 280, LOOKAHEAD_MS, 0)).toBe(1)
  })

  it('counts the most flights that can overlap, plus slack', () => {
    const delays = Array.from({ length: 54 }, (_, i) => i * 35)
    // A ghost is occupied from 150ms before its flight to 280ms after it starting: ceil(430 / 35) = 13 at once.
    expect(ghostPoolSize(delays, 280, LOOKAHEAD_MS, 0)).toBe(Math.ceil(window / 35))
    expect(ghostPoolSize(delays, 280, LOOKAHEAD_MS, 2)).toBe(Math.ceil(window / 35) + 2)
  })

  it('never asks for more slots than there are cards', () => {
    expect(ghostPoolSize([0, 10, 20], 280, LOOKAHEAD_MS, 5)).toBe(3)
  })

  it('needs a slot per card when they all leave together', () => {
    expect(ghostPoolSize(Array(8).fill(0), 280, LOOKAHEAD_MS, 0)).toBe(8)
  })

  it('sizes the pool for the flight it was given: a longer flight never gets fewer slots', () => {
    const delays = makeEntries(24).map((e) => e.delayMs)
    expect(dealPoolSize(delays)).toBe(dealPoolSize(delays, DEAL_SPRING.duration ?? 0))
    expect(dealPoolSize(delays, FLIGHT_SPRING.duration ?? 0)).toBeGreaterThan(dealPoolSize(delays))
  })

  it('needs fewer slots the more spread out the flights are', () => {
    expect(
      ghostPoolSize(
        Array.from({ length: 20 }, (_, i) => i * 500),
        280,
        LOOKAHEAD_MS,
        0
      )
    ).toBe(1)
  })
})

describe('DealProvider ghost pool', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockPlayCardSound.mockClear()
    mockHapticCard.mockClear()
    mockMounts.count = 0
    mockShown.length = 0
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('launches only the cards about to fly, not a copy of the whole deal', async () => {
    await renderProvider()

    await act(async () => controller.start(makeEntries(54), CARD_WIDTH, jest.fn(), jest.fn()))

    expect(flying().length).toBeGreaterThan(0)
    expect(flying().length).toBeLessThanOrEqual(10)
  })

  it('mounts no more card views than the pool holds, however many cards are dealt', async () => {
    await renderProvider()
    const entries = makeEntries(54)
    const pool = dealPoolSize(entries.map((e) => e.delayMs))
    await act(async () => controller.start(entries, CARD_WIDTH, jest.fn(), jest.fn()))

    for (let t = 0; t < totalMs(54); t += 25) await advance(25)

    expect(ghosts().length).toBe(0) // the pool is torn down once the deal is over
    expect(mockMounts.count).toBeGreaterThan(0)
    expect(mockMounts.count).toBeLessThanOrEqual(pool)
    expect(pool).toBeLessThan(25)
  })

  it('lands every card exactly once, in order, and reports the deal complete once', async () => {
    await renderProvider()
    const landed: string[] = []
    const onAllLanded = jest.fn()
    await act(async () => controller.start(makeEntries(54), CARD_WIDTH, (id) => landed.push(id), onAllLanded))

    await advance(totalMs(54))

    expect(landed).toHaveLength(54)
    expect(new Set(landed).size).toBe(54)
    expect(landed).toEqual(makeEntries(54).map((e) => e.cardId))
    expect(onAllLanded).toHaveBeenCalledTimes(1)
    expect(ghosts().length).toBe(0)
  })

  // A face-down deal reuses slots between identical card backs, so relaunching must not re-render the card at all.
  it('does not re-render a reused slot for a face-down deal (identical card backs)', async () => {
    await renderProvider()
    const entries = makeEntries(54, 'c', false)
    const pool = dealPoolSize(entries.map((e) => e.delayMs))
    await act(async () => controller.start(entries, CARD_WIDTH, jest.fn(), jest.fn()))

    await advance(totalMs(54))

    // One render per slot's first launch and none for the ~40 relaunches after.
    expect(mockShown.length).toBeLessThanOrEqual(pool)
  })

  it('shows every card that flies when the deal is face-up (each reuse swaps the face)', async () => {
    await renderProvider()
    await act(async () => controller.start(makeEntries(54, 'c', true), CARD_WIDTH, jest.fn(), jest.fn()))

    await advance(totalMs(54))

    const shown = new Set(mockShown)
    makeEntries(54).forEach((e) => expect(shown.has(e.cardId)).toBe(true))
  })

  it('keeps each card flying at its own scheduled time (no card lands early)', async () => {
    await renderProvider()
    const landedAt: Record<string, number> = {}
    let elapsed = 0
    await act(async () => controller.start(makeEntries(20), CARD_WIDTH, (id) => (landedAt[id] = elapsed), jest.fn()))

    for (; elapsed < totalMs(20); elapsed += 25) await advance(25)

    makeEntries(20).forEach((e) => expect(landedAt[e.cardId]).toBeGreaterThanOrEqual(e.delayMs))
  })

  it('still lands every card of a compressed deal, whose flights overlap much more', async () => {
    await renderProvider()
    const landed: string[] = []
    const onAllLanded = jest.fn()
    await act(async () => controller.start(makeEntries(52, 'c', true, 18), CARD_WIDTH, (id) => landed.push(id), onAllLanded))

    await advance(totalMs(52, 18))

    expect(landed).toHaveLength(52)
    expect(new Set(landed).size).toBe(52)
    expect(onAllLanded).toHaveBeenCalledTimes(1)
  })

  it('a later card always paints above an earlier one, whichever slot it flies in', async () => {
    await renderProvider()
    await act(async () => controller.start(makeEntries(54, 'c', true), CARD_WIDTH, jest.fn(), jest.fn()))

    // Run long enough that slots have been reused, then read the paint order of everything in the air.
    await advance(1000)
    const inAir = flying().map((node) => ({
      id: within(node)
        .getByTestId(/^ghost-/)
        .props.testID.replace('ghost-', ''),
      z: styleOf(node).zIndex as number
    }))

    expect(inAir.length).toBeGreaterThan(1)
    const byPaintOrder = [...inAir].sort((a, b) => a.z - b.z).map((g) => Number(g.id.replace('c', '')))
    expect(byPaintOrder).toEqual([...byPaintOrder].sort((a, b) => a - b))
  })

  it('hides a slot the moment its card lands, before the rest of the deal is over', async () => {
    await renderProvider()
    await act(async () => controller.start(makeEntries(54), CARD_WIDTH, jest.fn(), jest.fn()))

    await advance(900)

    const idle = ghosts().filter((node) => opacityOf(node) === 0)
    expect(idle.length).toBeGreaterThan(0)
  })

  it('a skip tap lands the flying AND the not-yet-launched cards at once', async () => {
    await renderProvider()
    const landed: string[] = []
    const onAllLanded = jest.fn()
    await act(async () => controller.start(makeEntries(54), CARD_WIDTH, (id) => landed.push(id), onAllLanded))
    await advance(300)
    expect(landed.length).toBeLessThan(54)

    await fireEvent.press(screen.getByTestId('deal-skip-layer'))

    expect(landed).toHaveLength(54)
    expect(new Set(landed).size).toBe(54)
    expect(onAllLanded).toHaveBeenCalledTimes(1)
    expect(ghosts().length).toBe(0)
    expect(screen.queryByTestId('deal-skip-layer')).toBeNull()
    // Every card still gets its one sound (throttled downstream), including ones that never launched.
    expect(mockPlayCardSound.mock.calls.length).toBeGreaterThanOrEqual(54)

    // ...and nothing fires late once the timers run out.
    await advance(5000)
    expect(landed).toHaveLength(54)
    expect(onAllLanded).toHaveBeenCalledTimes(1)
  })

  it('caps haptics at one per 40ms even when cards are dealt every 18ms (sound is capped downstream)', async () => {
    await renderProvider()
    await act(async () => controller.start(makeEntries(52, 'c', true, 18), CARD_WIDTH, jest.fn(), jest.fn()))

    await advance(totalMs(52, 18))

    expect(mockPlayCardSound).toHaveBeenCalledTimes(52)
    expect(mockHapticCard.mock.calls.length).toBeLessThan(30)
    expect(mockHapticCard.mock.calls.length).toBeGreaterThan(10)
  })

  it('shows the skip layer only while a deal is in flight', async () => {
    await renderProvider()
    expect(screen.queryByTestId('deal-skip-layer')).toBeNull()

    await act(async () => controller.start(makeEntries(5), CARD_WIDTH, jest.fn(), jest.fn()))
    expect(screen.getByTestId('deal-skip-layer')).toBeTruthy()

    await advance(totalMs(5))
    expect(screen.queryByTestId('deal-skip-layer')).toBeNull()
  })

  it('a new deal started mid-flight replaces the old one cleanly', async () => {
    await renderProvider()
    const firstLanded: string[] = []
    const secondLanded: string[] = []
    const secondAll = jest.fn()
    await act(async () => controller.start(makeEntries(30, 'a'), CARD_WIDTH, (id) => firstLanded.push(id), jest.fn()))
    await advance(200)

    await act(async () => controller.start(makeEntries(12, 'b'), CARD_WIDTH, (id) => secondLanded.push(id), secondAll))
    await advance(totalMs(12))

    expect(secondLanded).toHaveLength(12)
    expect(secondAll).toHaveBeenCalledTimes(1)
    expect(ghosts().length).toBe(0)
    // No card of the replaced deal keeps landing into the new deal's callbacks.
    expect(secondLanded.every((id) => id.startsWith('b'))).toBe(true)
  })

  // Bug: cancel() cleared its own JS timers/refs but never stopped the slot's actual Reanimated
  // spring (tx/ty/opacity) and never reset React state `job` - a slot cancelled mid-flight kept
  // animating toward ITS OLD deal's destination on the UI thread and then just sat there, frozen,
  // rendering as if still flying (a real zIndex, not the idle style), until this same slot index was
  // eventually reused by the new deal's own launch() - whose plain shared-value writes finally
  // overwrote it. Confirmed live: rapid repeated "New Game" taps made a card visibly fly to a stale,
  // meaningless position and sit there before "snapping" once its slot was recycled. Every actively
  // flying slot replaced by a new deal must have its spring stopped synchronously, in the SAME tick
  // start() cancels it - not whenever its generation-keyed unmount eventually commits.
  it("stops every one of deal A's mounted slots' springs the instant deal B replaces it, mid-flight", async () => {
    await renderProvider()
    const entriesA = makeEntries(30, 'a')
    const poolSizeA = dealPoolSize(entriesA.map((e) => e.delayMs))
    await act(async () => controller.start(entriesA, CARD_WIDTH, jest.fn(), jest.fn()))
    await advance(200) // several of the 30 are launched (mid-spring) by now, none landed yet
    expect(flying().length).toBeGreaterThan(0) // sanity: this run really does exercise a mid-flight replace
    ;(cancelAnimation as jest.Mock).mockClear()

    await act(async () => controller.start(makeEntries(12, 'b'), CARD_WIDTH, jest.fn(), jest.fn()))

    // start() cancels every one of deal A's mounted slots (flying or still idle-waiting) - 3 shared
    // values (tx, ty, opacity) stopped per slot, not just the ones caught mid-spring at this instant.
    expect(cancelAnimation).toHaveBeenCalledTimes(poolSizeA * 3)
  })

  // Bug: useOverlayFrame's cx/cy/lw/lh start at 0 until its own async measureInWindow lands - on a
  // fresh game screen's very first deal, that can still be in flight when this provider's own
  // [generation, launchDue] effect would otherwise start the clock (both fire around the same
  // mount). The first cards then computed toLocal() against a zero'd frame - a wrong, SHARED
  // position (every such card converges on the same spot, since they all divide by the same zero) -
  // and jumped to their real one the instant the real measurement landed and reactively recomputed
  // every still-mounted ghost's style. Confirmed live: "a small percentage" of a deal's earliest
  // cards flying to nowhere before snapping into place - never the middle or tail of a deal.
  it('does not start launching until the overlay frame has actually been measured', async () => {
    overlayFrameControl.initialReady = false
    try {
      await renderProvider()
      await act(async () => controller.start(makeEntries(5, 'a'), CARD_WIDTH, jest.fn(), jest.fn()))
      await advance(LOOKAHEAD_MS + 50) // well past when the first card would have launched, were it not gated

      expect(flying().length).toBe(0) // nothing has launched - not even into a wrong position

      await act(async () => overlayFrameControl.setReady?.(true)) // the overlay's real measurement finally lands
      await advance(LOOKAHEAD_MS + 50)

      expect(flying().length).toBeGreaterThan(0) // now it proceeds, for the first time
    } finally {
      overlayFrameControl.initialReady = true
    }
  })

  // Bug: the landing timer was a blind `setTimeout(notify, wait + duration)` - correct only if the UI
  // thread actually ran the spring on schedule, which a busy commit (this deal's own ~52-card initial
  // board mount, worst right at a deal's start) can't guarantee. The JS timer keeps time regardless,
  // so it could fire while the ghost's OWN shared values were still sitting at (or near) its origin -
  // the real card then popped in far from where the ghost had visibly gotten to. Confirmed live,
  // reproduced, and reported as "a small percentage of cards fly to nowhere, then teleport" - never
  // every card (most launch once the initial congestion has cleared) and never the same handful twice
  // (real device JS/UI thread scheduling, not a fixed one). checkSettled polls the ghost's actual
  // tx/ty instead of trusting the clock, so notify() only ever fires once it has genuinely arrived (or
  // SETTLE_MAX_EXTRA_MS has passed - see the next test for that backstop).
  describe('landing settle-verification', () => {
    afterEach(() => {
      ;(withSpring as jest.Mock).mockImplementation((value: number) => value)
    })

    it('does not land a card until its ghost actually reads at the destination, even once the nominal wait+duration has passed', async () => {
      // Every axis "arrives" 1000 short of its real target - the UI thread never actually got there.
      ;(withSpring as jest.Mock).mockImplementation((value: number) => value - 1000)
      await renderProvider()
      const landed: string[] = []
      await act(async () => controller.start(makeEntries(1, 'a'), CARD_WIDTH, (id) => landed.push(id), jest.fn()))

      await advance(LOOKAHEAD_MS + (DEAL_SPRING.duration ?? 0) + 50) // well past the old, unconditional timer's own deadline
      expect(landed).toHaveLength(0) // still not landed - checkSettled correctly finds it 1000 away, not close enough

      // Now let the UI thread "catch up" - future calls resolve to the real target.
      ;(withSpring as jest.Mock).mockImplementation((value: number) => value)
      await advance(SETTLE_MAX_EXTRA_MS) // covers the next dealSpring's own delayed launch below and a poll cycle
      // Still nothing: mockImplementation only affects a FUTURE withSpring call (a fresh launch), not
      // the shared value this card's flight already resolved to 1000 short of target - matching a real
      // "the UI thread never gets a chance to redo this exact flight" case, which SETTLE_MAX_EXTRA_MS
      // (not a spontaneous catch-up) is what actually has to resolve it. See the next test for that.
    })

    it('gives up and lands the card anyway once SETTLE_MAX_EXTRA_MS has passed, so a truly stuck ghost cannot stall the deal forever', async () => {
      ;(withSpring as jest.Mock).mockImplementation((value: number) => value - 1000) // never actually arrives
      await renderProvider()
      const landed: string[] = []
      const allLanded = jest.fn()
      await act(async () => controller.start(makeEntries(1, 'a'), CARD_WIDTH, (id) => landed.push(id), allLanded))

      await advance(LOOKAHEAD_MS + (DEAL_SPRING.duration ?? 0) + 50)
      expect(landed).toHaveLength(0) // not yet - see the previous test

      await advance(SETTLE_MAX_EXTRA_MS + 100) // the backstop's own deadline passes
      expect(landed).toEqual(['a0']) // lands anyway - the deal is never stuck waiting on a ghost forever
      expect(allLanded).toHaveBeenCalledTimes(1)
    })

    // The backstop above used to call notify() with no position check at all - reporting a card
    // "landed" while its ghost was still exactly wherever it got stranded (here, 1000px short on
    // both axes). That is the ORIGINAL bug this whole mechanism exists to prevent, just reached via
    // the timeout path instead of a blind clock - confirmed live: a direct JS-thread lag probe showed
    // this path is far from rare (the thread was stalled more than it was free for over half of a
    // real deal), so "eventually gives up" without a position guarantee reproduces the exact symptom
    // reported ("cards fly to nowhere, then teleport") on a bad enough device. checkSettled must snap
    // the ghost to its true destination before notify() fires, so the reveal itself is never wrong.
    it('snaps the ghost to its true destination before giving up, so the backstop never reveals the real card in the wrong place', async () => {
      // Three cards, only the middle one ever gets the "stuck 1000px short" treatment: a0 resolves
      // normally and lands fast, a1 is the one under test, and a3-late's huge delay keeps it
      // unlaunched (and so the deal still "in progress") through the whole test - otherwise, with
      // only the stuck card left to land, its own landing would ALSO be the deal's last one, and the
      // whole ghost pool (dealing && poolSize > 0) unmounts in that very same commit, taking the
      // rendered proof of the snap down with it before this test could ever observe it.
      let calls = 0
      ;(withSpring as jest.Mock).mockImplementation((value: number) => {
        calls++
        return calls <= 2 ? value : value - 1000 // a0's tx/ty (calls 1-2) resolve for real; a1's (3-4) never do
      })
      await renderProvider()
      const landed: string[] = []
      const entries = [...makeEntries(2, 'a'), { ...makeEntries(1, 'z')[0], delayMs: 60_000 }]
      await act(async () => controller.start(entries, CARD_WIDTH, (id) => landed.push(id), jest.fn()))

      await advance(DEAL_STAGGER_MS + LOOKAHEAD_MS + (DEAL_SPRING.duration ?? 0) + 50)
      expect(landed).toEqual(['a0']) // a0 landed for real; a1 is still stuck 1000px short; z0 hasn't even launched
      const stuckGhost = flying().find((node) => within(node).queryByTestId('ghost-a1') !== null)
      expect(stuckGhost).toBeDefined()
      const slotTestId = stuckGhost!.props.testID as string

      await advance(SETTLE_MAX_EXTRA_MS + 100) // a1's backstop deadline passes
      expect(landed).toEqual(['a0', 'a1']) // z0 still not due - the deal (and its pool) is still open
      // The same slot, now idle - its last rendered position must be a1's REAL destination (10, 20
      // per makeEntries), not the -990/-980 it was actually stuck at when checkSettled gave up.
      const settledSlot = ghosts().find((node) => node.props.testID === slotTestId)
      expect(positionOf(settledSlot!)).toEqual({ x: 10, y: 20 })
    })
  })

  // The old slots stay mounted (timers live) until the commit AFTER start() - a timer firing in that gap used to feed the new
  // deal foreign card ids and out-of-range slot numbers (a reproduced permanent stall at 15 of 40 cards).
  it('a deal replaced before its old slots unmount cannot report into the new one', async () => {
    await renderProvider()
    const secondLanded: string[] = []
    const secondAll = jest.fn()
    await act(async () => controller.start(makeEntries(52, 'a', true, 18), CARD_WIDTH, jest.fn(), jest.fn()))
    await advance(500)

    // A's slot timers fire INSIDE this act, before React commits B's slots.
    await act(async () => {
      controller.start(makeEntries(40, 'b', true), CARD_WIDTH, (id) => secondLanded.push(id), secondAll)
      jest.advanceTimersByTime(600)
    })
    await advance(totalMs(40))

    expect(secondLanded.filter((id) => !id.startsWith('b'))).toEqual([])
    expect(secondLanded).toHaveLength(40)
    expect(new Set(secondLanded).size).toBe(40)
    expect(secondAll).toHaveBeenCalledTimes(1)
    expect(ghosts().length).toBe(0)
    expect(screen.queryByTestId('deal-skip-layer')).toBeNull()
  })

  it('two starts in one batch run only the second', async () => {
    await renderProvider()
    const firstLanded = jest.fn()
    const secondLanded: string[] = []
    const secondAll = jest.fn()

    await act(async () => {
      controller.start(makeEntries(10, 'a'), CARD_WIDTH, firstLanded, jest.fn())
      controller.start(makeEntries(10, 'b'), CARD_WIDTH, (id) => secondLanded.push(id), secondAll)
    })
    await advance(totalMs(10))

    expect(firstLanded).not.toHaveBeenCalled()
    expect(secondLanded).toEqual(makeEntries(10, 'b').map((e) => e.cardId))
    expect(secondAll).toHaveBeenCalledTimes(1)
  })

  it('a card that landed is not relaunched until the commit that hides it has happened', async () => {
    await renderProvider()
    await act(async () => controller.start(makeEntries(52, 'c', true, 18), CARD_WIDTH, jest.fn(), jest.fn()))

    // Every commit: whatever a slot is showing while it is flying must be a card that has not landed yet - if a slot were
    // relaunched in its landing tick, its wrapper would go card1 -> card2 without ever being observed hidden.
    const seenHidden = new Set<string>()
    let relaunchedWithoutHiding = 0
    const lastFlying: Record<string, string> = {}
    for (let t = 0; t < totalMs(52, 18); t += 25) {
      await advance(25)
      ghosts().forEach((node) => {
        const slot = node.props.testID as string
        const shown = within(node).queryByTestId(/^ghost-/)?.props.testID as string | undefined
        if (opacityOf(node) === 0) {
          seenHidden.add(slot)
          delete lastFlying[slot]
        } else if (shown) {
          if (lastFlying[slot] && lastFlying[slot] !== shown && !seenHidden.has(slot)) relaunchedWithoutHiding++
          lastFlying[slot] = shown
          seenHidden.delete(slot)
        }
      })
    }

    expect(relaunchedWithoutHiding).toBe(0)
  })

  it('unmounting mid-deal stops everything: no callback fires afterwards', async () => {
    const view = await renderProvider()
    const landed: string[] = []
    const onAllLanded = jest.fn()
    await act(async () => controller.start(makeEntries(30, 'c', true), CARD_WIDTH, (id) => landed.push(id), onAllLanded))
    await advance(300)
    const before = landed.length

    await view.unmount()
    await advance(3000)

    expect(landed).toHaveLength(before)
    expect(onAllLanded).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('a duplicated cardId cannot leave the deal (and its skip layer) stuck', async () => {
    await renderProvider()
    const entries = makeEntries(6)
    entries[3] = { ...entries[3], cardId: entries[1].cardId }
    const onAllLanded = jest.fn()

    await act(async () => controller.start(entries, CARD_WIDTH, jest.fn(), onAllLanded))
    await advance(totalMs(6))

    expect(onAllLanded).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('deal-skip-layer')).toBeNull()
  })

  it('completes the deal even if a landing callback throws', async () => {
    await renderProvider()
    const errors: unknown[] = []
    const onAllLanded = jest.fn()
    await act(async () =>
      controller.start(
        makeEntries(3),
        CARD_WIDTH,
        (id) => {
          if (id === 'c2') throw new Error('boom')
        },
        onAllLanded
      )
    )
    // The throw surfaces from a timer; swallow it like an error boundary would so the test can inspect the outcome.
    for (let t = 0; t < totalMs(3); t += 25) {
      try {
        await advance(25)
      } catch (error) {
        errors.push(error)
      }
    }

    expect(onAllLanded).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('deal-skip-layer')).toBeNull()
  })

  // The deal's clock starts when the slots have mounted, not at start(): a slow first commit (a busy board, a slow phone)
  // must delay every departure, not spend the first cards' delays and send them all off in the same frame.
  it('keeps the first cards staggered even when mounting the pool is slow', async () => {
    const departures: number[] = []
    mockPlayCardSound.mockImplementation(() => departures.push(Date.now()))
    await renderProvider()

    await act(async () => {
      controller.start(makeEntries(52, 'c', true, 18), CARD_WIDTH, jest.fn(), jest.fn())
      jest.advanceTimersByTime(150) // the mount takes 150ms before any slot can be launched
    })
    await advance(totalMs(52, 18))

    const first = departures.slice(0, 8)
    expect(first).toHaveLength(8)
    for (let i = 1; i < first.length; i++) expect(first[i] - first[i - 1]).toBeGreaterThanOrEqual(10)
  })

  // A JS stall makes every card that came due meanwhile launch at once; late cards must stream out, not leave as one blob.
  it('spaces out cards that are late after a stall instead of launching them together', async () => {
    const departures: number[] = []
    mockPlayCardSound.mockImplementation(() => departures.push(Date.now()))
    await renderProvider()
    await act(async () => controller.start(makeEntries(52, 'c', true, 18), CARD_WIDTH, jest.fn(), jest.fn()))
    await advance(250)

    // The clock jumps 600ms but no timer fires early - exactly what a long JS stall looks like to the deal.
    jest.setSystemTime(Date.now() + 600)
    await advance(totalMs(52, 18))

    expect(departures).toHaveLength(52)
    const sorted = [...departures].sort((a, b) => a - b)
    // Without the spacing, every card that came due during the stall left in the same instant (26 at once for a full pool).
    // The test clock commits React in 25ms steps, which skews individual departures by a few ms, so assert a bounded burst
    // rather than an exact gap: no more than a handful of cards inside any 12ms window.
    let worstBurst = 0
    for (let i = 0; i < sorted.length; i++) {
      let count = 0
      while (i + count < sorted.length && sorted[i + count] - sorted[i] < 12) count++
      worstBurst = Math.max(worstBurst, count)
    }
    expect(worstBurst).toBeLessThanOrEqual(4)
  })

  it('an empty deal completes immediately', async () => {
    await renderProvider()
    const onAllLanded = jest.fn()

    await act(async () => controller.start([], CARD_WIDTH, jest.fn(), onAllLanded))

    expect(onAllLanded).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('deal-skip-layer')).toBeNull()
  })

  it('a deal of one card works', async () => {
    await renderProvider()
    const landed: string[] = []
    const onAllLanded = jest.fn()

    await act(async () => controller.start(makeEntries(1), CARD_WIDTH, (id) => landed.push(id), onAllLanded))
    await advance(totalMs(1))

    expect(landed).toEqual(['c0'])
    expect(onAllLanded).toHaveBeenCalledTimes(1)
  })

  // Klondike's/Canfield's draw-3 fans fly through here but take every other card move's flight (dragSpring.ts's FLIGHT_SPRING),
  // not the deal's: the spring, the landing check and the pool all have to follow the one passed in.
  it("flies a batch on the spring it is given, instead of the deal's", async () => {
    await renderProvider()
    const landed: string[] = []
    ;(withSpring as jest.Mock).mockClear()

    await act(async () => controller.start(makeEntries(3), CARD_WIDTH, (id) => landed.push(id), jest.fn(), undefined, FLIGHT_SPRING))
    await advance(DEAL_STAGGER_MS * 2 + 25)
    expect((withSpring as jest.Mock).mock.calls.map((call) => call[1])).toEqual(Array(6).fill(FLIGHT_SPRING)) // x and y of each card

    await advance((DEAL_SPRING.duration ?? 0) + 40 - 25) // the last card is past where it would have landed on the deal spring...
    expect(landed).not.toContain('c2')
    await advance((FLIGHT_SPRING.duration ?? 0) - (DEAL_SPRING.duration ?? 0) - 40 + 50) // ...and lands on its own
    expect(landed).toEqual(['c0', 'c1', 'c2'])
  })

  it('keeps flying a deal on the deal spring when none is given', async () => {
    await renderProvider()
    ;(withSpring as jest.Mock).mockClear()
    await act(async () => controller.start(makeEntries(2), CARD_WIDTH, jest.fn(), jest.fn()))
    await advance(DEAL_STAGGER_MS + 25)
    expect((withSpring as jest.Mock).mock.calls.map((call) => call[1])).toEqual(Array(4).fill(DEAL_SPRING))
  })
})

// A ghost slot must never lay out as an exactly-zero frame at the overlay's origin - the wrapper's only child is
// absolutely positioned and the card box is empty until its first launch, so without an explicit size both would.
// That zero frame is what let a React Native (Fabric, iOS) view-recycling bug leave a slot's UIView at its PREVIOUS
// life's position for the whole deal: a recycled view's stored layout is reset to a zero frame, so a new zero frame
// reads as "unchanged" and its center/bounds are never reset. Every ghost such a slot flew landed exactly N fan
// steps below its column (the recycled view had been a tableau card at index N), while the shared values, the
// shadow tree and measureInWindow all said it was right - see GhostSlot's slotSize comment for the full account.
// Pinned here because nothing else about the layout ever needed the size, so it is exactly the kind of "harmless
// cleanup" a later pass would otherwise remove.
describe('DealProvider ghost slot frames', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('gives every slot wrapper and its card box an explicit, non-zero card-sized frame', async () => {
    await renderProvider()
    await act(async () => controller.start(makeEntries(6), CARD_WIDTH, jest.fn(), jest.fn()))

    const slots = ghosts()
    expect(slots.length).toBeGreaterThan(0)
    for (const slot of slots) {
      const wrapper = styleOf(slot)
      expect(wrapper.width).toBe(CARD_WIDTH)
      expect(wrapper.height).toBeGreaterThan(0)
      const inner = styleOf(slot.children[0] as { props: { style?: unknown } })
      expect(inner.width).toBe(CARD_WIDTH)
      expect(inner.height).toBeGreaterThan(0)
    }
  })
})

// A card's departure is an ABSOLUTE deadline, fixed when its slot is launched: the React commit that shows a face-up card (tens of ms
// for a court card) counts against the lookahead instead of pushing the departure late.
describe('DealProvider absolute-deadline departures', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockPlayCardSound.mockClear()
    mockHapticCard.mockClear()
    mockMounts.count = 0
    mockShown.length = 0
    mockRenderLatency.ids.clear()
  })
  afterEach(() => {
    jest.useRealTimers()
    mockRenderLatency.ids.clear()
  })

  // Runs one deal and returns every card's take-off and landing time (ms since start). Cards in `slow` take mockRenderLatency.ms to
  // render their face the first time it is drawn.
  async function runDeal(entries: DealCardSpec[], stagger: number, slow: string[]) {
    mockRenderLatency.ids = new Set(slow)
    const t0 = Date.now()
    const dealtAt: Record<string, number> = {}
    const landedAt: Record<string, number> = {}
    await act(async () =>
      controller.start(
        entries,
        CARD_WIDTH,
        (id) => (landedAt[id] = Date.now() - t0),
        jest.fn(),
        (id) => (dealtAt[id] = Date.now() - t0)
      )
    )
    await advance(totalMs(entries.length, stagger))
    return { dealtAt, landedAt, unspent: mockRenderLatency.ids.size }
  }

  it('departs a card on its scheduled time even when the commit that shows its face is slow', async () => {
    await renderProvider()
    const entries = makeEntries(20, 'c', true, 40)
    const baseline = await runDeal(entries, 40, [])
    const slowed = await runDeal(entries, 40, ['c8'])

    expect(slowed.unspent).toBe(0) // the slow render really happened (and cost 60ms of the fake clock)
    // Without the absolute deadline the springs/take-off timer started only AFTER the 60ms commit, so this card left ~60ms late.
    expect(slowed.dealtAt.c8 - baseline.dealtAt.c8).toBeLessThanOrEqual(25)
    // Every card that had launch runway left is unaffected, not just the slow one.
    entries.slice(9).forEach((e) => expect(Math.abs(slowed.dealtAt[e.cardId] - baseline.dealtAt[e.cardId])).toBeLessThanOrEqual(25))
  })

  it('never departs a card before its scheduled time, however slow or fast its commit was', async () => {
    await renderProvider()
    const entries = makeEntries(20, 'c', true, 40)
    const { dealtAt } = await runDeal(entries, 40, ['c3', 'c8', 'c15'])

    expect(Object.keys(dealtAt)).toHaveLength(20)
    entries.forEach((e) => expect(dealtAt[e.cardId]).toBeGreaterThanOrEqual(e.delayMs))
  })

  it('keeps the landing timer on the same deadline: every card still flies its full spring after taking off', async () => {
    await renderProvider()
    const entries = makeEntries(20, 'c', true, 40)
    const { dealtAt, landedAt } = await runDeal(entries, 40, ['c8'])

    entries.forEach((e) => expect(landedAt[e.cardId] - dealtAt[e.cardId]).toBeGreaterThanOrEqual((DEAL_SPRING.duration ?? 0) - 1))
    expect(Object.keys(landedAt)).toHaveLength(20)
  })

  it('two cards launched in ONE slow commit still leave apart from each other, not in the same frame', async () => {
    await renderProvider()
    const entries = makeEntries(20, 'c', true, 33.7)
    // c0 and c1 are launched together at the start, and c0's face takes 60ms to commit: c1's 34ms of runway is gone before its effect runs.
    const { dealtAt } = await runDeal(entries, 34, ['c0'])

    // Both find their deadline passed, but the second is held LATE_LAUNCH_MIN_GAP_MS (12ms) behind the first instead of leaving with it.
    expect(dealtAt.c1 - dealtAt.c0).toBeGreaterThanOrEqual(12)
    // ...and that spacing is a floor for late cards only: nothing ever leaves before its scheduled time, and the deal recovers its schedule.
    entries.forEach((e) => expect(dealtAt[e.cardId]).toBeGreaterThanOrEqual(Math.floor(e.delayMs))) // Date.now() is whole ms
    expect(dealtAt.c10 - entries[10].delayMs).toBeLessThanOrEqual(25)
  })

  it('a face-down deal (no commit to wait for) departs exactly as before', async () => {
    await renderProvider()
    const entries = makeEntries(20, 'c', false, 40)
    const { dealtAt } = await runDeal(entries, 40, [])

    entries.forEach((e) => {
      expect(dealtAt[e.cardId]).toBeGreaterThanOrEqual(e.delayMs)
      expect(dealtAt[e.cardId] - e.delayMs).toBeLessThanOrEqual(25)
    })
  })
})

// A launch pass hands at most two face-up cards to slots (one React commit's worth); face-down cards - which cost no commit - are never capped.
describe('DealProvider face-up launch cap', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockPlayCardSound.mockClear()
    mockHapticCard.mockClear()
    mockMounts.count = 0
    mockShown.length = 0
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('launches at most two face-up cards in the first pass, then feeds the rest on a short tick', async () => {
    await renderProvider()

    await act(async () => controller.start(makeEntries(52, 'c', true, 33.7), CARD_WIDTH, jest.fn(), jest.fn()))

    // Five cards are due within the 150ms lookahead, but only two may share this commit.
    expect(flying().length).toBeGreaterThan(0)
    expect(flying().length).toBeLessThanOrEqual(2)

    await advance(40)

    // Not starved: the short tick caught the queue up with the lookahead (5-6 cards are within 150ms of their flight by now).
    expect(flying().length).toBeGreaterThanOrEqual(5)
    expect(flying().length).toBeLessThanOrEqual(8)
  })

  it('does not cap a face-down deal: every card due within the lookahead is launched in the first pass', async () => {
    await renderProvider()

    await act(async () => controller.start(makeEntries(52, 'c', false, 33.7), CARD_WIDTH, jest.fn(), jest.fn()))

    expect(flying().length).toBeGreaterThanOrEqual(5)
    expect(flying().length).toBeLessThanOrEqual(10)
  })

  it('counts only face-up cards against the cap', async () => {
    await renderProvider()
    const faceDown = makeEntries(4, 'd', false, 0)
    const faceUp = makeEntries(3, 'u', true, 0)

    await act(async () => controller.start([...faceDown, ...faceUp], CARD_WIDTH, jest.fn(), jest.fn()))

    // All four backs and two of the three faces; the third face waits for the next tick.
    expect(flying()).toHaveLength(6)
    await advance(16)
    expect(flying()).toHaveLength(7)
  })

  it('lands every card and completes even when a whole face-up deal is due at once (nothing is stranded behind the cap)', async () => {
    await renderProvider()
    const landed: string[] = []
    const onAllLanded = jest.fn()

    await act(async () => controller.start(makeEntries(40, 'c', true, 0), CARD_WIDTH, (id) => landed.push(id), onAllLanded))
    expect(flying()).toHaveLength(2)
    await advance(totalMs(40, 0))

    expect(landed).toHaveLength(40)
    expect(new Set(landed).size).toBe(40)
    expect(onAllLanded).toHaveBeenCalledTimes(1)
    expect(ghosts().length).toBe(0)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('a skip tap while the cap is holding cards back lands them all exactly once and leaves no timer behind', async () => {
    await renderProvider()
    const landed: string[] = []
    const onAllLanded = jest.fn()
    await act(async () => controller.start(makeEntries(40, 'c', true, 0), CARD_WIDTH, (id) => landed.push(id), onAllLanded))
    await advance(20)
    expect(landed.length).toBeLessThan(40)

    await fireEvent.press(screen.getByTestId('deal-skip-layer'))
    await advance(2000)

    expect(landed).toHaveLength(40)
    expect(new Set(landed).size).toBe(40)
    expect(onAllLanded).toHaveBeenCalledTimes(1)
    expect(ghosts().length).toBe(0)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('a new deal started while the cap is holding cards back replaces the old one cleanly', async () => {
    await renderProvider()
    const firstLanded: string[] = []
    const secondLanded: string[] = []
    const secondAll = jest.fn()
    await act(async () => controller.start(makeEntries(40, 'a', true, 0), CARD_WIDTH, (id) => firstLanded.push(id), jest.fn()))
    await advance(20)

    await act(async () => controller.start(makeEntries(30, 'b', true, 0), CARD_WIDTH, (id) => secondLanded.push(id), secondAll))
    await advance(totalMs(30, 0))

    expect(firstLanded).toHaveLength(0)
    expect(secondLanded).toHaveLength(30)
    expect(new Set(secondLanded).size).toBe(30)
    expect(secondAll).toHaveBeenCalledTimes(1)
    expect(ghosts().length).toBe(0)
    expect(jest.getTimerCount()).toBe(0)
  })

  // The stall test above pins WHEN late cards depart; this pins how many faces one tick has to commit while catching up.
  it('feeds a stalled face-up deal to the slots a couple of faces per tick, not all the overdue cards at once', async () => {
    await renderProvider()
    const landed: string[] = []
    await act(async () => controller.start(makeEntries(52, 'c', true, 18), CARD_WIDTH, (id) => landed.push(id), jest.fn()))
    await advance(250)
    // The clock jumps 600ms with no timer firing early: a JS stall, after which ~26 cards are overdue for a slot at once.
    jest.setSystemTime(Date.now() + 600)

    let mostFacesInATick = 0
    for (let t = 0; t < totalMs(52, 18); t += 16) {
      const before = mockShown.length
      await act(async () => {
        await jest.advanceTimersByTimeAsync(16)
      })
      mostFacesInATick = Math.max(mostFacesInATick, mockShown.length - before)
    }

    // A pass launches at most 2 face-up cards, so a tick (one launch pass, plus at most one triggered by a slot going idle) shows at most 4.
    expect(mostFacesInATick).toBeLessThanOrEqual(4)
    expect(landed).toHaveLength(52)
  })

  // Every slot that lands runs its own onIdle effect; if each of those launched its own capped pass, k landings in one commit would put ~k
  // faces in the next one. They must share ONE pass (the idle handler only re-arms the launch timer).
  it('lets a burst of landings free slots for a capped pass of faces, not one face per landing slot', async () => {
    const commits: number[] = []
    let seen = 0
    await render(
      <Profiler
        id='deal'
        onRender={() => {
          commits.push(mockShown.length - seen)
          seen = mockShown.length
        }}
      >
        <DealProvider>
          <Capture />
        </DealProvider>
      </Profiler>
    )
    // Twelve faces at t=0 (they all land within ~65ms of each other, a few per test tick) and twelve more due 3s later. The pool is sized
    // for the larger group (14 slots), so once the clock jumps the second group can only trickle in as the first group's slots free up.
    const second = makeEntries(12, 'b', true, 0).map((entry) => ({ ...entry, delayMs: 3000 }))
    const landed: string[] = []
    await act(async () => controller.start([...makeEntries(12, 'a', true, 0), ...second], CARD_WIDTH, (id) => landed.push(id), jest.fn()))
    await advance(120) // the first group is launched (two per pass) and in flight
    jest.setSystemTime(Date.now() + 3000) // a stall: the second group is now due, with every slot but two taken

    commits.length = 0
    seen = mockShown.length
    // One wide step: every landing timer of the first group fires inside it, and React commits them together (a busy JS thread does the
    // same). No slot is free meanwhile, so the launch ticks in the window have nothing to launch into - the next launches can only come
    // from the slots that go idle in that ONE commit.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(330)
    })
    await advance(400)
    expect(Math.max(...commits)).toBeGreaterThan(0)
    // One pass (2 faces) plus at most the capped tick already due (2 more) - never one face per landing slot (~10 of them here).
    expect(Math.max(...commits)).toBeLessThanOrEqual(4)

    await advance(totalMs(24, 0) + 3000)
    expect(landed).toHaveLength(24)
  })
})

// onCardDealt is the take-off counterpart of onCardLanded: it lets a caller react to the instant a card's ghost is drawn over the spot
// it leaves (Pyramid's win sweep empties a source pile only once its last card has actually left it).
describe('DealProvider onCardDealt (take-off)', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockPlayCardSound.mockClear()
    mockHapticCard.mockClear()
    mockMounts.count = 0
    mockShown.length = 0
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("fires once per card, in deal order, never before that card's own scheduled delay and always before it lands", async () => {
    await renderProvider()
    const entries = makeEntries(20, 'c', true)
    const t0 = Date.now()
    const dealtAt: Record<string, number> = {}
    const landedAt: Record<string, number> = {}
    const order: string[] = []
    await act(async () =>
      controller.start(
        entries,
        CARD_WIDTH,
        (id) => (landedAt[id] = Date.now() - t0),
        jest.fn(),
        (id) => {
          order.push(id)
          dealtAt[id] = Date.now() - t0
        }
      )
    )

    await advance(totalMs(20))

    expect(order).toEqual(entries.map((e) => e.cardId)) // every card exactly once, in order
    entries.forEach((e) => {
      // Not when the card is handed to a slot (a slot is launched LOOKAHEAD_MS ahead of its flight): when the flight itself begins.
      expect(dealtAt[e.cardId]).toBeGreaterThanOrEqual(e.delayMs)
      expect(landedAt[e.cardId] - dealtAt[e.cardId]).toBeGreaterThanOrEqual((DEAL_SPRING.duration ?? 0) - 1)
    })
  })

  it("fires when the card's ghost is really up: its slot is launched and showing exactly that card", async () => {
    await renderProvider()
    const entries = makeEntries(12, 'c', true)
    const drawn: Record<string, boolean> = {}
    await act(async () =>
      controller.start(entries, CARD_WIDTH, jest.fn(), jest.fn(), (id) => {
        drawn[id] = flying().some((node) => within(node).queryByTestId(`ghost-${id}`) !== null)
      })
    )

    await advance(totalMs(12))

    expect(Object.keys(drawn)).toHaveLength(12)
    expect(Object.values(drawn).every(Boolean)).toBe(true)
  })

  it('is silent for a deal that was replaced, including a card of it whose slot timer fires before the new deal has mounted', async () => {
    await renderProvider()
    const dealtA: string[] = []
    const dealtB: string[] = []
    await act(async () => controller.start(makeEntries(30, 'a', true), CARD_WIDTH, jest.fn(), jest.fn(), (id) => dealtA.push(id)))
    await advance(200)
    const before = dealtA.length
    expect(before).toBeGreaterThan(0)

    // A's slot timers fire INSIDE this act, before React commits B's slots.
    await act(async () => {
      controller.start(makeEntries(12, 'b', true), CARD_WIDTH, jest.fn(), jest.fn(), (id) => dealtB.push(id))
      jest.advanceTimersByTime(600)
    })
    await advance(totalMs(12))

    expect(dealtA).toHaveLength(before) // nothing of the replaced deal took off after the restart
    expect(dealtB).toEqual(makeEntries(12, 'b').map((e) => e.cardId)) // and the new deal's callback saw only its own cards, all of them
  })

  it('is silent after an empty start() cancels the deal', async () => {
    await renderProvider()
    const dealt: string[] = []
    await act(async () => controller.start(makeEntries(30, 'a', true), CARD_WIDTH, jest.fn(), jest.fn(), (id) => dealt.push(id)))
    await advance(200)
    const before = dealt.length
    expect(before).toBeGreaterThan(0)
    expect(before).toBeLessThan(30)

    await act(async () => controller.start([], CARD_WIDTH, jest.fn(), jest.fn()))
    await advance(totalMs(30))

    expect(dealt).toHaveLength(before)
  })

  it('a skip tap reports every card that had not taken off yet - flying ones and never-launched ones - exactly once', async () => {
    await renderProvider()
    const dealt: string[] = []
    const landed: string[] = []
    await act(async () =>
      controller.start(
        makeEntries(54),
        CARD_WIDTH,
        (id) => landed.push(id),
        jest.fn(),
        (id) => dealt.push(id)
      )
    )
    await advance(300)
    expect(dealt.length).toBeGreaterThan(0)
    expect(dealt.length).toBeLessThan(54)

    await fireEvent.press(screen.getByTestId('deal-skip-layer'))

    expect(dealt).toHaveLength(54)
    expect(new Set(dealt)).toEqual(new Set(makeEntries(54).map((e) => e.cardId)))
    expect(landed).toHaveLength(54)
    await advance(5000) // nothing fires late
    expect(dealt).toHaveLength(54)
  })

  it('a take-off callback that throws cannot strand the deal: a skip still lands every card, and the error still surfaces', async () => {
    await renderProvider()
    const landed: string[] = []
    const onAllLanded = jest.fn()
    const errors: unknown[] = []
    // The rethrown error surfaces from a timer; catch it like an error boundary would so the test can inspect the outcome.
    const advanceCatching = async (ms: number) => {
      for (let t = 0; t < ms; t += 25) {
        try {
          await advance(25)
        } catch (error) {
          errors.push(error)
        }
      }
    }
    await act(async () =>
      controller.start(
        makeEntries(20),
        CARD_WIDTH,
        (id) => landed.push(id),
        onAllLanded,
        () => {
          throw new Error('boom')
        }
      )
    )
    await advanceCatching(100)

    // Every take-off throws, the skip's included (its still-unlaunched cards are reported one after another in a single loop).
    await fireEvent.press(screen.getByTestId('deal-skip-layer'))

    expect(landed).toHaveLength(20)
    expect(onAllLanded).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('deal-skip-layer')).toBeNull()
    await advanceCatching(500)
    expect(errors.length).toBeGreaterThan(0) // the caller's error was not swallowed
  })

  it('reports every take-off again in a following deal that reuses the same card ids (a game has one deck: its ids repeat across deals)', async () => {
    await renderProvider()
    const first: string[] = []
    const second: string[] = []
    await act(async () => controller.start(makeEntries(10, 'c', true), CARD_WIDTH, jest.fn(), jest.fn(), (id) => first.push(id)))
    await advance(totalMs(10))
    expect(first).toHaveLength(10)

    // The very same ids again - a new game's sweep or deal. A take-off ledger kept from the previous deal would swallow all of them.
    await act(async () => controller.start(makeEntries(10, 'c', true), CARD_WIDTH, jest.fn(), jest.fn(), (id) => second.push(id)))
    await advance(totalMs(10))
    expect(second).toEqual(makeEntries(10, 'c').map((e) => e.cardId))
    expect(first).toHaveLength(10) // and nothing leaked back into the first deal's callback
  })

  it('reports a duplicated card id once', async () => {
    await renderProvider()
    const entries = makeEntries(6)
    entries[3] = { ...entries[3], cardId: entries[1].cardId }
    const dealt: string[] = []

    await act(async () => controller.start(entries, CARD_WIDTH, jest.fn(), jest.fn(), (id) => dealt.push(id)))
    await advance(totalMs(6))

    expect(dealt.filter((id) => id === 'c1')).toHaveLength(1)
  })

  it('unmounting mid-deal stops the take-off reports too', async () => {
    const view = await renderProvider()
    const dealt: string[] = []
    await act(async () => controller.start(makeEntries(30, 'c', true), CARD_WIDTH, jest.fn(), jest.fn(), (id) => dealt.push(id)))
    await advance(300)
    const before = dealt.length

    await view.unmount()
    await advance(3000)

    expect(dealt).toHaveLength(before)
  })
})

// Settings.reduceMotion (a standard "Reduce Motion" accessibility preference - see stores/settings.tsx):
// start() lands every card in the same tick it's called, with no ghost ever mounted - the same instant-land
// outcome a mid-deal skip tap already produces for an unlaunched card, just reached without a tap.
describe('DealProvider reduceMotion', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockPlayCardSound.mockClear()
    mockHapticCard.mockClear()
    mockMounts.count = 0
    mockShown.length = 0
    mockReduceMotion.value = true
  })
  afterEach(() => {
    jest.useRealTimers()
    mockReduceMotion.value = false
  })

  it('lands every card synchronously, in entries order, with no ghost ever mounted and no skip layer shown', async () => {
    await renderProvider()
    const entries = makeEntries(20, 'c', true)
    const landed: string[] = []
    const onAllLanded = jest.fn()

    await act(async () => controller.start(entries, CARD_WIDTH, (id) => landed.push(id), onAllLanded))

    expect(landed).toEqual(entries.map((e) => e.cardId)) // every card, once each, in order - no animation to reorder them
    expect(onAllLanded).toHaveBeenCalledTimes(1)
    expect(ghosts()).toHaveLength(0) // no slot ever mounted - not even a hidden idle one
    expect(mockMounts.count).toBe(0)
    expect(screen.queryByTestId('deal-skip-layer')).toBeNull() // dealing never becomes true
  })

  it("still fires onCardDealt once per card - playCardSound too (it throttles internally, invisible to this mock - handleDealt calls it unconditionally, matching a real deal's per-card click), and hapticCard throttled down to one for the whole deal (that gate lives in handleDealt itself, and every call lands in the same fake-timers tick)", async () => {
    await renderProvider()
    const entries = makeEntries(20, 'c', true)
    const dealt: string[] = []

    await act(async () => controller.start(entries, CARD_WIDTH, jest.fn(), jest.fn(), (id) => dealt.push(id)))

    expect(dealt).toEqual(entries.map((e) => e.cardId))
    expect(mockPlayCardSound).toHaveBeenCalledTimes(20)
    expect(mockHapticCard).toHaveBeenCalledTimes(1)
  })

  it('reports a duplicated card id once, same as the animated path', async () => {
    await renderProvider()
    const entries = [...makeEntries(3, 'c', true), { ...makeEntries(1, 'c', true)[0], cardId: 'c1' }] // a second entry for c1
    const landed: string[] = []
    const dealt: string[] = []

    await act(async () =>
      controller.start(
        entries,
        CARD_WIDTH,
        (id) => landed.push(id),
        jest.fn(),
        (id) => dealt.push(id)
      )
    )

    expect(landed.filter((id) => id === 'c1')).toHaveLength(1)
    expect(dealt.filter((id) => id === 'c1')).toHaveLength(1)
  })

  it('replacing a reduceMotion deal with another cleanly - the first never reports into the second', async () => {
    await renderProvider()
    const firstLanded: string[] = []
    const secondLanded: string[] = []
    const secondAll = jest.fn()

    await act(async () => controller.start(makeEntries(10, 'a', true), CARD_WIDTH, (id) => firstLanded.push(id), jest.fn()))
    await act(async () => controller.start(makeEntries(8, 'b', true), CARD_WIDTH, (id) => secondLanded.push(id), secondAll))

    expect(firstLanded).toHaveLength(10) // the first deal still completed on its own callbacks...
    expect(secondLanded).toHaveLength(8) // ...and the second, independently, on its own
    expect(secondLanded.every((id) => id.startsWith('b'))).toBe(true)
    expect(secondAll).toHaveBeenCalledTimes(1)
  })

  it('still takes the empty-entries fast path (onAllLanded only, no per-card callbacks) when there is nothing to deal', async () => {
    await renderProvider()
    const onAllLanded = jest.fn()
    const onCardLanded = jest.fn()

    await act(async () => controller.start([], CARD_WIDTH, onCardLanded, onAllLanded))

    expect(onCardLanded).not.toHaveBeenCalled()
    expect(onAllLanded).toHaveBeenCalledTimes(1)
  })

  it('behaves exactly as the animated path when reduceMotion is off - a same-session regression guard', async () => {
    mockReduceMotion.value = false
    await renderProvider()
    const entries = makeEntries(12, 'c', true)
    const landed: string[] = []

    await act(async () => controller.start(entries, CARD_WIDTH, (id) => landed.push(id), jest.fn()))
    // Unlike the reduceMotion case above, nothing has landed yet right after start() - it takes real (fake) time.
    expect(landed).toHaveLength(0)
    expect(ghosts().length).toBeGreaterThan(0)

    await advance(totalMs(12))
    expect(landed).toHaveLength(12)
  })
})
