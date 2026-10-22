import { parFor } from '@/engine/par'
import { applyDealAbandoned, applyDealWon, applyHintUsed, applyUndoUsed, getAverageWin, getBestParRatio, getBestStreak, getBusiestDay, getCardsDealt, getGamesWon, getGameWins, getMostPlayedGame, getTotalHintsUsed, getTotalMoves, getTotalSeconds, getTotalUndosUsed, getTotalWins, getTotalWinsWithoutHint } from '@/stores/statsEngine'
import type { StatsState } from '@/stores/statsTypes'
import { DEFAULT_STATS, isValidStats, migrateStats } from '@/stores/statsValidation'

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

// More stats (2026-10-22, a stats-loving player): time and moves over every deal that ended, the average win, undos.
describe('the counters of 2026-10-22', () => {
  const won = (seconds: number, moves: number, score: number) => ({ seconds, moves, score, usedHint: false })

  it('adds every deal that ended to Time Played and Moves Made, a lost one too when its time and moves are given', () => {
    let stats = applyDealWon(DEFAULT_STATS, 'klondike', won(100, 80, 180), null)
    stats = applyDealAbandoned(stats, 'klondike', null, new Date(), { seconds: 50, moves: 20 })
    stats = applyDealAbandoned(stats, 'klondike', null)
    expect(stats.variants.klondike.totalSeconds).toBe(150)
    expect(stats.variants.klondike.totalMoves).toBe(100)
    expect(getTotalSeconds(stats)).toBe(150)
    expect(getTotalMoves(stats)).toBe(100)
  })

  it('averages the wins it added up, and has no average before one', () => {
    expect(getAverageWin(DEFAULT_STATS.variants.spider)).toBeNull()
    let stats = applyDealWon(DEFAULT_STATS, 'spider', won(100, 80, 180), null)
    stats = applyDealWon(stats, 'spider', won(200, 120, 320), null)
    stats = applyDealAbandoned(stats, 'spider', null, new Date(), { seconds: 30, moves: 10 })
    expect(getAverageWin(stats.variants.spider)).toEqual({ seconds: 150, moves: 100, score: 250 })
  })

  it('counts an undo for the variant, the device and the active profile alike, and nothing else', () => {
    const next = applyUndoUsed(DEFAULT_STATS, 'freecell', 'p1')
    expect(next.variants.freecell.undosUsed).toBe(1)
    expect(next.profiles.p1.variants.freecell.undosUsed).toBe(1)
    expect(next.variants.freecell.record).toEqual(DEFAULT_STATS.variants.freecell.record)
    expect(getTotalUndosUsed(next)).toBe(1)
  })

  it('names the game with the most deals played as Most Played', () => {
    expect(getMostPlayedGame(DEFAULT_STATS)).toBeNull()
    let stats = applyDealAbandoned(DEFAULT_STATS, 'golf', null)
    stats = applyDealWon(stats, 'spider', won(100, 80, 180), null)
    stats = applyDealWon(stats, 'spider-4suit', won(100, 80, 180), null)
    expect(getMostPlayedGame(stats)).toBe('spider')
  })

  it('fills the counters with 0 on stats saved before them', () => {
    const { totalSeconds: _a, totalMoves: _b, winsCounted: _c, winSeconds: _d, winMoves: _e, winScore: _f, undosUsed: _g, ...old } = DEFAULT_STATS.variants.klondike
    const stored = { ...DEFAULT_STATS, variants: { ...DEFAULT_STATS.variants, klondike: old } } as unknown as StatsState
    expect(isValidStats(stored)).toBe(true)
    const migrated = migrateStats(stored)
    expect(migrated.variants.klondike).toEqual(DEFAULT_STATS.variants.klondike)
  })
})

// The day log and the streak across games (2026-10-22): history for a calendar of play (@rific/heatmap, eventually).
describe('days and the all-games win streak', () => {
  const won = { seconds: 100, moves: 80, score: 180, usedHint: false }
  const day = (d: number, h = 12) => new Date(2026, 9, d, h)

  it('logs each deal that ended on its local day, with its game, win and seconds', () => {
    let stats = applyDealWon(DEFAULT_STATS, 'klondike', won, null, day(22, 9))
    stats = applyDealAbandoned(stats, 'spider-4suit', null, day(22, 23), { seconds: 40, moves: 12 })
    stats = applyDealWon(stats, 'klondike-draw3', won, null, day(23, 1))
    expect(stats.days).toEqual({
      '2026-10-22': { played: 2, won: 1, seconds: 140, games: { klondike: 1, spider: 1 } },
      '2026-10-23': { played: 1, won: 1, seconds: 100, games: { klondike: 1 } }
    })
    expect(getBusiestDay(stats)).toEqual({ date: '2026-10-22', played: 2 })
  })

  it('keeps one win streak across every game and rule set, which a loss in any of them breaks', () => {
    let stats = applyDealWon(DEFAULT_STATS, 'klondike', won, null)
    stats = applyDealWon(stats, 'freecell', won, null)
    stats = applyDealWon(stats, 'spider-2suit', won, null)
    expect(stats.winStreak).toEqual({ currentWinStreak: 3, bestWinStreak: 3 })
    stats = applyDealAbandoned(stats, 'golf', null)
    expect(stats.winStreak).toEqual({ currentWinStreak: 0, bestWinStreak: 3 })
  })

  it("counts the cards dealt: two decks' worth for Spider and Forty Thieves", () => {
    let stats = applyDealWon(DEFAULT_STATS, 'klondike', won, null)
    stats = applyDealAbandoned(stats, 'spider', null)
    stats = applyDealAbandoned(stats, 'fortythieves-runs', null)
    expect(getCardsDealt(stats)).toBe(52 + 104 + 104)
  })

  it('starts an empty log and streak on stats saved before them, device-wide and per profile', () => {
    const { days: _d, winStreak: _w, ...oldBucket } = DEFAULT_STATS
    const stored = { ...oldBucket, profiles: { p1: oldBucket } } as unknown as StatsState
    expect(isValidStats(stored)).toBe(true)
    const migrated = migrateStats(stored)
    expect(migrated.days).toEqual({})
    expect(migrated.winStreak).toEqual({ currentWinStreak: 0, bestWinStreak: 0 })
    expect(migrated.profiles.p1.days).toEqual({})
  })
})
