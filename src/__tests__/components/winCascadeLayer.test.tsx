import { act, render, screen } from '@testing-library/react-native'
import { useEffect } from 'react'
import { StyleSheet, type ViewStyle } from 'react-native'

import { ChainSpec, useWinCascade, WinCascadeController, WinCascadeGhosts, WinCascadeProvider } from '@/components/winning/WinCascadeLayer'
import { CHAIN_SEGMENT_DELAY_MS } from '@/components/winning/winCascadeMotion'
import type { Card } from '@/engine/types'

// ---------------------------------------------------------------------------------------------------------------------
// The win cascade's ghosts, rendered for real (WinCascadeProvider + WinCascadeGhosts), with Reanimated replaced by a stand-in
// whose shared values are stable per component, whose animated style reads them LIVE, and whose frame callbacks the test fires
// itself with a chosen timestamp - so "where is this ghost, and is it drawn, N ms after the cascade started" is answerable
// exactly. The card art is a bare View; only the ghost's own wrapper (the card's parent) carries the position.
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
jest.mock('@tastic/core', () => ({ useRotation: () => mockRotation, useRotatedWindowDimensions: () => ({ width: 400, height: 800 }) }))
jest.mock('@/components/PlayingCard', () => {
  const { View } = require('react-native')
  return { PlayingCard: ({ card }: { card: { id: string } }) => <View testID={`ghost-${card.id}`} /> }
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

/** performance.now() at the instant the cascade started - what every ghost measures its own elapsed time against. */
let startedAt = 0

async function start(chains: ChainSpec[]) {
  const view = await render(
    <WinCascadeProvider>
      <Capture />
      <WinCascadeGhosts />
    </WinCascadeProvider>
  )
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
const isDrawn = (id: string) => wrapperStyle(id).opacity !== 0
const positionOf = (id: string) => {
  const [{ translateX }, { translateY }] = wrapperStyle(id).transform as [{ translateX: number }, { translateY: number }]
  return { x: translateX, y: translateY }
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.spyOn(Math, 'random').mockReturnValue(0.5)
  mockFrames.clear()
  mockRotation = 0
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

  it('paints each chain head above its own tail (tail-to-head render order)', async () => {
    await start([{ cards: cards(1, 3), origin: { x: 40, y: 300 }, entranceDelayMs: 0 }])

    const order = screen.queryAllByTestId(/^ghost-/).map((node) => node.props.testID)
    expect(order).toEqual(['ghost-c3', 'ghost-c2', 'ghost-c1']) // later sibling paints on top: the head, c1, last
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
