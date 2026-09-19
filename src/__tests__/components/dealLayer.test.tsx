import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { useEffect } from 'react'

import { type DealAnimator, type DealCardSpec, DealProvider, useDealAnimator } from '@/components/dealing/DealLayer'
import { DEAL_STAGGER_MS } from '@/components/dealing/dealSpring'
import type { Card } from '@/engine/types'

const mockPlayCardSound = jest.fn()
const mockHapticCard = jest.fn()

jest.mock('@/components/useCardSounds', () => ({
  useCardSoundEffects: () => ({ playCardSound: mockPlayCardSound, hapticCard: mockHapticCard })
}))
jest.mock('@/components/overlayFrame', () => ({
  useOverlayFrame: () => ({ overlayRef: { current: null }, frame: {} }),
  toLocal: () => ({ x: 0, y: 0 })
}))
jest.mock('@/components/PlayingCard', () => {
  const { View } = require('react-native')
  return { PlayingCard: ({ card }: { card: { id: string } }) => <View testID={`ghost-${card.id}`} /> }
})
jest.mock('@tastic/core', () => ({ useRotation: () => 0, rotateInsets: (insets: unknown) => insets }))

const CARD_WIDTH = 64

function makeEntries(count: number, prefix = 'c'): DealCardSpec[] {
  return Array.from({ length: count }, (_, i) => {
    const card = { id: `${prefix}${i}`, suit: 'spades', rank: 1, faceUp: false } as unknown as Card
    return { cardId: card.id, card, from: { x: 0, y: 0 }, to: { x: 10 * i, y: 20 }, delayMs: i * DEAL_STAGGER_MS }
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

const ghostCount = () => screen.queryAllByTestId(/^ghost-/).length

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
  await render(
    <DealProvider>
      <Capture />
    </DealProvider>
  )
}

describe('DealProvider ghost lookahead', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockPlayCardSound.mockClear()
    mockHapticCard.mockClear()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('mounts only the cards about to fly, not a copy of the whole deal', async () => {
    await renderProvider()
    const landed: string[] = []

    await act(async () => controller.start(makeEntries(54), CARD_WIDTH, (id) => landed.push(id), jest.fn()))

    // Everything whose delay is within the lookahead window - a handful of the 54, not all of them.
    expect(ghostCount()).toBeGreaterThan(0)
    expect(ghostCount()).toBeLessThanOrEqual(10)
  })

  it('never has more than a couple dozen ghosts alive at once, and lands every card exactly once, in order', async () => {
    await renderProvider()
    const landed: string[] = []
    const onAllLanded = jest.fn()
    await act(async () => controller.start(makeEntries(54), CARD_WIDTH, (id) => landed.push(id), onAllLanded))

    let peak = ghostCount()
    for (let t = 0; t < 54 * DEAL_STAGGER_MS + 1000; t += 25) {
      await advance(25)
      peak = Math.max(peak, ghostCount())
    }

    expect(peak).toBeLessThan(25)
    expect(landed).toHaveLength(54)
    expect(new Set(landed).size).toBe(54)
    expect(landed).toEqual(makeEntries(54).map((e) => e.cardId))
    expect(onAllLanded).toHaveBeenCalledTimes(1)
    expect(ghostCount()).toBe(0)
  })

  it('keeps each card flying at its own scheduled time (no card lands early)', async () => {
    await renderProvider()
    const landedAt: Record<string, number> = {}
    let elapsed = 0
    await act(async () => controller.start(makeEntries(20), CARD_WIDTH, (id) => (landedAt[id] = elapsed), jest.fn()))

    for (; elapsed < 20 * DEAL_STAGGER_MS + 1000; elapsed += 25) await advance(25)

    // A card lands delay + spring duration (280ms) after the deal starts; never before its own delay.
    makeEntries(20).forEach((e) => expect(landedAt[e.cardId]).toBeGreaterThanOrEqual(e.delayMs))
  })

  it('a skip tap lands the mounted AND the not-yet-mounted cards at once', async () => {
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
    expect(ghostCount()).toBe(0)
    expect(screen.queryByTestId('deal-skip-layer')).toBeNull()
    // Every card still gets its one sound/haptic (throttled downstream), including ones that never mounted.
    expect(mockPlayCardSound.mock.calls.length).toBeGreaterThanOrEqual(54)

    // ...and nothing fires late once the timers run out.
    await advance(5000)
    expect(landed).toHaveLength(54)
    expect(onAllLanded).toHaveBeenCalledTimes(1)
  })

  it('shows the skip layer only while a deal is in flight', async () => {
    await renderProvider()
    expect(screen.queryByTestId('deal-skip-layer')).toBeNull()

    await act(async () => controller.start(makeEntries(5), CARD_WIDTH, jest.fn(), jest.fn()))
    expect(screen.getByTestId('deal-skip-layer')).toBeTruthy()

    await advance(5 * DEAL_STAGGER_MS + 1000)
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
    await advance(12 * DEAL_STAGGER_MS + 1000)

    expect(secondLanded).toHaveLength(12)
    expect(secondAll).toHaveBeenCalledTimes(1)
    expect(ghostCount()).toBe(0)
    // No card of the replaced deal keeps landing into the new deal's callbacks.
    expect(secondLanded.every((id) => id.startsWith('b'))).toBe(true)
  })

  it('an empty deal completes immediately', async () => {
    await renderProvider()
    const onAllLanded = jest.fn()

    await act(async () => controller.start([], CARD_WIDTH, jest.fn(), onAllLanded))

    expect(onAllLanded).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('deal-skip-layer')).toBeNull()
  })
})
