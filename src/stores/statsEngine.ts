import { applyDayPlayed, applyResult, applyWinStreak, DEFAULT_DAY_STREAK, DEFAULT_WIN_STREAK, localDateString } from '@tastic/achievements'

import { parFor } from '@/engine/par'
import { gameOfVariant, VARIANT_IDS, VariantId, variantsOfGame } from '@/engine/variants'

import { DayRecord, DayTally, DealMetrics, ProfileStats, SOLITAIRE_GAME_IDS, SolitaireGameId, StatsState, VariantStats } from './statsTypes'
import { DEFAULT_PROFILE_STATS, DEFAULT_VARIANT } from './statsValidation'

// An abandoned deal (see statsTypes.ts) has no win metrics to record.
const NO_METRICS: DealMetrics = { seconds: null, moves: null, score: null, usedHint: false }

// Applies one resolved deal to a single variant bucket. 'win' extends the streak and may set new
// bests (time/moves/score - lower is better for all three); 'loss' (abandoned, or a dead board) breaks it.
function bumpVariant(prev: VariantStats, result: 'win' | 'loss', metrics: DealMetrics): VariantStats {
  const isWin = result === 'win'
  const bestTimeSeconds = isWin && metrics.seconds !== null && (prev.bestTimeSeconds === null || metrics.seconds < prev.bestTimeSeconds) ? metrics.seconds : prev.bestTimeSeconds
  const bestMoves = isWin && metrics.moves !== null && (prev.bestMoves === null || metrics.moves < prev.bestMoves) ? metrics.moves : prev.bestMoves
  const bestScore = isWin && metrics.score !== null && (prev.bestScore === null || metrics.score < prev.bestScore) ? metrics.score : prev.bestScore
  const winsWithoutHint = isWin && !metrics.usedHint ? prev.winsWithoutHint + 1 : prev.winsWithoutHint
  const counted = isWin && metrics.seconds !== null && metrics.moves !== null && metrics.score !== null
  return {
    ...prev,
    record: applyResult(prev.record, result),
    streak: applyWinStreak(prev.streak, result),
    bestTimeSeconds,
    bestMoves,
    bestScore,
    winsWithoutHint,
    totalSeconds: prev.totalSeconds + (metrics.seconds ?? 0),
    totalMoves: prev.totalMoves + (metrics.moves ?? 0),
    winsCounted: prev.winsCounted + (counted ? 1 : 0),
    winSeconds: prev.winSeconds + (counted ? metrics.seconds! : 0),
    winMoves: prev.winMoves + (counted ? metrics.moves! : 0),
    winScore: prev.winScore + (counted ? metrics.score! : 0)
  }
}

const EMPTY_TALLY: DayTally = { played: 0, won: 0, seconds: 0 }
const EMPTY_DAY: DayRecord = { ...EMPTY_TALLY, games: {} }

function bumpTally(tally: DayTally, result: 'win' | 'loss', metrics: DealMetrics): DayTally {
  return { played: tally.played + 1, won: tally.won + (result === 'win' ? 1 : 0), seconds: tally.seconds + (metrics.seconds ?? 0) }
}

// One more deal on the day it ended (local date), for the day and for its game.
function bumpDay(days: Record<string, DayRecord>, game: SolitaireGameId, result: 'win' | 'loss', metrics: DealMetrics, now: Date): Record<string, DayRecord> {
  const date = localDateString(now)
  const day = days[date] ?? EMPTY_DAY
  return { ...days, [date]: { ...bumpTally(day, result, metrics), games: { ...day.games, [game]: bumpTally(day.games[game] ?? EMPTY_TALLY, result, metrics) } } }
}

function bumpBucket(prev: ProfileStats, variant: VariantId, result: 'win' | 'loss', metrics: DealMetrics, now: Date): ProfileStats {
  return {
    variants: { ...prev.variants, [variant]: bumpVariant(prev.variants[variant], result, metrics) },
    days: bumpDay(prev.days, gameOfVariant(variant), result, metrics, now),
    winStreak: applyWinStreak(prev.winStreak, result),
    ...applyDayPlayed(prev, now)
  }
}

// Bumps a variant's lifetime hint counter only - no record/streak/day-streak change, unlike
// bumpVariant above. Kept as its own tiny function rather than folded into bumpVariant since it
// fires on every Hint press, not just at deal-resolution time (see gameStats.tsx's
// recordHintUsed).
function bumpVariantHintUsed(prev: VariantStats): VariantStats {
  return { ...prev, hintsUsed: prev.hintsUsed + 1 }
}

function bumpBucketHintUsed(prev: ProfileStats, variant: VariantId): ProfileStats {
  return { ...prev, variants: { ...prev.variants, [variant]: bumpVariantHintUsed(prev.variants[variant]) } }
}

