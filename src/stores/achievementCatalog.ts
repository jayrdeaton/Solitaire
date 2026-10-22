import { tieredFamily } from '@tastic/achievements'

import { getBestParRatio, getBestStreak, getGamesWon, getGameWins, getTotalPlayed, getTotalWins, getTotalWinsWithoutHint } from './statsEngine'
import { AchievementDefinition, GAME_TITLES, SOLITAIRE_GAME_IDS, StatsState } from './statsTypes'

export { ACHIEVEMENT_TIER_COLORS } from '@tastic/achievements'

// One per game - four different predicates, not one value against three thresholds, so these are
// hand-written and carry no progress. All silver: no single game is meaningfully harder to win
// once than the others, so tiering them against each other would be arbitrary.
function winEachGameFamily(): AchievementDefinition[] {
  return SOLITAIRE_GAME_IDS.map((id) => ({
    id: `win_${id}`,
    title: `${GAME_TITLES[id]} Solved`,
    description: `Win a game of ${GAME_TITLES[id]}.`,
    tier: 'silver' as const,
    icon: 'cards-playing-outline',
    isUnlocked: (stats: StatsState) => getGameWins(stats, id) >= 1
  }))
}

// A par ratio (best / par) as the negated percent the par families compare against.
function parValue(ratio: number | null): number {
  return ratio === null ? -Infinity : -ratio * 100
}

// A negated par percent threshold as copy: -100 is "at or under par", -80 is "20% or more under par".
function parPhrase(threshold: number): string {
  const under = 100 + threshold
  return under === 0 ? 'at or under par' : `${under}% or more under par`
}

export const ACHIEVEMENT_CATALOG: AchievementDefinition[] = [
  {
    id: 'first_game_played',
    title: 'First Deal',
    description: 'Finish your first game.',
    tier: 'bronze',
    icon: 'flag-checkered',
    isUnlocked: (stats) => getTotalPlayed(stats) >= 1
  },
  {
    id: 'first_ever_win',
    title: 'Solved It',
    description: 'Win any game, any time.',
    tier: 'bronze',
    icon: 'star',
    isUnlocked: (stats) => getTotalWins(stats) >= 1
  },
  {
    id: 'flawless_debut',
    title: 'Beginner’s Luck',
    description: 'Win the very first game you ever deal.',
    tier: 'gold',
    icon: 'star-circle',
    // firstGameResult is a one-time device-wide flag with no per-profile analog, so it always
    // evaluates against the real device stats regardless of which profile tab is selected.
    scope: 'device',
    isUnlocked: (stats) => stats.firstGameResult === 'win'
  },
  ...tieredFamily<StatsState>({
    id: 'games_played',
    titles: { bronze: 'Getting Started', silver: 'Regular', gold: 'Card Sharp' },
    description: (n) => `Play ${n} total games.`,
    icon: 'cards',
    thresholds: { bronze: 10, silver: 100, gold: 500 },
    value: getTotalPlayed
  }),
  ...tieredFamily<StatsState>({
    id: 'total_wins',
    titles: { bronze: 'Winner', silver: 'Patience Pays', gold: 'Grandmaster' },
    description: (n) => `Win ${n} total games.`,
    icon: 'trophy',
    thresholds: { bronze: 5, silver: 50, gold: 250 },
    value: getTotalWins
  }),
  ...tieredFamily<StatsState>({
    id: 'win_streak',
    titles: { bronze: 'On a Roll', silver: 'Hot Hand', gold: 'Untouchable' },
    description: (n) => `Win ${n} games in a row with the same game and rules.`,
    icon: 'fire',
    thresholds: { bronze: 3, silver: 5, gold: 10 },
    value: getBestStreak
  }),
  ...winEachGameFamily(),
  ...tieredFamily<StatsState>({
    id: 'variety',
    titles: { bronze: 'Branching Out', silver: 'Well Rounded', gold: 'Full House' },
    description: (n) => (n === SOLITAIRE_GAME_IDS.length ? 'Win every game in the app.' : `Win ${n} different games.`),
    icon: 'view-grid',
    thresholds: { bronze: 2, silver: 3, gold: SOLITAIRE_GAME_IDS.length },
    value: getGamesWon
  }),
  // The speed, moves and score families are measured against PAR (engine/par.ts): a win's time, moves or score over
  // its own variant's par, so a Golf win and a 4-suit Spider win are judged by the same yardstick. Thresholds are
  // that ratio as a percent, negated so the engine's `>=` reads lower-is-better (see @tastic/achievements' tieredFamily
  // docs): -100 is at par, -80 is 20% under. -Infinity until something is won, so an unplayed profile clears nothing.
  // The ids (and so every tier already unlocked) predate par, when these were flat numbers across every game.
  ...tieredFamily<StatsState>({
    id: 'speed',
    titles: { bronze: 'Brisk', silver: 'Quick Hands', gold: 'Lightning' },
    description: (n) => `Win a game ${parPhrase(n)} on time.`,
    icon: 'timer',
    thresholds: { bronze: -100, silver: -80, gold: -60 },
    value: (stats) => parValue(getBestParRatio(stats, 'seconds')),
    // Required for a negated family: the automatic value/threshold fraction is inverted here and
    // would show a full bar for a player who is far too slow.
    progress: false
  }),
  ...tieredFamily<StatsState>({
    id: 'fewest_moves',
    titles: { bronze: 'Economical', silver: 'Efficient', gold: 'Minimalist' },
    description: (n) => `Win a game ${parPhrase(n)} on moves.`,
    icon: 'gesture-tap',
    // Tighter than time and score: par moves is already close to what a win takes.
    thresholds: { bronze: -100, silver: -95, gold: -90 },
    value: (stats) => parValue(getBestParRatio(stats, 'moves')),
    progress: false
  }),
  ...tieredFamily<StatsState>({
    id: 'low_score',
    titles: { bronze: 'Sharp Play', silver: 'Precision', gold: 'Perfectionist' },
    description: (n) => `Win a game with a score ${parPhrase(n)}.`,
    icon: 'target',
    thresholds: { bronze: -100, silver: -80, gold: -65 },
    value: (stats) => parValue(getBestParRatio(stats, 'score')),
    progress: false
  }),
  ...tieredFamily<StatsState>({
    id: 'days_played',
    titles: { bronze: 'Regular Visitor', silver: 'Dedicated', gold: 'Devoted' },
    description: (n) => `Play ${n} days in a row.`,
    icon: 'calendar-check',
    thresholds: { bronze: 3, silver: 14, gold: 30 },
    value: (stats) => stats.bestDayStreak
  }),
  ...tieredFamily<StatsState>({
    id: 'no_hints_needed',
    titles: { bronze: 'Self-Reliant', silver: 'No Help Needed', gold: 'True Solitaire' },
    description: (n) => `Win ${n} games without using a hint.`,
    icon: 'lightbulb-off-outline',
    thresholds: { bronze: 5, silver: 25, gold: 100 },
    value: getTotalWinsWithoutHint
  })
]
