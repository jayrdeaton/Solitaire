import { HERO_BUMP_DOWN_MS, HERO_BUMP_STAGGER_MS, HERO_BUMP_UP_MS, HERO_CARD_COUNT, HERO_CARD_HEIGHT, HERO_CARD_WIDTH, HERO_FAN_CARDS, HERO_FAN_CENTER_Y, HERO_FAN_HEIGHT, HERO_FAN_SPAN, HERO_WAVE_CYCLE_MS, heroBumpAt } from '@/components/heroFan'
import { CARD_HEIGHT, CARD_WIDTH } from '@/components/theme'

const rad = (deg: number) => (deg * Math.PI) / 180

// A resting card's four corners, relative to the centre card's centre.
function corners(card: (typeof HERO_FAN_CARDS)[number]) {
  const a = rad(card.angleDeg)
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1]
  ].map(([sx, sy]) => {
    const dx = (sx * HERO_CARD_WIDTH) / 2
    const dy = (sy * HERO_CARD_HEIGHT) / 2
    return { x: card.x + dx * Math.cos(a) - dy * Math.sin(a), y: card.y + dx * Math.sin(a) + dy * Math.cos(a) }
  })
}

// The middle of a resting card's top edge.
const topCentre = (card: (typeof HERO_FAN_CARDS)[number]) => ({ x: card.x + card.outX * (HERO_CARD_HEIGHT / 2), y: card.y + card.outY * (HERO_CARD_HEIGHT / 2) })

describe('hero fan geometry', () => {
  it("draws the theme's natural card size", () => {
    expect(HERO_CARD_WIDTH).toBe(CARD_WIDTH)
    expect(HERO_CARD_HEIGHT).toBe(CARD_HEIGHT)
  })

  it('is five cards, symmetric about the centre card, stacked left behind right', () => {
    expect(HERO_FAN_CARDS).toHaveLength(HERO_CARD_COUNT)
    expect(HERO_CARD_COUNT).toBe(5)
    const centre = HERO_FAN_CARDS[2]
    expect(centre).toMatchObject({ angleDeg: 0, x: 0, y: 0, outX: 0, outY: -1 })
    for (let i = 0; i < HERO_CARD_COUNT; i++) {
      const card = HERO_FAN_CARDS[i]
      const mirror = HERO_FAN_CARDS[HERO_CARD_COUNT - 1 - i]
      expect(card.angleDeg).toBeCloseTo(-mirror.angleDeg, 10)
      expect(card.x).toBeCloseTo(-mirror.x, 10)
      expect(card.y).toBeCloseTo(mirror.y, 10)
      expect(card.turnIndex).toBe(i)
      expect(card.zIndex).toBe(i + 1)
    }
  })

  // The fix for "not arced enough": every card turns about ONE pivot below the fan (a real held hand), so
  // the line through the cards' tops is a circle, not two straight sides of a tent.
  it('turns every card about one shared pivot below the fan, each pointing straight away from it', () => {
    // the centre card's own axis is vertical, so the pivot is straight below it, at the distance the
    // other cards' axes all meet it
    const pivotDistances = HERO_FAN_CARDS.filter((c) => c.angleDeg !== 0).map((c) => c.x / c.outX)
    const pivotY = pivotDistances[0]
    expect(pivotY).toBeGreaterThan(HERO_CARD_HEIGHT)
    for (const card of HERO_FAN_CARDS) {
      // its own axis passes through the pivot ...
      expect(card.x - pivotY * card.outX).toBeCloseTo(0, 9)
      expect(card.y - pivotY * card.outY).toBeCloseTo(pivotY, 9)
      // ... and is the direction it is turned to
      expect(card.outX).toBeCloseTo(Math.sin(rad(card.angleDeg)), 12)
      expect(card.outY).toBeCloseTo(-Math.cos(rad(card.angleDeg)), 12)
    }
  })

  it("curves the cards' tops: each step out drops further than the one before", () => {
    const tops = HERO_FAN_CARDS.slice(2).map(topCentre)
    const drops = tops.slice(1).map((top, i) => top.y - tops[i].y)
    expect(drops.every((d) => d > 0)).toBe(true)
    for (let i = 1; i < drops.length; i++) expect(drops[i]).toBeGreaterThan(drops[i - 1] * 2)
    // the outer cards are turned well past the old fan's 18deg
    expect(HERO_FAN_CARDS[HERO_CARD_COUNT - 1].angleDeg).toBeGreaterThanOrEqual(24)
  })

  it("lays its row out as the resting fan's own bounding box", () => {
    const all = HERO_FAN_CARDS.flatMap(corners)
    const left = Math.min(...all.map((p) => p.x))
    const right = Math.max(...all.map((p) => p.x))
    const top = Math.min(...all.map((p) => p.y))
    const bottom = Math.max(...all.map((p) => p.y))
    expect(HERO_FAN_SPAN).toBe(Math.ceil(right - left))
    expect(left).toBeCloseTo(-right, 9)
    expect(HERO_FAN_HEIGHT).toBe(Math.ceil(bottom - top))
    expect(HERO_FAN_CENTER_Y).toBeCloseTo(-top, 9)
    // whole points, so the landscape pane math stays exact
    expect(Number.isInteger(HERO_FAN_SPAN)).toBe(true)
    expect(Number.isInteger(HERO_FAN_HEIGHT)).toBe(true)
  })
})

