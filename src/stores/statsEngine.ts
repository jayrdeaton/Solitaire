import { applyDayPlayed, applyResult, applyWinStreak, countBucketsWithAWin, OutcomeRecord } from '@tastic/achievements';

import { DealMetrics, ProfileStats, SOLITAIRE_GAME_IDS, SolitaireGameId, StatsState, VariantStats } from './statsTypes';
import { DEFAULT_PROFILE_STATS } from './statsValidation';

// An abandoned deal (see statsTypes.ts) has no win metrics to record.
const NO_METRICS: DealMetrics = { seconds: null, moves: null, score: null };

// Applies one resolved deal to a single variant bucket. 'win' extends the streak and may set new
// bests (time/moves/score — lower is better for all three); 'loss' (an abandoned deal) breaks it.
function bumpVariant(prev: VariantStats, result: 'win' | 'loss', metrics: DealMetrics): VariantStats {
  const isWin = result === 'win';
  const bestTimeSeconds =
    isWin && metrics.seconds !== null && (prev.bestTimeSeconds === null || metrics.seconds < prev.bestTimeSeconds)
      ? metrics.seconds
      : prev.bestTimeSeconds;
  const bestMoves =
    isWin && metrics.moves !== null && (prev.bestMoves === null || metrics.moves < prev.bestMoves)
      ? metrics.moves
      : prev.bestMoves;
  const bestScore =
    isWin && metrics.score !== null && (prev.bestScore === null || metrics.score < prev.bestScore)
      ? metrics.score
      : prev.bestScore;
  return {
    record: applyResult(prev.record, result),
    streak: applyWinStreak(prev.streak, result),
    bestTimeSeconds,
    bestMoves,
    bestScore,
  };
}

function bumpBucket(
  prev: ProfileStats,
  variant: SolitaireGameId,
  result: 'win' | 'loss',
  metrics: DealMetrics,
  now: Date,
): ProfileStats {
  return {
    variants: { ...prev.variants, [variant]: bumpVariant(prev.variants[variant], result, metrics) },
    ...applyDayPlayed(prev, now),
  };
}

// Resolves one deal, device-wide and (if a profile is active) into that profile's own bucket.
function resolve(
  prev: StatsState,
  variant: SolitaireGameId,
  result: 'win' | 'loss',
  metrics: DealMetrics,
  activeProfileId: string | null,
  now: Date,
): StatsState {
  const base = bumpBucket(prev, variant, result, metrics, now);
  const profiles =
    activeProfileId === null
      ? prev.profiles
      : {
          ...prev.profiles,
          [activeProfileId]: bumpBucket(
            prev.profiles[activeProfileId] ?? DEFAULT_PROFILE_STATS,
            variant,
            result,
            metrics,
            now,
          ),
        };
  const isFirstEver = getTotalPlayed(prev) === 0;
  return {
    ...base,
    profiles,
    firstGameResult: isFirstEver ? result : prev.firstGameResult,
  };
}

// Called the instant a deal is won. `metrics` is the elapsed time/moves/score the screen already
// displays.
export function applyDealWon(
  prev: StatsState,
  variant: SolitaireGameId,
  metrics: DealMetrics,
  activeProfileId: string | null,
  now: Date = new Date(),
): StatsState {
  return resolve(prev, variant, 'win', metrics, activeProfileId, now);
}

// Called the instant the player confirms the "start a new game" warning dialog over a deal that
// was still in progress. `now` defaults to the real clock, overridable so tests can drive day
// boundaries directly.
export function applyDealAbandoned(
  prev: StatsState,
  variant: SolitaireGameId,
  activeProfileId: string | null,
  now: Date = new Date(),
): StatsState {
  return resolve(prev, variant, 'loss', NO_METRICS, activeProfileId, now);
}

export function getTotalPlayed(stats: ProfileStats): number {
  return SOLITAIRE_GAME_IDS.reduce((sum, id) => sum + stats.variants[id].record.played, 0);
}

export function getTotalWins(stats: ProfileStats): number {
  return SOLITAIRE_GAME_IDS.reduce((sum, id) => sum + stats.variants[id].record.wins, 0);
}

// The longest win streak achieved in any single variant — streaks are per-variant, so "best
// streak" across the app is the best of them rather than a separate cross-variant tally.
export function getBestStreak(stats: ProfileStats): number {
  return SOLITAIRE_GAME_IDS.reduce((max, id) => Math.max(max, stats.variants[id].streak.bestWinStreak), 0);
}

// How many distinct variants have been won at least once — the "win every game" family.
export function getVariantsWon(stats: ProfileStats): number {
  const asRecords: Record<string, OutcomeRecord> = Object.fromEntries(
    SOLITAIRE_GAME_IDS.map((id) => [id, stats.variants[id].record]),
  );
  return countBucketsWithAWin(asRecords);
}

// Fastest win across every variant, or null if nothing has been won yet.
export function getBestTimeSeconds(stats: ProfileStats): number | null {
  const times = SOLITAIRE_GAME_IDS.map((id) => stats.variants[id].bestTimeSeconds).filter(
    (t): t is number => t !== null,
  );
  return times.length === 0 ? null : Math.min(...times);
}

// Fewest moves in a win across every variant, or null if nothing has been won yet.
export function getBestMoves(stats: ProfileStats): number | null {
  const moves = SOLITAIRE_GAME_IDS.map((id) => stats.variants[id].bestMoves).filter((m): m is number => m !== null);
  return moves.length === 0 ? null : Math.min(...moves);
}

// Lowest score in a win across every variant, or null if nothing has been won yet.
export function getBestScore(stats: ProfileStats): number | null {
  const scores = SOLITAIRE_GAME_IDS.map((id) => stats.variants[id].bestScore).filter((s): s is number => s !== null);
  return scores.length === 0 ? null : Math.min(...scores);
}

export function getProfileStatsView(profileStats: ProfileStats): StatsState {
  return { ...profileStats, profiles: {}, firstGameResult: null };
}
