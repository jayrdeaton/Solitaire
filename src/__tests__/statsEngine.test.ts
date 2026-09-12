import { applyDealAbandoned, applyDealWon, applyHintUsed, getBestMoves, getBestScore, getBestTimeSeconds, getTotalHintsUsed, getTotalWinsWithoutHint } from '@/stores/statsEngine'
import { DEFAULT_STATS } from '@/stores/statsValidation'

describe('applyDealWon', () => {
  it('records first-win bests for time, moves, and score', () => {
    const next = applyDealWon(DEFAULT_STATS, 'klondike', { seconds: 120, moves: 80, score: 200, usedHint: false }, null)
    expect(next.variants.klondike.bestTimeSeconds).toBe(120)
    expect(next.variants.klondike.bestMoves).toBe(80)
    expect(next.variants.klondike.bestScore).toBe(200)
  })

  it('keeps the existing bests when a later win is worse', () => {
    const first = applyDealWon(DEFAULT_STATS, 'klondike', { seconds: 120, moves: 80, score: 200, usedHint: false }, null)
    const second = applyDealWon(first, 'klondike', { seconds: 200, moves: 100, score: 300, usedHint: false }, null)
    expect(second.variants.klondike.bestTimeSeconds).toBe(120)
    expect(second.variants.klondike.bestMoves).toBe(80)
    expect(second.variants.klondike.bestScore).toBe(200)
  })

  it('replaces the bests when a later win is better', () => {
    const first = applyDealWon(DEFAULT_STATS, 'klondike', { seconds: 120, moves: 80, score: 200, usedHint: false }, null)
    const second = applyDealWon(first, 'klondike', { seconds: 60, moves: 40, score: 100, usedHint: false }, null)
    expect(second.variants.klondike.bestTimeSeconds).toBe(60)
    expect(second.variants.klondike.bestMoves).toBe(40)
    expect(second.variants.klondike.bestScore).toBe(100)
  })

  it('does not affect other variants', () => {
    const next = applyDealWon(DEFAULT_STATS, 'klondike', { seconds: 120, moves: 80, score: 200, usedHint: false }, null)
    expect(next.variants.spider.bestMoves).toBeNull()
    expect(next.variants.spider.bestScore).toBeNull()
    expect(next.variants.spider.bestTimeSeconds).toBeNull()
  })
})

describe('applyDealAbandoned', () => {
  it('records a loss without touching bests', () => {
    const next = applyDealAbandoned(DEFAULT_STATS, 'klondike', null)
    expect(next.variants.klondike.record.played).toBe(1)
    expect(next.variants.klondike.record.losses).toBe(1)
    expect(next.variants.klondike.record.wins).toBe(0)
    expect(next.variants.klondike.bestTimeSeconds).toBeNull()
    expect(next.variants.klondike.bestMoves).toBeNull()
    expect(next.variants.klondike.bestScore).toBeNull()
  })

  it('breaks an existing win streak', () => {
    const afterWin = applyDealWon(DEFAULT_STATS, 'klondike', { seconds: 120, moves: 80, score: 200, usedHint: false }, null)
    expect(afterWin.variants.klondike.streak.currentWinStreak).toBe(1)
    const afterAbandon = applyDealAbandoned(afterWin, 'klondike', null)
    expect(afterAbandon.variants.klondike.streak.currentWinStreak).toBe(0)
  })

  it('does not affect other variants', () => {
    const next = applyDealAbandoned(DEFAULT_STATS, 'klondike', null)
    expect(next.variants.spider.record.played).toBe(0)
  })
})

describe('getBestMoves / getBestScore / getBestTimeSeconds', () => {
  it('is null until something has been won', () => {
    expect(getBestMoves(DEFAULT_STATS)).toBeNull()
    expect(getBestScore(DEFAULT_STATS)).toBeNull()
    expect(getBestTimeSeconds(DEFAULT_STATS)).toBeNull()
  })

  it('is the minimum across variants', () => {
    const afterKlondike = applyDealWon(DEFAULT_STATS, 'klondike', { seconds: 120, moves: 80, score: 200, usedHint: false }, null)
    const afterSpider = applyDealWon(afterKlondike, 'spider', { seconds: 90, moves: 50, score: 140, usedHint: false }, null)
    expect(getBestMoves(afterSpider)).toBe(50)
    expect(getBestScore(afterSpider)).toBe(140)
    expect(getBestTimeSeconds(afterSpider)).toBe(90)
  })
})

describe('hint tracking', () => {
  it('applyHintUsed increments only the pressed variant, device-wide', () => {
    const next = applyHintUsed(DEFAULT_STATS, 'klondike', null)
    expect(next.variants.klondike.hintsUsed).toBe(1)
    expect(next.variants.spider.hintsUsed).toBe(0)
    expect(getTotalHintsUsed(next)).toBe(1)
  })

  it('applyHintUsed also bumps the active profile bucket, without touching record/streak', () => {
    const next = applyHintUsed(DEFAULT_STATS, 'klondike', 'p1')
    expect(next.profiles.p1.variants.klondike.hintsUsed).toBe(1)
    expect(next.variants.klondike.record.played).toBe(0)
  })

  it('a win with usedHint: true does not count toward winsWithoutHint', () => {
    const next = applyDealWon(DEFAULT_STATS, 'klondike', { seconds: 120, moves: 80, score: 200, usedHint: true }, null)
    expect(next.variants.klondike.record.wins).toBe(1)
    expect(next.variants.klondike.winsWithoutHint).toBe(0)
    expect(getTotalWinsWithoutHint(next)).toBe(0)
  })

  it('a win with usedHint: false counts toward winsWithoutHint', () => {
    const next = applyDealWon(DEFAULT_STATS, 'klondike', { seconds: 120, moves: 80, score: 200, usedHint: false }, null)
    expect(next.variants.klondike.winsWithoutHint).toBe(1)
    expect(getTotalWinsWithoutHint(next)).toBe(1)
  })

  it('an abandoned deal never counts toward winsWithoutHint', () => {
    const next = applyDealAbandoned(DEFAULT_STATS, 'klondike', null)
    expect(next.variants.klondike.winsWithoutHint).toBe(0)
  })
})
