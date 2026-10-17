import { BOUNCE_FLOOR_MARGIN_PX, BOUNCE_H_HALF_PERIOD_MAX_MS, BOUNCE_H_HALF_PERIOD_MIN_MS, BOUNCE_H_MARGIN_PX, BOUNCE_MIN_SPAN_PX, BOUNCE_TOP_MARGIN_PX, cardXAtElapsed, cardYAtElapsed, cascadeApexY, CascadeBounds, cascadeBounds, CHAIN_SEGMENT_DELAY_MS, chainEntranceDelayMs, ChainPath, fanOffsetScale, fitXToBounds, fitYToBounds, horizontalXAtElapsed, isGhostVisible, spreadHHalfPeriods, verticalYAtElapsed } from '@/components/winning/winCascadeMotion'

// A fixed chain path: launches at (100, 200), falls to a floor at 700 (first fall 1000ms), then bounces between 700 and an apex
// at 100 forever; heads for the wall at x=20 over a 1000ms first leg, then swings between it and x=320.
const PATH: ChainPath = { origin: { x: 100, y: 200 }, floorY: 700, apexY: 100, vHalfPeriodMs: 1000, firstX: 20, secondX: 320, hHalfPeriodMs: 3000, initialLegMs: 800 }

// Every elapsed time worth sampling: before the launch, through the first fall, and several bounce cycles after it.
const SAMPLES = Array.from({ length: 400 }, (_, i) => -300 + i * 17)

describe('chainEntranceDelayMs', () => {
  it('sends a lone chain off at once', () => {
    expect(chainEntranceDelayMs(0, 1, 1000)).toBe(0)
  })

  it('spreads the chains evenly over the first fall: the first leaves at once, the last as the first lands', () => {
    expect([0, 1, 2, 3].map((i) => chainEntranceDelayMs(i, 4, 1200))).toEqual([0, 400, 800, 1200])
    expect([0, 1].map((i) => chainEntranceDelayMs(i, 2, 1000))).toEqual([0, 1000])
    // Spider's 8 completed runs: still one after another, just closer together.
    const spider = Array.from({ length: 8 }, (_, i) => chainEntranceDelayMs(i, 8, 1050))
    expect(spider[7]).toBe(1050)
    for (let i = 1; i < 8; i++) expect(spider[i] - spider[i - 1]).toBeCloseTo(150)
  })
})

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

describe('cascadeApexY', () => {
  it('is the bottom of the header, whatever the floor, when the screen leaves room for a full bounce', () => {
    expect(cascadeApexY(56, 700)).toBe(56)
    expect(cascadeApexY(115, 700)).toBe(115) // a notched phone: the header band is taller
  })

  it('is held back only far enough to leave the bounce BOUNCE_MIN_SPAN_PX tall on a screen too short for the header', () => {
    expect(cascadeApexY(300, 400)).toBe(400 - BOUNCE_MIN_SPAN_PX)
  })

  it('never rises above the top margin', () => {
    expect(cascadeApexY(0, 700)).toBe(0) // the header's own bottom wins when it is higher: nothing lifts the apex further
    expect(cascadeApexY(500, 100)).toBe(BOUNCE_TOP_MARGIN_PX) // a floor so high there is no room: the margin is the limit
  })
})

describe('spreadHHalfPeriods', () => {
  const noShuffle = () => 0.999 // Fisher-Yates swaps each slot with itself: the even spacing, in order

  it('gives every chain its own speed, all inside the band', () => {
    for (const count of [2, 3, 4, 8]) {
      const periods = spreadHHalfPeriods(count)
      expect(new Set(periods).size).toBe(count)
      for (const period of periods) {
        expect(period).toBeGreaterThanOrEqual(BOUNCE_H_HALF_PERIOD_MIN_MS)
        expect(period).toBeLessThanOrEqual(BOUNCE_H_HALF_PERIOD_MAX_MS)
      }
    }
  })

  it('spaces them evenly from the slowest end of the band to the fastest', () => {
    const periods = spreadHHalfPeriods(4, noShuffle)
    expect(periods[0]).toBe(BOUNCE_H_HALF_PERIOD_MIN_MS)
    expect(periods[3]).toBe(BOUNCE_H_HALF_PERIOD_MAX_MS)
    const step = (BOUNCE_H_HALF_PERIOD_MAX_MS - BOUNCE_H_HALF_PERIOD_MIN_MS) / 3
    expect(periods[1] - periods[0]).toBeCloseTo(step, 6)
    expect(periods[2] - periods[1]).toBeCloseTo(step, 6)
  })

  it('gives a lone chain the middle of the band, and an empty cascade nothing', () => {
    expect(spreadHHalfPeriods(1)).toEqual([(BOUNCE_H_HALF_PERIOD_MIN_MS + BOUNCE_H_HALF_PERIOD_MAX_MS) / 2])
    expect(spreadHHalfPeriods(0)).toEqual([])
  })

  it('shuffles which chain gets which speed, without changing the set of speeds', () => {
    const ordered = spreadHHalfPeriods(5, noShuffle)
    const shuffled = spreadHHalfPeriods(5, () => 0)
    expect(shuffled).not.toEqual(ordered)
    expect([...shuffled].sort((a, b) => a - b)).toEqual(ordered)
  })

  it('is a slight difference, not a wide one: the fastest chain is well under twice as fast as the slowest', () => {
    expect(BOUNCE_H_HALF_PERIOD_MAX_MS / BOUNCE_H_HALF_PERIOD_MIN_MS).toBeLessThan(1.5)
  })
})

