import { DEAL_MIN_STAGGER_MS, DEAL_SPRING, DEAL_STAGGER_MS, DEAL_TARGET_TOTAL_MS, dealStaggerMs, FACE_UP_STAGGER_MS, FACE_UP_TARGET_TOTAL_MS, paceFaceUpDeal } from '@/components/dealing/dealSpring'

const duration = DEAL_SPRING.duration ?? 0
// First card leaving to last card landing, for an initial deal of `count` cards.
const totalMs = (count: number) => (count - 1) * dealStaggerMs(count) + duration

describe('dealStaggerMs', () => {
  it('keeps the original pace for a tiny deal', () => {
    expect(dealStaggerMs(0)).toBe(DEAL_STAGGER_MS)
    expect(dealStaggerMs(1)).toBe(DEAL_STAGGER_MS)
    expect(dealStaggerMs(4)).toBe(DEAL_STAGGER_MS) // Aces Up
  })

  it('leaves a 28-card deal (Klondike, Pyramid, TriPeaks) all but unchanged', () => {
    expect(dealStaggerMs(28)).toBeGreaterThan(DEAL_STAGGER_MS - 2)
    expect(dealStaggerMs(28)).toBeLessThanOrEqual(DEAL_STAGGER_MS)
  })

  it.each([28, 35, 40, 49, 52, 54])('fits a %i-card deal inside the target total time', (count) => {
    expect(totalMs(count)).toBeLessThanOrEqual(DEAL_TARGET_TOTAL_MS + 1)
  })

  it('never goes below the floor, however big the deal', () => {
    expect(dealStaggerMs(500)).toBe(DEAL_MIN_STAGGER_MS)
  })

  it('never staggers wider than the original pace', () => {
    for (let n = 1; n <= 60; n++) expect(dealStaggerMs(n)).toBeLessThanOrEqual(DEAL_STAGGER_MS)
  })

  it('gets tighter as the deal gets bigger', () => {
    expect(dealStaggerMs(52)).toBeLessThan(dealStaggerMs(40))
    expect(dealStaggerMs(40)).toBeLessThan(dealStaggerMs(28) + 1e-9)
  })

  it('takes a 52-card deal from ~2.1s to ~1.2s', () => {
    expect((52 - 1) * DEAL_STAGGER_MS + duration).toBeGreaterThan(2000)
    expect(totalMs(52)).toBeLessThanOrEqual(1201)
  })
})

