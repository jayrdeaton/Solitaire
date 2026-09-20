import { BOUNCE_V_HALF_PERIOD_MAX_MS, BOUNCE_V_HALF_PERIOD_MIN_MS, cardXAtElapsed, cardYAtElapsed, CHAIN_MAX_SPAN_MS, CHAIN_SEGMENT_DELAY_MS, ChainPath, chainSegmentDelayMs, fanOffsetScale, horizontalXAtElapsed, isGhostVisible, verticalYAtElapsed } from '@/components/winning/winCascadeMotion'

// A fixed chain path: launches at (100, 200), falls to a floor at 700 (first fall 1000ms), then bounces between 700 and an apex
// at 100 forever; heads for the wall at x=20 over a 1000ms first leg, then swings between it and x=320.
const PATH: ChainPath = { origin: { x: 100, y: 200 }, floorY: 700, apexY: 100, vHalfPeriodMs: 1000, firstX: 20, secondX: 320, hHalfPeriodMs: 3000, initialLegMs: 800, chainStartMs: 0 }

// Every elapsed time worth sampling: before the launch, through the first fall, and several bounce cycles after it.
const SAMPLES = Array.from({ length: 400 }, (_, i) => -300 + i * 17)

describe('fanOffsetScale', () => {
  it('is all of the offset while a card is parked', () => {
    expect(fanOffsetScale(0, 1000)).toBe(1)
    expect(fanOffsetScale(-1, 1000)).toBe(1)
    expect(fanOffsetScale(-5000, 1000)).toBe(1)
  })

  it('decays linearly over the first fall', () => {
    expect(fanOffsetScale(250, 1000)).toBeCloseTo(0.75)
    expect(fanOffsetScale(500, 1000)).toBeCloseTo(0.5)
    expect(fanOffsetScale(750, 1000)).toBeCloseTo(0.25)
  })

  it('is gone exactly when the first fall lands, and stays gone', () => {
    expect(fanOffsetScale(1000, 1000)).toBe(0)
    expect(fanOffsetScale(1001, 1000)).toBe(0)
    expect(fanOffsetScale(60_000, 1000)).toBe(0)
  })

  it('never grows as time passes', () => {
    let previous = Infinity
    for (const elapsed of SAMPLES) {
      const scale = fanOffsetScale(elapsed, 1000)
      expect(scale).toBeLessThanOrEqual(previous)
      previous = scale
    }
  })
})

describe('cardXAtElapsed / cardYAtElapsed', () => {
  it('parks a card at its own spot (the chain origin plus its offset) until its launch, on both axes', () => {
    for (const elapsed of [0, -1, -200, -10_000]) {
      expect(cardXAtElapsed(PATH, elapsed, -30)).toBe(PATH.origin.x - 30)
      expect(cardYAtElapsed(PATH, elapsed, 264)).toBe(PATH.origin.y + 264)
    }
  })

  it('brings the card halfway back onto the chain path halfway through the first fall', () => {
    const elapsed = 500
    expect(cardYAtElapsed(PATH, elapsed, 264)).toBeCloseTo(verticalYAtElapsed(PATH, elapsed) + 264 * 0.5)
    expect(cardXAtElapsed(PATH, elapsed, -30)).toBeCloseTo(horizontalXAtElapsed(PATH, elapsed) - 30 * 0.5)
  })

  it('has converged onto the chain path exactly when the first fall lands, and rides it ever after', () => {
    expect(cardYAtElapsed(PATH, 1000, 264)).toBe(PATH.floorY)
    for (const elapsed of SAMPLES.filter((t) => t >= 1000)) {
      expect(cardYAtElapsed(PATH, elapsed, 264)).toBe(verticalYAtElapsed(PATH, elapsed))
      expect(cardXAtElapsed(PATH, elapsed, -30)).toBe(horizontalXAtElapsed(PATH, elapsed))
    }
  })

  it('is exactly the chain path when the card has no offset of its own (a chain that never opted in)', () => {
    for (const elapsed of SAMPLES) {
      expect(cardYAtElapsed(PATH, elapsed, 0)).toBe(verticalYAtElapsed(PATH, elapsed))
      expect(cardXAtElapsed(PATH, elapsed, 0)).toBe(horizontalXAtElapsed(PATH, elapsed))
    }
  })

  it('keeps two cards of a fan strictly apart until they converge, and identical afterwards', () => {
    // The King (offset 0) and a card 264 below it: the gap starts at 264 and closes to nothing during the first fall.
    let previousGap = Infinity
    for (const elapsed of [0, 100, 300, 600, 900, 999]) {
      const gap = cardYAtElapsed(PATH, elapsed, 264) - cardYAtElapsed(PATH, elapsed, 0)
      expect(gap).toBeGreaterThan(0)
      expect(gap).toBeLessThan(previousGap + 1e-9)
      previousGap = gap
    }
    expect(cardYAtElapsed(PATH, 1000, 264) - cardYAtElapsed(PATH, 1000, 0)).toBe(0)
  })
})

