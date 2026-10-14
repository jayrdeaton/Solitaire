import { applyDayPlayed, applyResult, applyWinStreak } from '@tastic/achievements'

import { parFor } from '@/engine/par'
import { VARIANT_IDS, VariantId, variantsOfGame } from '@/engine/variants'

import { DealMetrics, ProfileStats, SOLITAIRE_GAME_IDS, SolitaireGameId, StatsState, VariantStats } from './statsTypes'
import { DEFAULT_PROFILE_STATS } from './statsValidation'

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
  return {
    record: applyResult(prev.record, result),
    streak: applyWinStreak(prev.streak, result),
    bestTimeSeconds,
    bestMoves,
    bestScore,
    hintsUsed: prev.hintsUsed,
    winsWithoutHint
  }
}

function bumpBucket(prev: ProfileStats, variant: VariantId, result: 'win' | 'loss', metrics: DealMetrics, now: Date): ProfileStats {
  return {
    variants: { ...prev.variants, [variant]: bumpVariant(prev.variants[variant], result, metrics) },
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
// was still in progress. `now` defaults to the real clock, overridable so tests can drive day
// boundaries directly.
export function applyDealAbandoned(prev: StatsState, variant: VariantId, activeProfileId: string | null, now: Date = new Date()): StatsState {
  return resolve(prev, variant, 'loss', NO_METRICS, activeProfileId, now)
}

// Called the instant the Hint button actually produces a hint (not on a press that finds nothing
// to suggest) - device-wide and, if a profile is active, into that profile's own bucket too, same
// shape as resolve() above but with no record/streak/day-streak/firstGameResult change.
export function applyHintUsed(prev: StatsState, variant: VariantId, activeProfileId: string | null): StatsState {
  const base = bumpBucketHintUsed(prev, variant)
  const profiles = activeProfileId === null ? prev.profiles : { ...prev.profiles, [activeProfileId]: bumpBucketHintUsed(prev.profiles[activeProfileId] ?? DEFAULT_PROFILE_STATS, variant) }
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
