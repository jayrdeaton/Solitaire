import {
  AchievementDefinition as BaseAchievementDefinition,
  DayStreakState,
  OutcomeRecord,
  RoundResult,
  WinStreakState,
} from '@tastic/achievements';

export type { AchievementTier, UnlockedAchievementsState } from '@tastic/achievements';
export type AchievementDefinition = BaseAchievementDefinition<StatsState>;

// The four games this app ships. Kept as a literal union (rather than a bare string, which is what
// the legacy stores/stats.ts used) so a typo in a game id is a compile error, and so
// Record<SolitaireGameId, T> is exhaustive everywhere stats are bucketed.
export type SolitaireGameId = 'klondike' | 'spider' | 'freecell' | 'pyramid';

export const SOLITAIRE_GAME_IDS: SolitaireGameId[] = ['klondike', 'spider', 'freecell', 'pyramid'];

// One game variant's record.
//
// A solitaire deal is never "lost" the way a versus match is — it's won, or it's walked away from.
// So `record.losses` here means ABANDONED: the player explicitly dealt a new game over one that was
// still in progress, after confirming a warning dialog (see statsEngine.ts's applyDealAbandoned).
// `record.draws` is unused and stays 0; it rides along because @tastic/achievements' applyResult
// maintains the whole quadruple.
export interface VariantStats {
  record: OutcomeRecord;
  streak: WinStreakState;
  // Fastest winning time, in whole seconds. null until this variant has been won at least once —
  // deliberately not 0, which would read as an impossibly fast win to every comparison.
  bestTimeSeconds: number | null;
  // Fewest moves in a win, and lowest score (see engine/score.ts — lower is better). Same
  // null-until-first-win convention as bestTimeSeconds.
  bestMoves: number | null;
  bestScore: number | null;
}

// One resolved deal's metrics, bundled so applyDealWon/bumpVariant don't need a growing chain of
// positional parameters. All null for an abandoned deal (see statsEngine.ts's applyDealAbandoned).
export interface DealMetrics {
  seconds: number | null;
  moves: number | null;
  score: number | null;
}

export interface ProfileStats extends DayStreakState {
  variants: Record<SolitaireGameId, VariantStats>;
}

export interface StatsState extends ProfileStats {
  // Keyed by Profile.id, populated only while a profile is active when a deal resolves (see
  // stores/profiles.tsx's activeProfileId). Solitaire is single-player, so there's at most one.
  profiles: Record<string, ProfileStats>;
  // Set once, on the very first deal ever resolved — powers the one-off "your first game was a
  // win" achievement, which cumulative totals can't express.
  firstGameResult: RoundResult | null;
}
