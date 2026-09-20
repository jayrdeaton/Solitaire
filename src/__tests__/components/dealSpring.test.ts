import { DEAL_MIN_STAGGER_MS, DEAL_SPRING, DEAL_STAGGER_MS, DEAL_TARGET_TOTAL_MS, dealStaggerMs } from '@/components/dealing/dealSpring'

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