describe('paceFaceUpDeal', () => {
  interface Entry {
    cardId: string
    card: { faceUp: boolean }
    delayMs: number
  }
  /** One entry per card, in visit order at dealStaggerMs(n) (what a screen builds before pacing) - the first `downCount` fly face-down, the rest face-up. */
  const deal = (count: number, downCount = 0, stagger = dealStaggerMs(count)): Entry[] => Array.from({ length: count }, (_, i) => ({ cardId: `c${i}`, card: { faceUp: i >= downCount }, delayMs: i * stagger }))
  const delays = (entries: Entry[]) => entries.map((entry) => entry.delayMs)
  const gaps = (entries: Entry[]) => {
    const d = delays(entries)
    return d.slice(1).map((delay, i) => delay - d[i])
  }
  /** First card leaving to last card landing. */
  const total = (entries: Entry[]) => Math.max(...delays(entries)) + duration

  it('has the documented constants', () => {
    expect(FACE_UP_STAGGER_MS).toBe(44)
    expect(FACE_UP_TARGET_TOTAL_MS).toBe(2000)
  })

  it('returns the very same array when there is nothing face-up to pace (empty, all face-down)', () => {
    const empty: Entry[] = []
    expect(paceFaceUpDeal(empty)).toBe(empty)
    const allDown = deal(28, 28)
    expect(paceFaceUpDeal(allDown)).toBe(allDown)
  })

  it('returns the same array when the only face-up group is the very first (it has no gap to stretch)', () => {
    const single = deal(1)
    expect(paceFaceUpDeal(single)).toBe(single)
    const tied: Entry[] = [
      { cardId: 'a', card: { faceUp: true }, delayMs: 0 },
      { cardId: 'b', card: { faceUp: true }, delayMs: 0 }
    ]
    expect(paceFaceUpDeal(tied)).toBe(tied)
  })

  it('takes a 52-card face-up deal (FreeCell) from ~1.2s to ~2s: every gap ~33.7ms', () => {
    const paced = paceFaceUpDeal(deal(52))
    expect(paced).toHaveLength(52)
    expect(paced[0].delayMs).toBe(0)
    gaps(paced).forEach((gap) => expect(gap).toBeCloseTo((FACE_UP_TARGET_TOTAL_MS - duration) / 51, 6))
    expect(gaps(paced)[0]).toBeGreaterThan(33.7)
    expect(gaps(paced)[0]).toBeLessThan(33.8)
    expect(total(paced)).toBeLessThanOrEqual(2001)
    expect(total(paced)).toBeGreaterThan(1990)
  })

  it('spaces smaller face-up deals at exactly 44ms: Forty Thieves (40) 1996ms, Golf (36) 1820ms, a 28-card deal 1468ms', () => {
    ;[
      [40, 1996],
      [36, 1820],
      [28, 1468]
    ].forEach(([count, expectedTotal]) => {
      const paced = paceFaceUpDeal(deal(count))
      gaps(paced).forEach((gap) => expect(gap).toBeCloseTo(FACE_UP_STAGGER_MS, 6))
      expect(total(paced)).toBeCloseTo(expectedTotal, 6)
    })
  })

  it("Yukon's shape (28 face-down, then 24 face-up): the face-down gaps are untouched, the face-up ones - including the step off the last down card - are 44ms", () => {
    const original = deal(52, 28)
    const paced = paceFaceUpDeal(original)
    const g = gaps(paced)
    g.slice(0, 27).forEach((gap, i) => expect(gap).toBeCloseTo(gaps(original)[i], 9))
    paced.slice(0, 28).forEach((entry, i) => expect(entry.delayMs).toBe(original[i].delayMs)) // bit-for-bit, not merely close
    g.slice(27).forEach((gap) => expect(gap).toBeCloseTo(FACE_UP_STAGGER_MS, 6))
    expect(total(paced)).toBeGreaterThan(1815)
    expect(total(paced)).toBeLessThan(1830)
  })

  it("TriPeaks's shape (18 down at ~32.9ms, then 11 up) would gain only ~0.1s (~1.32s instead of ~1.2s), which is why it is not wired", () => {
    const original = deal(29, 18)
    expect(gaps(original)[0]).toBeCloseTo(32.86, 2)
    const paced = paceFaceUpDeal(original)
    expect(total(original)).toBeCloseTo(1200, 6)
    expect(total(paced)).toBeGreaterThan(1315)
    expect(total(paced)).toBeLessThan(1330)
  })

  it('never shrinks a gap: an input already spaced at 60ms stays at 60', () => {
    const slow = deal(30, 0, 60)
    const paced = paceFaceUpDeal(slow)
    expect(delays(paced)).toEqual(delays(slow))
    gaps(paced).forEach((gap) => expect(gap).toBe(60))
  })

  it('spends no more than the face-up target: when the face-down part already eats the budget the face-up gaps do not shrink below their own', () => {
    // 20 face-down cards at 90ms (1710ms of down time) leave no room for a 44ms face-up gap: the face-up cards keep the gap they had.
    const original = [...deal(20, 20, 90), ...deal(5, 0, 20).map((entry, i) => ({ ...entry, cardId: `up${i}`, delayMs: 19 * 90 + (i + 1) * 20 }))]
    const paced = paceFaceUpDeal(original)
    expect(delays(paced)).toEqual(delays(original))
  })

  it('keeps the order, the ids and the delays non-decreasing, keeps the first delay, and keeps ties tied', () => {
    const original: Entry[] = [
      { cardId: 'a', card: { faceUp: false }, delayMs: 100 },
      { cardId: 'b', card: { faceUp: true }, delayMs: 110 },
      { cardId: 'c', card: { faceUp: true }, delayMs: 110 }, // ties with b
      { cardId: 'd', card: { faceUp: true }, delayMs: 125 },
      { cardId: 'e', card: { faceUp: false }, delayMs: 125 }, // ties with d, and a tie is face-up if ANY member is
      { cardId: 'f', card: { faceUp: false }, delayMs: 140 }
    ]
    const paced = paceFaceUpDeal(original)
    expect(paced.map((entry) => entry.cardId)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(paced[0].delayMs).toBe(100)
    expect(paced[1].delayMs).toBe(paced[2].delayMs)
    expect(paced[3].delayMs).toBe(paced[4].delayMs)
    const d = delays(paced)
    d.slice(1).forEach((delay, i) => expect(delay).toBeGreaterThanOrEqual(d[i]))
    // groups: a(100, down) b/c(110, up) d/e(125, up) f(140, down) - both face-up gaps become 44ms, the face-down f keeps its 15ms
    expect(paced[1].delayMs).toBeCloseTo(144, 9)
    expect(paced[3].delayMs).toBeCloseTo(188, 9)
    expect(paced[5].delayMs).toBeCloseTo(203, 9)
  })

  it('handles entries that are not sorted by delay, pacing by delay while returning them in the order given', () => {
    const shuffled = deal(10).reverse()
    const paced = paceFaceUpDeal(shuffled)
    expect(paced.map((entry) => entry.cardId)).toEqual(shuffled.map((entry) => entry.cardId))
    const sorted = [...paced].sort((a, b) => a.delayMs - b.delayMs)
    gaps(sorted).forEach((gap) => expect(gap).toBeCloseTo(FACE_UP_STAGGER_MS, 6))
    expect(sorted[0].cardId).toBe('c0')
  })

  it('does not mutate the array or the entries it is given, and returns new objects', () => {
    const original = deal(52, 28)
    const snapshot = JSON.parse(JSON.stringify(original))
    const paced = paceFaceUpDeal(original)
    expect(original).toEqual(snapshot)
    expect(paced).not.toBe(original)
    paced.forEach((entry, i) => expect(entry).not.toBe(original[i]))
    // ...and carries every other field through untouched (same card object, extra fields included).
    const extra = [
      { cardId: 'x', card: { faceUp: true }, delayMs: 0, from: { x: 1, y: 2 } },
      { cardId: 'y', card: { faceUp: true }, delayMs: 10, from: { x: 1, y: 2 } }
    ]
    const out = paceFaceUpDeal(extra)
    expect(out[1].from).toBe(extra[1].from)
    expect(out[1].card).toBe(extra[1].card)
  })
})
