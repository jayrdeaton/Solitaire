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
// still in progress (after confirming a warning dialog), or reached a dead board in a game that
// declares one (useStuckLossCheck: Aces Up, Golf, TriPeaks, Forty Thieves, Scorpion). Both go through
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
}

// One resolved deal's metrics, bundled so applyDealWon/bumpVariant don't need a growing chain of
// positional parameters. seconds/moves/score are all null for an abandoned deal (see
// statsEngine.ts's applyDealAbandoned); usedHint is meaningful only on a win (see bumpVariant).
export interface DealMetrics {
  seconds: number | null
  moves: number | null
  score: number | null
  usedHint: boolean
}

export interface ProfileStats extends DayStreakState {
  // Keyed by VariantId. A game's default variant keeps the bare game id, so stats from before variants existed carry
  // straight over into it.
  variants: Record<VariantId, VariantStats>
}

export interface StatsState extends ProfileStats {
  // Keyed by Profile.id, populated only while a profile is active when a deal resolves (see
  // stores/profiles.tsx's activeProfileId). Solitaire is single-player, so there's at most one.
  profiles: Record<string, ProfileStats>
  // Set once, on the very first deal ever resolved - powers the one-off "your first game was a
  // win" achievement, which cumulative totals can't express.
  firstGameResult: RoundResult | null
}
