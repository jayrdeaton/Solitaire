import { parFor } from '@/engine/par'
import { applyDealAbandoned, applyDealWon, applyHintUsed, getBestParRatio, getBestStreak, getGamesWon, getGameWins, getTotalHintsUsed, getTotalWins, getTotalWinsWithoutHint } from '@/stores/statsEngine'
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

describe('getBestParRatio', () => {
  it('is null until something has been won', () => {
    expect(getBestParRatio(DEFAULT_STATS, 'score')).toBeNull()
  })

  // A raw best across games would just name the quickest game; against each variant's own par, the better PLAY wins.
  it('is the best win measured against its own variant par, across every variant', () => {
    const golf = parFor('golf')
    const spider4 = parFor('spider-4suit')
    const afterGolf = applyDealWon(DEFAULT_STATS, 'golf', { seconds: golf.seconds, moves: golf.moves, score: golf.score, usedHint: false }, null)
    const afterSpider = applyDealWon(afterGolf, 'spider-4suit', { seconds: spider4.seconds / 2, moves: spider4.moves, score: spider4.score * 0.8, usedHint: false }, null)
    expect(getBestParRatio(afterSpider, 'score')).toBeCloseTo(0.8)
    expect(getBestParRatio(afterSpider, 'seconds')).toBeCloseTo(0.5)
    expect(getBestParRatio(afterSpider, 'moves')).toBeCloseTo(1)
  })
})

describe('variants', () => {
  it('keeps each rule set apart, and sums them for a game', () => {
    const win = { seconds: 100, moves: 100, score: 200, usedHint: false }
    const s1 = applyDealWon(DEFAULT_STATS, 'spider', win, null)
    const s2 = applyDealWon(s1, 'spider-4suit', { ...win, score: 900 }, null)
    const s3 = applyDealWon(s2, 'spider-4suit', { ...win, score: 900 }, null)
    expect(s3.variants.spider.bestScore).toBe(200)
    expect(s3.variants['spider-4suit'].bestScore).toBe(900)
    expect(s3.variants['spider-2suit'].record.played).toBe(0)
    expect(getGameWins(s3, 'spider')).toBe(3)
    expect(getTotalWins(s3)).toBe(3)
    expect(getGamesWon(s3)).toBe(1)
    expect(getBestStreak(s3)).toBe(2) // streaks are per rule set
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