// Resolves one deal, device-wide and (if a profile is active) into that profile's own bucket.
function resolve(prev: StatsState, variant: VariantId, result: 'win' | 'loss', metrics: DealMetrics, activeProfileId: string | null, now: Date): StatsState {
  const base = bumpBucket(prev, variant, result, metrics, now)
  const profiles =
    activeProfileId === null
      ? prev.profiles
      : {
          ...prev.profiles,
          [activeProfileId]: bumpBucket(prev.profiles[activeProfileId] ?? DEFAULT_PROFILE_STATS, variant, result, metrics, now)
        }
  const isFirstEver = getTotalPlayed(prev) === 0
  return {
    ...base,
    profiles,
    firstGameResult: isFirstEver ? result : prev.firstGameResult
  }
}

// Called the instant a deal is won. `metrics` is the elapsed time/moves/score the screen already
// displays.
export function applyDealWon(prev: StatsState, variant: VariantId, metrics: DealMetrics, activeProfileId: string | null, now: Date = new Date()): StatsState {
  return resolve(prev, variant, 'win', metrics, activeProfileId, now)
}

// Called the instant the player confirms the "start a new game" warning dialog over a deal that
// was still in progress, or leaves a dead board. `played` is how long and how many moves the deal took, when the caller
// knows. `now` defaults to the real clock, overridable so tests can drive day boundaries directly.
export function applyDealAbandoned(prev: StatsState, variant: VariantId, activeProfileId: string | null, now: Date = new Date(), played?: { seconds: number; moves: number }): StatsState {
  return resolve(prev, variant, 'loss', played ? { ...NO_METRICS, ...played } : NO_METRICS, activeProfileId, now)
}

// Called the instant the Hint button actually produces a hint (not on a press that finds nothing
// to suggest) - device-wide and, if a profile is active, into that profile's own bucket too, same
// shape as resolve() above but with no record/streak/day-streak/firstGameResult change.
export function applyHintUsed(prev: StatsState, variant: VariantId, activeProfileId: string | null): StatsState {
  const base = bumpBucketHintUsed(prev, variant)
  const profiles = activeProfileId === null ? prev.profiles : { ...prev.profiles, [activeProfileId]: bumpBucketHintUsed(prev.profiles[activeProfileId] ?? DEFAULT_PROFILE_STATS, variant) }
  return { ...prev, ...base, profiles }
}

// An Undo press that took a move back: like a hint, counted the moment it happens, with no record or streak change.
function bumpBucketUndoUsed(prev: ProfileStats, variant: VariantId): ProfileStats {
  return { ...prev, variants: { ...prev.variants, [variant]: { ...prev.variants[variant], undosUsed: prev.variants[variant].undosUsed + 1 } } }
}

export function applyUndoUsed(prev: StatsState, variant: VariantId, activeProfileId: string | null): StatsState {
  const base = bumpBucketUndoUsed(prev, variant)
  const profiles = activeProfileId === null ? prev.profiles : { ...prev.profiles, [activeProfileId]: bumpBucketUndoUsed(prev.profiles[activeProfileId] ?? DEFAULT_PROFILE_STATS, variant) }
  return { ...prev, ...base, profiles }
}

const sumVariants = (stats: ProfileStats, pick: (v: VariantStats) => number) => VARIANT_IDS.reduce((sum, id) => sum + pick(stats.variants[id]), 0)

export function getTotalPlayed(stats: ProfileStats): number {
  return sumVariants(stats, (v) => v.record.played)
}

export function getTotalWins(stats: ProfileStats): number {
  return sumVariants(stats, (v) => v.record.wins)
}

export function getTotalHintsUsed(stats: ProfileStats): number {
  return sumVariants(stats, (v) => v.hintsUsed)
}

export function getTotalWinsWithoutHint(stats: ProfileStats): number {
  return sumVariants(stats, (v) => v.winsWithoutHint)
}

export function getTotalSeconds(stats: ProfileStats): number {
  return sumVariants(stats, (v) => v.totalSeconds)
}

export function getTotalMoves(stats: ProfileStats): number {
  return sumVariants(stats, (v) => v.totalMoves)
}

export function getTotalUndosUsed(stats: ProfileStats): number {
  return sumVariants(stats, (v) => v.undosUsed)
}

/** The average win's time, moves and score in one variant, over the wins added up since 2026-10-22; null with none. */
export function getAverageWin(v: VariantStats): { seconds: number; moves: number; score: number } | null {
  if (v.winsCounted === 0) return null
  return { seconds: v.winSeconds / v.winsCounted, moves: v.winMoves / v.winsCounted, score: v.winScore / v.winsCounted }
}

// Cards in one deal of each game: Spider (whatever its suits) and Forty Thieves deal two decks' worth.
const CARDS_PER_DEAL: Record<SolitaireGameId, number> = { klondike: 52, spider: 104, freecell: 52, pyramid: 52, yukon: 52, golf: 52, tripeaks: 52, canfield: 52, scorpion: 52, fortythieves: 104, acesup: 52 }