describe('cascadeBounds', () => {
  it('puts the walls a margin in from each side, the floor a margin above the bottom, and the apex at the header', () => {
    expect(cascadeBounds({ width: 400, height: 800 }, 64, 90, 56)).toEqual({ leftX: BOUNCE_H_MARGIN_PX, rightX: 400 - 64 - BOUNCE_H_MARGIN_PX, apexY: 56, floorY: 800 - 90 - BOUNCE_FLOOR_MARGIN_PX })
  })
})

describe('fitXToBounds / fitYToBounds', () => {
  // PATH was built in this box: walls at 20 and 320, apex 100, floor 700.
  const BUILT: CascadeBounds = { leftX: 20, rightX: 320, apexY: 100, floorY: 700 }
  // A quarter turn later: twice as wide, under half as tall.
  const TURNED: CascadeBounds = { leftX: 12, rightX: 724, apexY: 56, floorY: 286 }

  it('changes nothing, to the last bit, while the bounds are the ones the path was built in', () => {
    for (const elapsed of SAMPLES) {
      const x = cardXAtElapsed(PATH, elapsed, -30)
      const y = cardYAtElapsed(PATH, elapsed, 264)
      expect(fitXToBounds(PATH, { ...BUILT }, x)).toBe(x)
      expect(fitYToBounds(PATH, { ...BUILT }, y)).toBe(y)
    }
  })

  it('puts the walls, the apex and the floor on the new ones', () => {
    expect(fitXToBounds(PATH, TURNED, PATH.firstX)).toBeCloseTo(TURNED.leftX, 9)
    expect(fitXToBounds(PATH, TURNED, PATH.secondX)).toBeCloseTo(TURNED.rightX, 9)
    expect(fitYToBounds(PATH, TURNED, PATH.apexY)).toBeCloseTo(TURNED.apexY, 9)
    expect(fitYToBounds(PATH, TURNED, PATH.floorY)).toBeCloseTo(TURNED.floorY, 9)
  })

  it('is, at every moment, the path a chain built in the new bounds would take: same timing, same phase', () => {
    const mapX = (x: number) => TURNED.leftX + ((x - BUILT.leftX) * (TURNED.rightX - TURNED.leftX)) / (BUILT.rightX - BUILT.leftX)
    const mapY = (y: number) => TURNED.apexY + ((y - BUILT.apexY) * (TURNED.floorY - TURNED.apexY)) / (BUILT.floorY - BUILT.apexY)
    const rebuilt: ChainPath = { ...PATH, origin: { x: mapX(PATH.origin.x), y: mapY(PATH.origin.y) }, firstX: TURNED.leftX, secondX: TURNED.rightX, apexY: TURNED.apexY, floorY: TURNED.floorY }
    for (const elapsed of SAMPLES) {
      expect(fitXToBounds(PATH, TURNED, horizontalXAtElapsed(PATH, elapsed))).toBeCloseTo(horizontalXAtElapsed(rebuilt, elapsed), 9)
      expect(fitYToBounds(PATH, TURNED, verticalYAtElapsed(PATH, elapsed))).toBeCloseTo(verticalYAtElapsed(rebuilt, elapsed), 9)
    }
  })

  it('keeps a chain that heads for the right wall first heading for the right wall', () => {
    const rightFirst: ChainPath = { ...PATH, firstX: 320, secondX: 20 }
    expect(fitXToBounds(rightFirst, TURNED, rightFirst.firstX)).toBeCloseTo(TURNED.rightX, 9)
    expect(fitXToBounds(rightFirst, TURNED, rightFirst.secondX)).toBeCloseTo(TURNED.leftX, 9)
  })
})
