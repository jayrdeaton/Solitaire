import { CARD_ASPECT } from '@tastic/cards'
import { act, render, screen } from '@testing-library/react-native'
import { useEffect } from 'react'
import { StyleSheet, type ViewStyle } from 'react-native'

import { ChainSpec, useWinCascade, WinCascadeController, WinCascadeGhosts, WinCascadeProvider } from '@/components/winning/WinCascadeLayer'
import { cascadeBounds, CHAIN_SEGMENT_DELAY_MS } from '@/components/winning/winCascadeMotion'
import type { Card } from '@/engine/types'

// ---------------------------------------------------------------------------------------------------------------------
// The win cascade's ghosts, rendered for real (WinCascadeProvider + WinCascadeGhosts), with Reanimated replaced by a stand-in
// whose shared values are stable per component, whose animated style reads them LIVE, and whose frame callbacks the test fires
// itself with a chosen timestamp - so "where is this ghost, and is it drawn, N ms after the cascade started" is answerable
// exactly. The card art is a bare View; only the ghost's own wrapper (the card's parent) carries the position. Each face reports
// itself painted from the effect after it mounts (a real face's onLoad comes a frame or two later), so the cascade shows - and
// its clock starts - in the act() that starts it: these tests are about the motion. winCascadeHandoff.test.tsx holds the faces
// back to test the wait itself.
// ---------------------------------------------------------------------------------------------------------------------

const mockFrames = new Set<{ current: (info: { timestamp: number }) => void }>()

jest.mock('react-native-reanimated', () => {
  const base = jest.requireActual('../../__mocks__/react-native-reanimated')
  const { useEffect: useMockEffect, useRef } = require('react')
  return {
    ...base,
    useSharedValue: <T,>(value: T) => useRef({ value }).current,
    // Live: every read of a style property re-runs the updater, so the style always shows the shared values as of NOW.
    useAnimatedStyle: (updater: () => Record<string, unknown>) => {
      const style: Record<string, unknown> = {}
      Object.keys(updater()).forEach((key) => Object.defineProperty(style, key, { enumerable: true, get: () => updater()[key] }))
      return style
    },
    useFrameCallback: (callback: (info: { timestamp: number }) => void) => {
      const ref = useRef(callback)
      ref.current = callback
      useMockEffect(() => {
        mockFrames.add(ref)
        return () => {
          mockFrames.delete(ref)
        }
      }, [])
    }
  }
})
let mockRotation = 0
let mockFrame = { width: 400, height: 800 } // the ROTATED window: width and height swap under a quarter turn
jest.mock('@tastic/core', () => ({ useRotation: () => mockRotation, useRotatedWindowDimensions: () => mockFrame, rotateInsets: (insets: unknown) => insets }))
jest.mock('@/components/PlayingCard', () => {
  const { View } = require('react-native')
  const { useEffect: useMockEffect } = require('react')
  return {
    PlayingCard: ({ card, onFacePainted }: { card: { id: string }; onFacePainted?: () => void }) => {
      useMockEffect(() => onFacePainted?.(), [onFacePainted])
      return <View testID={`ghost-${card.id}`} />
    }
  }
})

const CARD_WIDTH = 64
const card = (n: number): Card => ({ id: `c${n}`, suit: 'spades', rank: n, faceUp: true }) as unknown as Card
const cards = (from: number, count: number): Card[] => Array.from({ length: count }, (_, i) => card(from + i))

let controller: WinCascadeController
function Capture() {
  const winCascade = useWinCascade()
  useEffect(() => {
    controller = winCascade
  })
  return null
}

/** performance.now() at the instant the cascade started (it showed, in the same act() under fake timers - nothing advances
 * the faked clock in between) - what every ghost measures its own elapsed time against. */
let startedAt = 0

const tree = () => (
  <WinCascadeProvider>
    <Capture />
    <WinCascadeGhosts />
  </WinCascadeProvider>
)

async function start(chains: ChainSpec[]) {
  const view = await render(tree())
  await act(async () => {
    startedAt = performance.now()
    controller.startChains(chains, CARD_WIDTH)
  })
  return view
}

/** Fires every ghost's frame callback as if `ms` had passed since the cascade started. */
async function tick(ms: number) {
  await act(async () => {
    mockFrames.forEach((frame) => frame.current({ timestamp: startedAt + ms }))
  })
}