describe('hero wave', () => {
  const STEP_MS = 1
  const samples = Array.from({ length: HERO_WAVE_CYCLE_MS / STEP_MS + 1 }, (_, i) => i * STEP_MS)
  const bumps = (t: number) => HERO_FAN_CARDS.map((c) => heroBumpAt(t, c.turnIndex))

  it('is one cycle of every card bumping once, then a rest beat with the whole fan still', () => {
    const lastSettles = (HERO_CARD_COUNT - 1) * HERO_BUMP_STAGGER_MS + HERO_BUMP_UP_MS + HERO_BUMP_DOWN_MS
    expect(HERO_WAVE_CYCLE_MS).toBeGreaterThan(lastSettles)
    for (const t of samples.filter((s) => s >= lastSettles)) expect(bumps(t)).toEqual([0, 0, 0, 0, 0])
    // so wrapping the clock back to 0 lands exactly where the cycle ended: at rest
    expect(bumps(0)).toEqual([0, 0, 0, 0, 0])
  })

  it('pops each card fully out once, left to right, one stagger apart', () => {
    for (const card of HERO_FAN_CARDS) {
      const start = card.turnIndex * HERO_BUMP_STAGGER_MS
      expect(heroBumpAt(start, card.turnIndex)).toBe(0)
      expect(heroBumpAt(start + HERO_BUMP_UP_MS, card.turnIndex)).toBe(1)
      expect(heroBumpAt(start + HERO_BUMP_UP_MS + HERO_BUMP_DOWN_MS, card.turnIndex)).toBe(0)
      const moving = samples.filter((t) => heroBumpAt(t, card.turnIndex) > 0)
      expect(moving[0]).toBe(start + STEP_MS)
      expect(moving[moving.length - 1]).toBe(start + HERO_BUMP_UP_MS + HERO_BUMP_DOWN_MS - STEP_MS)
    }
  })

  it('never moves more than two cards at once, and those two are neighbours', () => {
    for (const t of samples) {
      const moving = bumps(t)
        .map((b, i) => (b > 0 ? i : -1))
        .filter((i) => i >= 0)
      expect(moving.length).toBeLessThanOrEqual(2)
      if (moving.length === 2) expect(moving[1] - moving[0]).toBe(1)
    }
  })

  it('moves smoothly (no jumps between frames)', () => {
    // a quadratic ease's steepest slope is 2 / its duration, per ms
    const maxStep = (2 / Math.min(HERO_BUMP_UP_MS, HERO_BUMP_DOWN_MS)) * STEP_MS
    for (const card of HERO_FAN_CARDS) {
      for (let i = 1; i < samples.length; i++) {
        expect(Math.abs(heroBumpAt(samples[i], card.turnIndex) - heroBumpAt(samples[i - 1], card.turnIndex))).toBeLessThanOrEqual(maxStep + 1e-9)
      }
    }
  })
})
