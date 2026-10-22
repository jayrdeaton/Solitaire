import { AchievementDefinition as BaseAchievementDefinition, DayStreakState, OutcomeRecord, RoundResult, WinStreakState } from '@tastic/achievements'

import type { VariantId } from '@/engine/variants'

export type { AchievementTier, UnlockedAchievementsState } from '@tastic/achievements'
export type AchievementDefinition = BaseAchievementDefinition<StatsState>

// The games this app ships. Kept as a literal union (rather than a bare string, which is what
// the legacy stores/stats.ts used) so a typo in a game id is a compile error, and so
// Record<SolitaireGameId, T> is exhaustive everywhere stats are bucketed.
export type SolitaireGameId = 'klondike' | 'spider' | 'freecell' | 'pyramid' | 'yukon' | 'golf' | 'tripeaks' | 'canfield' | 'scorpion' | 'fortythieves' | 'acesup'

export const SOLITAIRE_GAME_IDS: SolitaireGameId[] = ['klondike', 'spider', 'freecell', 'pyramid', 'yukon', 'golf', 'tripeaks', 'canfield', 'scorpion', 'fortythieves', 'acesup']

// One variant's record: a game under one rule set (engine/variants.ts), e.g. Spider 4 Suits. Per-game figures (wins
// for "Win a game of Spider", Games Solved) are sums over a game's variants (see statsEngine.ts).
//
// `record.losses` counts every deal that ended without a win: the player dealt a new game over one
// still in progress (after confirming a warning dialog), or reached a dead board (useStuckLossCheck: no
// legal move and no stock, or no progress reachable at all). Both go through
// statsEngine.ts's applyDealAbandoned; the Stats screen labels them "Lost".
// `record.draws` is unused and stays 0; it rides along because @tastic/achievements' applyResult
// maintains the whole quadruple.
export interface VariantStats {
  record: OutcomeRecord
  streak: WinStreakState
  // Fastest winning time, in whole seconds. null until this variant has been won at least once -
  // deliberately not 0, which would read as an impossibly fast win to every comparison.
  bestTimeSeconds: number | null
  // Fewest moves in a win, and lowest score (see engine/score.ts - lower is better). Same
  // null-until-first-win convention as bestTimeSeconds.
  bestMoves: number | null
  bestScore: number | null
  // Lifetime count of Hint-button presses in this variant - bumped the instant the button is
  // pressed (see statsEngine.ts's applyHintUsed), independent of whether that deal is later won or
  // abandoned.
  hintsUsed: number
  // Lifetime count of wins in this variant where no hint was used during that deal - see
  // DealMetrics' own usedHint and statsEngine.ts's bumpVariant.
  winsWithoutHint: number
  // Added 2026-10-22 (a stats-loving player asked for more), so each starts at 0 on stats from before:
  // Seconds and moves over every deal that ended, won or lost: Time Played, and a lost deal's share of the moves.
  totalSeconds: number
  totalMoves: number
  // The wins added up since then, and their sums: the average win's time, moves and score. An older win has no sums.
  winsCounted: number
  winSeconds: number
  winMoves: number
  winScore: number
  // Undo presses that took a move back (statsEngine.ts's applyUndoUsed), like hintsUsed.
  undosUsed: number
}

/** The new VariantStats counters, every one a plain count starting at 0 (see statsValidation.ts's backfill). */
export const VARIANT_COUNTERS = ['totalSeconds', 'totalMoves', 'winsCounted', 'winSeconds', 'winMoves', 'winScore', 'undosUsed'] as const

// One resolved deal's metrics, bundled so applyDealWon/bumpVariant don't need a growing chain of
// positional parameters. A lost deal has no score, and its seconds/moves are null when the caller didn't say (see
// statsEngine.ts's applyDealAbandoned); usedHint is meaningful only on a win (see bumpVariant).
export interface DealMetrics {
  seconds: number | null
  moves: number | null
  score: number | null
  usedHint: boolean
}

/** One calendar day's play: deals that ended (won or lost), wins, seconds, and deals per game. */
export interface DayRecord {
  played: number
  won: number
  seconds: number
  games: Partial<Record<SolitaireGameId, number>>
}

export interface ProfileStats extends DayStreakState {
  // Keyed by VariantId. A game's default variant keeps the bare game id, so stats from before variants existed carry
  // straight over into it.
  variants: Record<VariantId, VariantStats>
  // Every day a deal ended, by local date (YYYY-MM-DD, @tastic/achievements' localDateString, which is also the date a
  // @rific/heatmap DataPoint takes). Kept from 2026-10-22 so a calendar of play has history once there is one to show
  // (Jay wants @rific/heatmap on the Stats screen eventually); Most Deals in a Day reads it meanwhile. Empty on older stats.
  days: Record<string, DayRecord>
  // Wins in a row across every game and rule set, from 2026-10-22 (each variant keeps its own streak too).
  winStreak: WinStreakState
}

export interface StatsState extends ProfileStats {
  // Keyed by Profile.id, populated only while a profile is active when a deal resolves (see
  // stores/profiles.tsx's activeProfileId). Solitaire is single-player, so there's at most one.
  profiles: Record<string, ProfileStats>
  // Set once, on the very first deal ever resolved - powers the one-off "your first game was a
  // win" achievement, which cumulative totals can't express.
  firstGameResult: RoundResult | null
}