const wrapperStyle = (id: string): ViewStyle => StyleSheet.flatten(screen.getByTestId(`ghost-${id}`).parent!.props.style as ViewStyle)
/** Drawn on screen: neither the ghost's own wrapper nor anything above it (the whole cascade, before it shows) is at opacity 0. */
const isDrawn = (id: string) => {
  for (let node = screen.getByTestId(`ghost-${id}`).parent; node; node = node.parent) if (StyleSheet.flatten(node.props.style as ViewStyle)?.opacity === 0) return false
  return true
}
const positionOf = (id: string) => {
  const [{ translateX }, { translateY }] = wrapperStyle(id).transform as [{ translateX: number }, { translateY: number }]
  return { x: translateX, y: translateY }
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.spyOn(Math, 'random').mockReturnValue(0.5)
  mockFrames.clear()
  mockRotation = 0
  mockFrame = { width: 400, height: 800 }
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('WinCascadeGhosts - before a ghost enters', () => {
  it('draws the head of every chain where the real card stood, even for a chain that enters late', async () => {
    await start([
      { cards: cards(1, 3), origin: { x: 40, y: 300 }, entranceDelayMs: 0 },
      { cards: cards(11, 3), origin: { x: 200, y: 320 }, entranceDelayMs: 220 },
      { cards: cards(21, 3), origin: { x: 300, y: 340 }, entranceDelayMs: 440 }
    ])

    // Every head is on screen, standing on its own origin, from the first frame - well before its own entrance.
    for (const [id, origin] of [
      ['c1', { x: 40, y: 300 }],
      ['c11', { x: 200, y: 320 }],
      ['c21', { x: 300, y: 340 }]
    ] as const) {
      expect(isDrawn(id)).toBe(true)
      expect(positionOf(id)).toEqual(origin)
    }
    await tick(100) // chain 1 is under way; chains 2 and 3 have not entered yet
    expect(isDrawn('c11')).toBe(true)
    expect(positionOf('c11')).toEqual({ x: 200, y: 320 })
    expect(isDrawn('c21')).toBe(true)
    expect(positionOf('c21')).toEqual({ x: 300, y: 340 })
    expect(positionOf('c1')).not.toEqual({ x: 40, y: 300 }) // ...while the first one has left
  })

  it('shows the rest of a chain one card at a time, each as the card ahead of it leaves', async () => {
    await start([{ cards: cards(1, 4), origin: { x: 40, y: 300 }, entranceDelayMs: 0 }])

    expect(isDrawn('c1')).toBe(true)
    for (const id of ['c2', 'c3', 'c4']) expect(isDrawn(id)).toBe(false) // hidden under the head, as in the real pile

    await tick(1) // the head has left; its follower starts CHAIN_SEGMENT_DELAY_MS later and shows from now
    expect(isDrawn('c2')).toBe(true)
    expect(positionOf('c2')).toEqual({ x: 40, y: 300 }) // still parked on the spot the head just left: no gap in the pile
    expect(isDrawn('c3')).toBe(false)

    await tick(CHAIN_SEGMENT_DELAY_MS + 1)
    expect(isDrawn('c3')).toBe(true)
    expect(isDrawn('c4')).toBe(false)
    await tick(2 * CHAIN_SEGMENT_DELAY_MS + 1)
    expect(isDrawn('c4')).toBe(true)
  })

  it('staggers a chain by ITS OWN segmentDelayMs when it has one (a 52-card chain must not trail its head by ~2s), the default when it has none', async () => {
    await start([
      { cards: cards(1, 4), origin: { x: 40, y: 300 }, entranceDelayMs: 0, segmentDelayMs: 10 },
      { cards: cards(11, 4), origin: { x: 200, y: 320 }, entranceDelayMs: 0 }
    ])

    await tick(21) // 21ms in: the tight chain has launched its first three followers (each 10ms behind the last)...
    expect(isDrawn('c3')).toBe(true)
    expect(isDrawn('c4')).toBe(true) // (the card ahead of c4 left at 20ms, one 10ms segment before its own start)
    // ...while the default chain is only just showing its second card (its own 42ms spacing).
    expect(isDrawn('c12')).toBe(true)
    expect(isDrawn('c13')).toBe(false)
    expect(isDrawn('c14')).toBe(false)
    await tick(2 * CHAIN_SEGMENT_DELAY_MS + 1)
    expect(isDrawn('c13')).toBe(true)
  })

  it('a chain with its own segmentDelayMs keeps a constant phase offset of exactly that delay between neighbours once they are all under way', async () => {
    await start([{ cards: cards(1, 3), origin: { x: 40, y: 300 }, entranceDelayMs: 0, segmentDelayMs: 10 }])

    // After the first fall, every card plays the same path a fixed delay apart: card i at time t is the head at time t - 10 * i.
    await tick(700)
    const at700 = ['c1', 'c2', 'c3'].map((id) => positionOf(id))
    await tick(710)
    expect(positionOf('c2')).toEqual(at700[0]) // c2 at 710ms is exactly where the head was at 700ms
    await tick(720)
    expect(positionOf('c3')).toEqual(at700[0]) // c3 at 720 is where the head was at 700
  })

  it('paints each chain head above its own tail, and a later chain above an earlier one (zIndex)', async () => {
    await start([
      { cards: cards(1, 3), origin: { x: 40, y: 300 }, entranceDelayMs: 0 },
      { cards: cards(4, 2), origin: { x: 100, y: 300 }, entranceDelayMs: 0 }
    ])

    const z = (id: string) => wrapperStyle(id).zIndex ?? 0
    expect(z('c1')).toBeGreaterThan(z('c2')) // the head, c1, on top of its own tail
    expect(z('c2')).toBeGreaterThan(z('c3'))
    expect(z('c4')).toBeGreaterThan(z('c5'))
    expect(z('c5')).toBeGreaterThan(z('c1')) // the whole later chain above the earlier one, as the old tree order painted it
  })

  // Each face is a fresh Image, requested in mount order and loaded a few at a time: the heads the paint gate waits on must
  // not queue behind every hidden follower (on the Simulator they then arrived one by one and the piles went to blank Kings).
  it('mounts every chain head first, then every second card, and so on - the order the faces are needed in', async () => {
    await start([
      { cards: cards(1, 3), origin: { x: 40, y: 300 }, entranceDelayMs: 0 },
      { cards: cards(4, 2), origin: { x: 100, y: 300 }, entranceDelayMs: 0 }
    ])

    const order = screen.queryAllByTestId(/^ghost-/).map((node) => node.props.testID)
    expect(order).toEqual(['ghost-c1', 'ghost-c4', 'ghost-c2', 'ghost-c5', 'ghost-c3'])
  })
})

describe('WinCascadeGhosts - cardOrigins', () => {
  const FAN = [
    { x: 40, y: 500 },
    { x: 40, y: 478 },
    { x: 40, y: 456 }
  ]

  it('parks every card of a chain at its own spot, all drawn, before the chain enters', async () => {
    await start([{ cards: cards(1, 3), origin: { x: 40, y: 456 }, cardOrigins: FAN, entranceDelayMs: 500 }])

    cards(1, 3).forEach((c, i) => {
      expect(isDrawn(c.id)).toBe(true) // a real card stood here, so a ghost does
      expect(positionOf(c.id)).toEqual(FAN[i])
    })
    await tick(100) // still 400ms before the chain enters
    cards(1, 3).forEach((c, i) => {
      expect(isDrawn(c.id)).toBe(true)
      expect(positionOf(c.id)).toEqual(FAN[i])
    })
  })

  // Where every card of `spec` is `ms` after the cascade started, then tears the cascade down again.
  async function positionsAt(spec: ChainSpec, ms: number) {
    const view = await start([spec])
    await tick(ms)
    const positions = spec.cards.map((c) => positionOf(c.id))
    await view.unmount()
    return positions
  }
  const fanned: ChainSpec = { cards: cards(1, 3), origin: { x: 40, y: 456 }, cardOrigins: FAN, entranceDelayMs: 0 }
  const plain: ChainSpec = { cards: cards(1, 3), origin: { x: 40, y: 456 }, entranceDelayMs: 0 }
  const V_HALF_PERIOD_MS = 1115 // Math.random -> 0.5

  it('eases the head from its own spot onto the chain path over the first fall', async () => {
    // Halfway through the head's first fall it is still half of its 44px offset (500 - 456) off the path a plain chain takes.
    const [withFan] = await positionsAt(fanned, V_HALF_PERIOD_MS / 2)
    const [without] = await positionsAt(plain, V_HALF_PERIOD_MS / 2)
    expect(withFan.y - without.y).toBeCloseTo(22, 3)
    expect(withFan.x).toBe(without.x) // the fan is vertical: no sideways offset to decay
  })

  it('has converged onto exactly the path a plain chain takes once every card has finished its first fall', async () => {
    const settled = V_HALF_PERIOD_MS + 2 * CHAIN_SEGMENT_DELAY_MS + 5
    expect(await positionsAt(fanned, settled)).toEqual(await positionsAt(plain, settled))
    expect(await positionsAt(fanned, settled + 12_345)).toEqual(await positionsAt(plain, settled + 12_345))
  })

  it('carries each card offset through the same rotation as the chain origin (a landscape hold turns the fan sideways)', async () => {
    mockRotation = 90 // the board is turned a quarter: what runs down the screen runs along the rotated frame's x axis
    await start([{ cards: cards(1, 3), origin: { x: 40, y: 456 }, cardOrigins: FAN, entranceDelayMs: 500 }])

    const [lowest, middle, highest] = [positionOf('c1'), positionOf('c2'), positionOf('c3')]
    // 44px apart on screen top-to-bottom (500 vs 456): the same 44px in the rotated frame, along its x axis, none along y.
    expect(lowest.x - highest.x).toBeCloseTo(44, 3)
    expect(middle.x - highest.x).toBeCloseTo(22, 3)
    expect(lowest.y).toBeCloseTo(highest.y, 3)
    expect(middle.y).toBeCloseTo(highest.y, 3)
  })

  it('leaves a chain without cardOrigins exactly as it was: every card starts on the chain origin', async () => {
    await start([{ cards: cards(1, 3), origin: { x: 40, y: 456 }, entranceDelayMs: 0 }])

    await tick(1)
    // Card 2 is drawn only once its predecessor left, on the origin - not at some fan position.
    expect(positionOf('c2')).toEqual({ x: 40, y: 456 })
    expect(positionOf('c3')).toEqual({ x: 40, y: 456 })
  })

  it('treats a card with no entry of its own as standing on the chain origin', async () => {
    await start([{ cards: cards(1, 3), origin: { x: 40, y: 456 }, cardOrigins: [FAN[0]], entranceDelayMs: 0 }])

    expect(positionOf('c1')).toEqual(FAN[0])
    expect(isDrawn('c1')).toBe(true)
    expect(positionOf('c2')).toEqual({ x: 40, y: 456 })
    expect(isDrawn('c2')).toBe(false) // no spot of its own: it waits under the head like any other follower
  })
})

describe('WinCascadeGhosts - bounce heights and speeds', () => {
  const HEADER_BOTTOM = 56 // no safe-area inset in the tests + GAME_CONTENT_TOP_PADDING
  const V_HALF_PERIOD_MS = 1115 // Math.random -> 0.5: after the first fall and one rise, a head is at the apex

  // Three chains from three different heights, so nothing about their starts could make their apexes agree by accident.
  const CHAINS: ChainSpec[] = [
    { cards: cards(1, 3), origin: { x: 40, y: 300 }, entranceDelayMs: 0 },
    { cards: cards(11, 3), origin: { x: 200, y: 340 }, entranceDelayMs: 220 },
    { cards: cards(21, 3), origin: { x: 300, y: 500 }, entranceDelayMs: 440 }
  ]

  it('sends every chain up to the same height - the bottom of the header, not one ranked height per chain', async () => {
    await start(CHAINS)

    // The head of a chain that entered `delay` ms late is at the top of its first bounce at 2 * vHalf + delay.
    for (const [id, delay] of [
      ['c1', 0],
      ['c11', 220],
      ['c21', 440]
    ] as const) {
      await tick(2 * V_HALF_PERIOD_MS + delay)
      expect(positionOf(id).y).toBeCloseTo(HEADER_BOTTOM, 3)
    }
  })

  it('never lifts a card above the header, at any moment of the cascade', async () => {
    await start(CHAINS)

    for (let ms = 0; ms < 30_000; ms += 250) {
      await tick(ms)
      for (const id of ['c1', 'c11', 'c21']) expect(positionOf(id).y).toBeGreaterThanOrEqual(HEADER_BOTTOM - 1e-6)
    }
  })

  it('gives chains that start from the same spot and head the same way different horizontal speeds, so one cannot stay behind another', async () => {
    // Chains 0 and 2 both head for the far wall first (start walls alternate by chain index) from the very same origin.
    await start([
      { cards: cards(1, 2), origin: { x: 200, y: 300 }, entranceDelayMs: 0 },
      { cards: cards(11, 2), origin: { x: 200, y: 300 }, entranceDelayMs: 0 },
      { cards: cards(21, 2), origin: { x: 200, y: 300 }, entranceDelayMs: 0 }
    ])

    for (const ms of [2000, 4000, 8000, 15_000]) {
      await tick(ms)
      expect(positionOf('c1').x).not.toBeCloseTo(positionOf('c21').x, 0)
    }
  })
})

describe('WinCascadeGhosts - clear', () => {
  it('unmounts every ghost, including the parked ones', async () => {
    await start([
      { cards: cards(1, 3), origin: { x: 40, y: 300 }, entranceDelayMs: 0 },
      { cards: cards(11, 3), origin: { x: 200, y: 320 }, entranceDelayMs: 220 }
    ])
    expect(screen.queryAllByTestId(/^ghost-/)).toHaveLength(6)

    await act(async () => {
      controller.clear()
    })
    expect(screen.queryAllByTestId(/^ghost-/)).toHaveLength(0)
  })
})

describe('WinCascadeGhosts - a rotation while the cascade runs', () => {
  const HEADER_BOTTOM = 56 // no safe-area inset in the tests + GAME_CONTENT_TOP_PADDING
  const CARD_HEIGHT = CARD_WIDTH / CARD_ASPECT
  const PORTRAIT = cascadeBounds({ width: 400, height: 800 }, CARD_WIDTH, CARD_HEIGHT, HEADER_BOTTOM)
  const LANDSCAPE = cascadeBounds({ width: 800, height: 400 }, CARD_WIDTH, CARD_HEIGHT, HEADER_BOTTOM)
  const CHAINS: ChainSpec[] = [
    { cards: cards(1, 3), origin: { x: 40, y: 300 }, entranceDelayMs: 0 },
    { cards: cards(11, 3), origin: { x: 200, y: 340 }, entranceDelayMs: 220 },
    { cards: cards(21, 3), origin: { x: 300, y: 500 }, entranceDelayMs: 440 }
  ]
  const HEADS = ['c1', 'c11', 'c21']

  /** Turns the frame the way FakeLandscapeView does: the same window, read with its width and height swapped. */
  async function turn(view: Awaited<ReturnType<typeof start>>, frame: { width: number; height: number }, rotation: number) {
    mockFrame = frame
    mockRotation = rotation
    await view.rerender(tree())
  }

  it('bounces every card inside the turned frame, out to its new walls and down to its new floor', async () => {
    const view = await start(CHAINS)
    await tick(3000)
    await turn(view, { width: 800, height: 400 }, 90)

    let right = -Infinity
    let low = -Infinity
    for (let ms = 3000; ms < 30_000; ms += 50) {
      await tick(ms)
      for (const id of HEADS) {
        const { x, y } = positionOf(id)
        expect(x).toBeGreaterThanOrEqual(LANDSCAPE.leftX - 1e-6)
        expect(x).toBeLessThanOrEqual(LANDSCAPE.rightX + 1e-6)
        expect(y).toBeGreaterThanOrEqual(LANDSCAPE.apexY - 1e-6)
        expect(y).toBeLessThanOrEqual(LANDSCAPE.floorY + 1e-6) // the portrait floor (686) is far below this 400pt-tall frame
        right = Math.max(right, x)
        low = Math.max(low, y)
      }
    }
    expect(right).toBeGreaterThan(LANDSCAPE.rightX - 15) // out past the portrait frame's right wall (324), to the new one
    expect(low).toBeGreaterThan(LANDSCAPE.floorY - 5)
  })

  // Where every head is `ms` into a cascade that turned to landscape at `turnAtMs` (and back to portrait at `backAtMs`), if at all.
  async function headsAt(ms: number, turnAtMs?: number, backAtMs?: number) {
    const view = await start(CHAINS)
    if (turnAtMs !== undefined) {
      await tick(turnAtMs)
      await turn(view, { width: 800, height: 400 }, 90)
    }
    if (backAtMs !== undefined) {
      await tick(backAtMs)
      await turn(view, { width: 400, height: 800 }, 0)
    }
    await tick(ms)
    const positions = HEADS.map((id) => positionOf(id))
    await view.unmount()
    mockFrame = { width: 400, height: 800 }
    mockRotation = 0
    return positions
  }

  it('carries every card on from the same point of its bounce: nothing restarts, the bounce just takes the new frame', async () => {
    const scaleX = (LANDSCAPE.rightX - LANDSCAPE.leftX) / (PORTRAIT.rightX - PORTRAIT.leftX)
    const scaleY = (LANDSCAPE.floorY - LANDSCAPE.apexY) / (PORTRAIT.floorY - PORTRAIT.apexY)
    for (const ms of [1500, 2600, 7000, 16_000]) {
      const upright = await headsAt(ms)
      const turned = await headsAt(ms, 1000)
      upright.forEach((p, i) => {
        expect(turned[i].x).toBeCloseTo(LANDSCAPE.leftX + (p.x - PORTRAIT.leftX) * scaleX, 6)
        expect(turned[i].y).toBeCloseTo(LANDSCAPE.apexY + (p.y - PORTRAIT.apexY) * scaleY, 6)
      })
    }
  })

  it('is exactly the untouched cascade again once turned back', async () => {
    expect(await headsAt(9000, 1000, 4000)).toEqual(await headsAt(9000))
  })
})