describe('isGhostVisible', () => {
  it('always draws a card that stands somewhere real (a chain head, or a card with its own spot), before its entrance too', () => {
    expect(isGhostVisible(-1_000_000, true)).toBe(true)
    expect(isGhostVisible(-CHAIN_SEGMENT_DELAY_MS, true)).toBe(true)
    expect(isGhostVisible(0, true)).toBe(true)
    expect(isGhostVisible(500, true)).toBe(true)
  })

  it('draws the rest of a chain only from the moment the card ahead of it has left', () => {
    expect(isGhostVisible(-1_000, false)).toBe(false) // waiting, hidden under the cards ahead
    expect(isGhostVisible(-CHAIN_SEGMENT_DELAY_MS, false)).toBe(false)
    expect(isGhostVisible(-CHAIN_SEGMENT_DELAY_MS + 1, false)).toBe(true) // the card ahead started 1ms ago
    expect(isGhostVisible(0, false)).toBe(true)
    expect(isGhostVisible(5_000, false)).toBe(true)
  })
})

describe('isGhostVisible - a chain with its own per-card delay', () => {
  it('shows a card from one of ITS delays before its own start, not the default one', () => {
    expect(isGhostVisible(-9, false, 10)).toBe(true) // the card ahead left 1ms ago, on a 10ms chain
    expect(isGhostVisible(-10, false, 10)).toBe(false)
    expect(isGhostVisible(-9, false)).toBe(true) // the default delay (42ms) is looser...
    expect(isGhostVisible(-41, false)).toBe(true)
    expect(isGhostVisible(-41, false, 10)).toBe(false) // ...and a tighter chain does not show a card that early
    expect(isGhostVisible(-1_000, true, 10)).toBe(true) // a head always shows
  })
})

describe('chainSegmentDelayMs', () => {
  it('keeps the usual per-card delay for the short chains it was tuned on', () => {
    for (const count of [0, 1, 2, 5, 12]) expect(chainSegmentDelayMs(count)).toBe(CHAIN_SEGMENT_DELAY_MS)
    expect(chainSegmentDelayMs(13)).toBeCloseTo(CHAIN_SEGMENT_DELAY_MS, 0) // a 13-card chain trails its head by ~500ms already - all but the usual delay
  })

  it('tightens a long chain so its whole head-to-tail span stays within the cap', () => {
    for (const count of [14, 28, 40, 52]) {
      const delay = chainSegmentDelayMs(count)
      expect(delay).toBeLessThan(CHAIN_SEGMENT_DELAY_MS)
      expect(delay * (count - 1)).toBeCloseTo(CHAIN_MAX_SPAN_MS, 6)
    }
    expect(chainSegmentDelayMs(52)).toBeCloseTo(CHAIN_MAX_SPAN_MS / 51, 6) // ~9.8ms
    expect(chainSegmentDelayMs(52, 300)).toBeCloseTo(300 / 51, 6) // an explicit cap is honored
  })
})

// "One continuous snake" means the chain, at any instant, bends at most once - at the floor (or the apex) the head has just bounced off
// while the tail is still on its way to it. Every card plays the same vertical path a fixed delay apart, so at a given instant the chain
// samples that path over a window of (cards - 1) * delay ms; each turning point of the path (floor/apex, one bounce half-period apart)
// inside the window is a bend, and a window longer than a half-period can hold two: the chain is then a wave, not one snake.
describe('a 52-card chain (the whole Pyramid deck in one pile)', () => {
  const paths: ChainPath[] = [BOUNCE_V_HALF_PERIOD_MIN_MS, 1100, BOUNCE_V_HALF_PERIOD_MAX_MS].map((vHalfPeriodMs) => ({ origin: { x: 100, y: 200 }, floorY: 700, apexY: 100, vHalfPeriodMs, firstX: 20, secondX: 320, hHalfPeriodMs: 3000, initialLegMs: 800, chainStartMs: 0 }))

  /** Along the chain (head first) at `elapsed`, how many times the vertical direction reverses. */
  function bends(path: ChainPath, elapsed: number, count: number, delay: number): number {
    const ys = Array.from({ length: count }, (_, i) => verticalYAtElapsed(path, elapsed - i * delay))
    let previous = 0
    let reversals = 0
    for (let i = 1; i < count; i++) {
      const direction = Math.sign(ys[i] - ys[i - 1])
      if (direction === 0) continue // parked cards share a spot
      if (previous !== 0 && direction !== previous) reversals++
      previous = direction
    }
    return reversals
  }
  const mostBends = (path: ChainPath, delay: number) => {
    let most = 0
    for (let elapsed = 0; elapsed < 9_000; elapsed += 7) most = Math.max(most, bends(path, elapsed, 52, delay))
    return most
  }

  it('at the usual 42ms per card it splits: the tail trails its head by ~2.1s, so the chain bends twice at some instant', () => {
    for (const path of paths) expect(mostBends(path, CHAIN_SEGMENT_DELAY_MS)).toBeGreaterThanOrEqual(2)
  })

  it('with the capped per-card delay it never bends more than once, for any bounce period: one continuous snake', () => {
    const delay = chainSegmentDelayMs(52)
    for (const path of paths) expect(mostBends(path, delay)).toBeLessThanOrEqual(1)
  })

  it('and stays packed: no two neighbours are ever more than a card apart, so it does not stretch into a scatter', () => {
    const delay = chainSegmentDelayMs(52)
    const cardHeight = 100
    for (const path of paths) {
      let widest = 0
      for (let elapsed = 0; elapsed < 9_000; elapsed += 7) for (let i = 1; i < 52; i++) widest = Math.max(widest, Math.abs(verticalYAtElapsed(path, elapsed - i * delay) - verticalYAtElapsed(path, elapsed - (i - 1) * delay)))
      expect(widest).toBeLessThan(cardHeight)
    }
  })
})
