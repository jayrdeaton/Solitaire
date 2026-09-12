import { DEFAULT_DAY_STREAK, DEFAULT_OUTCOME_RECORD, DEFAULT_WIN_STREAK } from '@tastic/achievements'

import { ProfileStats, SOLITAIRE_GAME_IDS, SolitaireGameId, StatsState, VariantStats } from './statsTypes'

export const DEFAULT_VARIANT: VariantStats = {
  record: DEFAULT_OUTCOME_RECORD,
  streak: DEFAULT_WIN_STREAK,
  bestTimeSeconds: null,
  bestMoves: null,
  bestScore: null,
  hintsUsed: 0,
  winsWithoutHint: 0
}

function emptyVariants(): Record<SolitaireGameId, VariantStats> {
  return Object.fromEntries(SOLITAIRE_GAME_IDS.map((id) => [id, { ...DEFAULT_VARIANT }])) as Record<SolitaireGameId, VariantStats>
}

export const DEFAULT_PROFILE_STATS: ProfileStats = {
  variants: emptyVariants(),
  ...DEFAULT_DAY_STREAK
}

export const DEFAULT_STATS: StatsState = {
  ...DEFAULT_PROFILE_STATS,
  profiles: {},
  firstGameResult: null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isValidVariant(value: unknown): value is VariantStats {
  if (!isRecord(value)) return false
  const record = value.record
  const streak = value.streak
  if (!isRecord(record) || !isRecord(streak)) return false
  const countsOk = typeof record.played === 'number' && typeof record.wins === 'number' && typeof record.losses === 'number' && typeof record.draws === 'number'
  const streakOk = typeof streak.currentWinStreak === 'number' && typeof streak.bestWinStreak === 'number'
  const timeOk = value.bestTimeSeconds === null || typeof value.bestTimeSeconds === 'number'
  // bestMoves/bestScore are newer than bestTimeSeconds, so a real persisted blob may predate them
  // and legitimately lack the key entirely — unlike bestTimeSeconds above, undefined must be
  // accepted here, or every existing install's stats would fail validation and reset to defaults
  // (see gameStats.tsx's migrateStats, which backfills the missing fields on a blob that passes
  // this check).
  const movesOk = value.bestMoves === undefined || value.bestMoves === null || typeof value.bestMoves === 'number'
  const scoreOk = value.bestScore === undefined || value.bestScore === null || typeof value.bestScore === 'number'
  // hintsUsed/winsWithoutHint are newer still — same undefined-tolerant treatment as bestMoves/
  // bestScore above, backfilled to 0 by gameStats.tsx's migrateStats.
  const hintsUsedOk = value.hintsUsed === undefined || typeof value.hintsUsed === 'number'
  const winsWithoutHintOk = value.winsWithoutHint === undefined || typeof value.winsWithoutHint === 'number'
  return countsOk && streakOk && timeOk && movesOk && scoreOk && hintsUsedOk && winsWithoutHintOk
}

// A present variant must be individually valid, but a known game id is allowed to be missing
// entirely — a blob written before a new game (e.g. Yukon) was added predates that id and legitimately
// lacks the key, same reasoning as isValidVariant's own tolerance for a missing bestMoves/bestScore
// above. useAchievements (see node_modules/@tastic/achievements/src/useAchievements.ts) runs this
// check on the RAW stored blob BEFORE gameStats.tsx's migrateStats ever gets a chance to backfill
// anything - requiring every id up front would reject (and silently reset to defaults) every
// existing install's ENTIRE stats history, across every game, the instant a new game ships, not just
// crash on it. Confirmed live: seeding a blob with variants missing a game id and reloading reset
// every game's stats to zero before this fix. Extra unrecognized ids are tolerated (an inert
// leftover from a game that was removed).
function isValidProfileStats(value: unknown): value is ProfileStats {
  if (!isRecord(value)) return false
  const variants = value.variants
  if (!isRecord(variants)) return false
  if (!SOLITAIRE_GAME_IDS.every((id) => variants[id] === undefined || isValidVariant(variants[id]))) return false
  return typeof value.distinctDaysPlayed === 'number' && typeof value.currentDayStreak === 'number' && typeof value.bestDayStreak === 'number' && (value.lastPlayedDate === null || typeof value.lastPlayedDate === 'string')
}

export function isValidStats(value: unknown): value is StatsState {
  if (!isValidProfileStats(value)) return false
  const v = value as unknown as Partial<StatsState>
  const profilesOk = v.profiles === undefined || (isRecord(v.profiles) && Object.values(v.profiles).every(isValidProfileStats))
  const firstOk = v.firstGameResult === undefined || v.firstGameResult === null || v.firstGameResult === 'win' || v.firstGameResult === 'loss' || v.firstGameResult === 'draw'
  return profilesOk && firstOk
}
