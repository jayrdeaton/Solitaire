import { tieredFamily } from '@tastic/achievements'

import { getBestMoves, getBestScore, getBestStreak, getBestTimeSeconds, getTotalPlayed, getTotalWins, getTotalWinsWithoutHint, getVariantsWon } from './statsEngine'
import { AchievementDefinition, SOLITAIRE_GAME_IDS, SolitaireGameId, StatsState } from './statsTypes'

export { ACHIEVEMENT_TIER_COLORS } from '@tastic/achievements'

const GAME_TITLES: Record<SolitaireGameId, string> = {
  klondike: 'Klondike',
  spider: 'Spider',
  freecell: 'FreeCell',
  pyramid: 'Pyramid',
  yukon: 'Yukon',
  golf: 'Golf',
  tripeaks: 'TriPeaks',
  canfield: 'Canfield',
  scorpion: 'Scorpion',
  fortythieves: 'Forty Thieves',
  acesup: 'Aces Up'
}

// One per game — four different predicates, not one value against three thresholds, so these are
// hand-written and carry no progress. All silver: no single game is meaningfully harder to win
// once than the others, so tiering them against each other would be arbitrary.
function winEachGameFamily(): AchievementDefinition[] {
  return SOLITAIRE_GAME_IDS.map((id) => ({
    id: `win_${id}`,
    title: `${GAME_TITLES[id]} Solved`,
    description: `Win a game of ${GAME_TITLES[id]}.`,
    tier: 'silver' as const,
    icon: 'cards-playing-outline',
    isUnlocked: (stats: StatsState) => stats.variants[id].record.wins >= 1
  }))
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
    description: 'Win a game — any game, any time.',
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
    description: (n) => `Win ${n} games of one variant in a row.`,
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
    value: getVariantsWon
  }),
  ...tieredFamily<StatsState>({
    id: 'speed',
    titles: { bronze: 'Brisk', silver: 'Quick Hands', gold: 'Lightning' },
    description: (n) => `Win a game in under ${-n / 60} minutes.`,
    icon: 'timer',
    // Lower-is-better: both the value and the thresholds are negated so the engine's `>=` still
    // reads correctly (see @tastic/achievements' own tieredFamily docs). -Infinity until something
    // has actually been won, so an unplayed profile never clears a speed tier by default.
    thresholds: { bronze: -600, silver: -300, gold: -180 },
    value: (stats) => {
      const best = getBestTimeSeconds(stats)
      return best === null ? -Infinity : -best
    },
    // Required for a negated family: the automatic value/threshold fraction is inverted here and
    // would show a full bar for a player who is far too slow.
    progress: false
  }),
  ...tieredFamily<StatsState>({
    id: 'fewest_moves',
    titles: { bronze: 'Economical', silver: 'Efficient', gold: 'Minimalist' },
    description: (n) => `Win a game in ${-n} moves or fewer.`,
    icon: 'gesture-tap',
    // Lower-is-better: see the 'speed' family above for why value/thresholds are negated.
    thresholds: { bronze: -120, silver: -80, gold: -50 },
    value: (stats) => {
      const best = getBestMoves(stats)
      return best === null ? -Infinity : -best
    },
    progress: false
  }),
  ...tieredFamily<StatsState>({
    id: 'low_score',
    titles: { bronze: 'Sharp Play', silver: 'Precision', gold: 'Perfectionist' },
    description: (n) => `Win a game with a score of ${-n} or lower.`,
    icon: 'target',
    // Lower-is-better: see the 'speed' family above for why value/thresholds are negated.
    thresholds: { bronze: -250, silver: -150, gold: -90 },
    value: (stats) => {
      const best = getBestScore(stats)
      return best === null ? -Infinity : -best
    },
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