/** Cards dealt over every deal that ended. */
export function getCardsDealt(stats: ProfileStats): number {
  return VARIANT_IDS.reduce((sum, id) => sum + stats.variants[id].record.played * CARDS_PER_DEAL[gameOfVariant(id)], 0)
}

/** The day with the most deals ended (the earliest, on a tie); null before any. Only days since 2026-10-22 are kept. */
export function getBusiestDay(stats: ProfileStats): { date: string; played: number } | null {
  let busiest: { date: string; played: number } | null = null
  for (const date of Object.keys(stats.days).sort()) {
    const played = stats.days[date].played
    if (!busiest || played > busiest.played) busiest = { date, played }
  }
  return busiest
}

/**
 * The stats of one game alone, for the Stats screen's game picker: every other game's variants empty, the day log cut down to
 * that game's deals, and its days played and day streaks worked out from that log the way @tastic/achievements works them
 * out as deals end (so they start on 2026-10-22, when the log did). There is no win streak across one game's variants.
 */
export function getGameView(stats: ProfileStats, game: SolitaireGameId): ProfileStats {
  const variants = Object.fromEntries(VARIANT_IDS.map((id) => [id, gameOfVariant(id) === game ? stats.variants[id] : DEFAULT_VARIANT])) as ProfileStats['variants']
  const days: Record<string, DayRecord> = {}
  for (const [date, day] of Object.entries(stats.days)) {
    const tally = day.games[game]
    if (tally && tally.played > 0) days[date] = { ...tally, games: { [game]: tally } }
  }
  const streaks = Object.keys(days)
    .sort()
    .reduce((streak, date) => applyDayPlayed(streak, dateFromKey(date)), DEFAULT_DAY_STREAK)
  return { variants, days, winStreak: DEFAULT_WIN_STREAK, ...streaks }
}

// Local noon on a YYYY-MM-DD day (noon, so no daylight-saving shift can move it to another day).
function dateFromKey(date: string): Date {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, 12)
}

// Deals played of one game, across its variants.
const gamePlayed = (stats: ProfileStats, game: SolitaireGameId) => variantsOfGame(game).reduce((sum, id) => sum + stats.variants[id].record.played, 0)

/** The one game played the fewest deals of, counting a game never played as 0; null when two or more share the fewest (the
 * Stats screen shows it only when there is one clear one: Jay, 2026-10-22). */
export function getLeastPlayedGame(stats: ProfileStats): SolitaireGameId | null {
  const counts = SOLITAIRE_GAME_IDS.map((game) => ({ game, played: gamePlayed(stats, game) }))
  const fewest = Math.min(...counts.map((c) => c.played))
  const least = counts.filter((c) => c.played === fewest)
  return least.length === 1 ? least[0].game : null
}

/** The game played the most deals of, across its variants; null before any deal. */
export function getMostPlayedGame(stats: ProfileStats): SolitaireGameId | null {
  let best: SolitaireGameId | null = null
  let bestPlayed = 0
  for (const game of SOLITAIRE_GAME_IDS) {
    const played = variantsOfGame(game).reduce((sum, id) => sum + stats.variants[id].record.played, 0)
    if (played > bestPlayed) {
      best = game
      bestPlayed = played
    }
  }
  return best
}

/** Wins in any of one game's variants (the "Win a game of Spider" achievements). */
export function getGameWins(stats: ProfileStats, game: SolitaireGameId): number {
  return variantsOfGame(game).reduce((sum, id) => sum + stats.variants[id].record.wins, 0)
}

// The longest win streak achieved in any single variant - streaks are per-variant, so "best
// streak" across the app is the best of them rather than a separate cross-variant tally.
export function getBestStreak(stats: ProfileStats): number {
  return VARIANT_IDS.reduce((max, id) => Math.max(max, stats.variants[id].streak.bestWinStreak), 0)
}

// How many distinct GAMES have been won at least once, under any rules - the "win every game" family.
export function getGamesWon(stats: ProfileStats): number {
  return SOLITAIRE_GAME_IDS.filter((game) => getGameWins(stats, game) > 0).length
}

type ParField = 'moves' | 'seconds' | 'score'
const BEST_FIELD: Record<ParField, 'bestMoves' | 'bestTimeSeconds' | 'bestScore'> = { moves: 'bestMoves', seconds: 'bestTimeSeconds', score: 'bestScore' }

/** The best win measured against its own variant's par (engine/par.ts), as best / par: 0.8 is 20% under par. Across
 * every variant, so a Golf win and a Spider win compare fairly; null until something has been won. */
export function getBestParRatio(stats: ProfileStats, field: ParField): number | null {
  const ratios = VARIANT_IDS.flatMap((id) => {
    const best = stats.variants[id][BEST_FIELD[field]]
    return best === null ? [] : [best / parFor(id)[field]]
  })
  return ratios.length === 0 ? null : Math.min(...ratios)
}

export function getProfileStatsView(profileStats: ProfileStats): StatsState {
  return { ...profileStats, profiles: {}, firstGameResult: null }
}
