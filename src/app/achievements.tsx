import { getBlendedColor } from '@rific/auto-paper'
import { getAchievementCatalogRows } from '@tastic/achievements'
import { AchievementRow, BaseStatsScreen, LOCKED_BADGE_COLOR, type PopoverHost, StatRow, StatSection, usePopoverHost } from '@tastic/hud/chrome'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { SegmentedButtons, useTheme } from 'react-native-paper'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { PlayCalendar } from '@/components/PlayCalendar'
import { RotatedScreen } from '@/components/RotatedScreen'
import { type GameFilter, StatsFilters, StatsPressAway } from '@/components/StatsFilters'
import { CHROME_FG } from '@/components/theme'
import { describeVsPar, parFor, playerParFor } from '@/engine/par'
import { VARIANTS } from '@/engine/variants'
import { GUEST_PLAYER_ID } from '@/redux/activeProfileSlice'
import { ACHIEVEMENT_CATALOG } from '@/stores/achievementCatalog'
import { useGameStats } from '@/stores/gameStats'
import { usePlayerData } from '@/stores/playerData'
import { useProfiles } from '@/stores/profiles'
import { getAverageWin, getBestParRatio, getBestStreak, getBusiestDay, getCardsDealt, getGamesWon, getGameView, getLeastPlayedGame, getMostPlayedGame, getProfileStatsView, getTotalHintsUsed, getTotalMoves, getTotalPlayed, getTotalSeconds, getTotalUndosUsed, getTotalWins, getTotalWinsWithoutHint } from '@/stores/statsEngine'
import { GAME_TITLES, SOLITAIRE_GAME_IDS } from '@/stores/statsTypes'
import { DEFAULT_PROFILE_STATS } from '@/stores/statsValidation'
import { commaString } from '@/utils/commaString'
import { safeBack } from '@/utils/navigation'

// Widest the stats column gets in the WIDE (landscape) layout - a list of stat rows stretched across a 874pt
// screen reads badly. Portrait is never capped (see @tastic/hud's RotatedFrame).
const SCREEN_MAX_WIDTH = 640

/** The screen's two tabs (Jay, 2026-10-22): one page had grown so long, with every rule set's stats above them, that the
 * achievements sat out of sight at the bottom. */
type StatsTab = 'stats' | 'achievements'
const TABS = [
  { value: 'stats', label: 'Stats', icon: 'chart-box-outline' },
  { value: 'achievements', label: 'Achievements', icon: 'trophy-outline' }
]

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** A total of play time: minutes and seconds under an hour, then hours and minutes ("3h 05m"). */
function formatDuration(seconds: number): string {
  if (seconds < 3600) return formatTime(seconds)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h ${String(m).padStart(2, '0')}m`
}

const winRate = (wins: number, played: number) => (played > 0 ? `${Math.round((wins / played) * 100)}%` : '-')

/** Same rotated frame as every other screen (see RotatedScreen). `rotatedSafeArea` because BaseStatsScreen and the
 * content below read the safe-area insets themselves, and inside a turned frame the physical ones sit on the
 * wrong edges. */
export default function AchievementsScreen() {
  // Own popover host for the two pickers (StatsFilters), independent of whichever profile is active for gameplay
  // elsewhere (see stores/profiles.tsx's activeProfileId, which only drives the cosmetic card-back/felt color) - this
  // screen's own view of "whose stats am I looking at" is local and always resets to Everyone when reopened,
  // matching every other @tastic game's achievements screen (e.g. LightCycles'). So does the game it is narrowed to.
  // Held out here, around the whole frame, so a press on the header or beside the content column closes an open menu too
  // (StatsPressAway).
  const pickerHost = usePopoverHost()
  return (
    <StatsPressAway host={pickerHost}>
      <RotatedScreen rotatedSafeArea maxContentWidth={SCREEN_MAX_WIDTH}>
        <AchievementsContent pickerHost={pickerHost} />
      </RotatedScreen>
    </StatsPressAway>
  )
}

function AchievementsContent({ pickerHost }: { pickerHost: PopoverHost }) {
  // Already remapped onto the rotated frame's edges by RotatedScreen's SafeAreaInsetsContext.
  const insets = useSafeAreaInsets()
  const { dark, colors } = useTheme()
  // The wells (every StatSection and AchievementRow) take hud's own colors: the theme's surface on MD3's level-1
  // shadow, with its onSurface text (hud's wellSurface.ts), the same surface as Home's tiles and every dialog (Jay,
  // 2026-10-17: one surface for every raised card). They used to be a 12% white tint over the felt with white text.
  // What sits on the felt itself (the picker, the list label, the header) stays CHROME_FG.
  // The check mark and progress bar: the tier color mixed half with black in light mode, as hud's
  // AchievementCatalogSection does - raw gold and silver barely show on a light surface. The badge keeps the true
  // tier color behind its black glyph.
  const tierAccent = (tierColor: string) => (dark ? tierColor : getBlendedColor('#000000', tierColor, 0.5))
  const { stats, unlockedAchievements, resetAll, recentWins } = useGameStats()
  const { resetPlayer } = usePlayerData()
  const { profiles } = useProfiles()
  const [game, setGame] = useState<GameFilter>('all')
  const [tab, setTab] = useState<StatsTab>('stats')

  // null = Everyone (device-wide, the default view); GUEST_PLAYER_ID = guest, who has a bucket of their own like a
  // profile (stores/gameStats.tsx). Self-heals to null if the selected profile gets deleted while this screen is still
  // mounted, and from Guest once there is no profile (the picker is gone, and Everyone is then just guest).
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null)
  const effectiveProfileId = selectedProfileId && profiles.length > 0 && (selectedProfileId === GUEST_PLAYER_ID || profiles.some((p) => p.id === selectedProfileId)) ? selectedProfileId : null
  const profileBucket = effectiveProfileId ? (stats.profiles[effectiveProfileId] ?? DEFAULT_PROFILE_STATS) : null
  const statsView = profileBucket ? getProfileStatsView(profileBucket) : stats
  // What the stat sections show: the player's (or everyone's) stats, narrowed to the game picked. The achievements below
  // are milestones across every game, so they always read the whole of statsView.
  const shown = game === 'all' ? statsView : getGameView(statsView, game)

  // Reset follows the picker: one player's (or guest's) stats, achievements and saved games while they are shown,
  // everyone's on Everyone. A player's reset leaves the Everyone totals alone, so the copy says so.
  const selectedName = effectiveProfileId === GUEST_PLAYER_ID ? 'Guest' : effectiveProfileId ? (profiles.find((p) => p.id === effectiveProfileId)?.name ?? '') : null
  const reset = selectedName !== null ? { onReset: () => resetPlayer(effectiveProfileId!), label: `Reset ${selectedName}'s Stats`, title: `Reset ${selectedName}?`, body: `Erases ${selectedName}'s stats, achievements and saved games. The totals under Everyone stay. This cannot be undone.` } : { onReset: resetAll, label: 'Reset All Stats', title: 'Reset Everything?', body: "Erases every player's stats, achievements and saved games. This cannot be undone." }

  // Whose par the per-variant rows show: the player picked, or guest on a phone with no profiles (Everyone is then just
  // guest). Everyone with profiles is everyone at once, and a par is one player's (engine/par.ts' playerParFor).
  const parPlayer = effectiveProfileId ?? (profiles.length === 0 ? GUEST_PLAYER_ID : null)

  const played = getTotalPlayed(shown)
  const wins = getTotalWins(shown)
  const bestScoreVsPar = getBestParRatio(shown, 'score')
  const mostPlayed = getMostPlayedGame(shown)
  const leastPlayed = getLeastPlayedGame(shown)
  const busiestDay = getBusiestDay(shown)

  return (
    // A transparent BaseStatsScreen over the app-wide felt (TableBackground, mounted once in
    // _layout.tsx - see its own doc comment), same as every other top-level screen. No
    // accentColor/cardBg overrides (there used to be both, pinned to CHROME_FG/white and
    // tableFeltDark respectively) - BaseStatsScreen's
    // reset-confirm step now renders a real ConfirmDialog instance instead of its own hand-styled
    // lookalike, so it always looks exactly like every other confirm prompt in the app (including
    // this game's own "Start a new game?" dialogs) - same danger-red icon/title, same outlined
    // Cancel + filled Reset button layout, same neutral black/white card - rather than this
    // screen's own tinted felt bleeding into just this one dialog and making it look like a
    // different component (see this app's CLAUDE.md).
    <View style={styles.screen}>
      {/* rotation={0}: its reset-confirm portals into the Portal.Host RotatedScreen mounts INSIDE the frame, so it is
      already turned with it - the ambient rotation on top would turn it twice. */}
      <BaseStatsScreen title={tab === 'stats' ? 'Stats' : 'Achievements'} onBack={safeBack} insets={insets} onReset={reset.onReset} resetLabel={reset.label} resetConfirmTitle={reset.title} resetConfirmBody={reset.body} fg={CHROME_FG} bg='transparent' rotation={0}>
        {/* Settings' Appearance switch (Paper's SegmentedButtons), on the theme's surface like the pickers below it, so it reads
        on the felt. The header's title follows it. */}
        <SegmentedButtons value={tab} onValueChange={(value) => setTab(value as StatsTab)} buttons={TABS} style={[styles.tabs, { backgroundColor: colors.surface }]} />

        {/* The game picker only narrows the stats: the achievements are milestones across every game. */}
        <StatsFilters host={pickerHost} profiles={profiles} profileId={effectiveProfileId} onProfile={setSelectedProfileId} game={game} onGame={setGame} showGame={tab === 'stats'} />

        {tab === 'stats' && (
          <>
            {/* The calendar of play first, in a well of its own: a year at a glance is the most telling thing here, and its tap
        tooltip (drawn above the grid) has room over the label instead of covering a stat (Jay, 2026-10-22). */}
            <StatSection label='CALENDAR'>
              <PlayCalendar days={shown.days} />
            </StatSection>

            {/* Narrowed to one game this is that game's totals, under its name; which games were solved and the most played game
        then have nothing to say. */}
            <StatSection label={game === 'all' ? 'OVERALL' : GAME_TITLES[game].toUpperCase()}>
              <StatRow label='Games Played' value={commaString(played)} />
              <StatRow label='Wins' value={commaString(wins)} />
              <StatRow label='Win Rate' value={winRate(wins, played)} />
              <StatRow label='Best Game Streak' value={commaString(getBestStreak(shown))} />
              {game === 'all' && <StatRow label='Games Solved' value={`${getGamesWon(shown)} / ${SOLITAIRE_GAME_IDS.length}`} />}
              {/* Overall bests are measured against par: a raw lowest score or fastest time across all 11 games would just
          name the quickest game (Golf, Aces Up), not the best play. */}
              <StatRow label='Best Score' value={bestScoreVsPar === null ? '-' : describeVsPar(bestScoreVsPar, 1, 'expert par')} />
              {game === 'all' && <StatRow label='Most Played' value={mostPlayed ? GAME_TITLES[mostPlayed] : '-'} />}
              {game === 'all' && leastPlayed && <StatRow label='Least Played' value={GAME_TITLES[leastPlayed]} />}
              {/* Time Played and Moves Made count every deal that ended, won or lost, since 2026-10-22 (statsTypes.ts). */}
              <StatRow label='Time Played' value={formatDuration(getTotalSeconds(shown))} />
              <StatRow label='Moves Made' value={commaString(getTotalMoves(shown))} />
              <StatRow label='Cards Dealt' value={commaString(getCardsDealt(shown))} />
              <StatRow label='Hints Used' value={commaString(getTotalHintsUsed(shown))} />
              <StatRow label='Undos Used' value={commaString(getTotalUndosUsed(shown))} />
              <StatRow label='Wins Without Hints' value={commaString(getTotalWinsWithoutHint(shown))} />
            </StatSection>

            {/* Right under OVERALL (it used to come after every game's section, out of sight). Win Streak runs across every game,
        from 2026-10-22; Most Deals in a Day reads the day log kept from then (stores/statsTypes.ts' `days`). Narrowed to one
        game, the days and day streaks come from that log too (getGameView), and there is no streak across games. */}
            <StatSection label='ACTIVITY'>
              <StatRow label='Days Played' value={commaString(shown.distinctDaysPlayed)} />
              <StatRow label='Day Streak' value={commaString(shown.currentDayStreak)} />
              <StatRow label='Best Day Streak' value={commaString(shown.bestDayStreak)} />
              {game === 'all' && <StatRow label='Win Streak, All Games' value={`${shown.winStreak.currentWinStreak} (best ${shown.winStreak.bestWinStreak})`} />}
              <StatRow label='Most Deals in a Day' value={busiestDay ? commaString(busiestDay.played) : '-'} />
            </StatSection>

            {/* Per variant: one game under one rule set (engine/variants.ts), since a 1-suit and a 4-suit Spider win aren't the
        same. A game's default rules always show, and its other rules once a deal under them has been played; narrowed to one
        game, all of its rules. Expert Par is a variant's par in full (score, time, moves; engine/par.ts), Your Par the shown
        player's own (their last 20 wins), and each best and Your Par say how they compare with it (Jay, 2026-10-22: what
        expert par is and how a player measures up). "Lost" counts both ways a deal ends without a win: dealt over mid-game,
        and the No Moves Left dead board (useStuckLossCheck) - see stores/statsTypes.ts. */}
            {VARIANTS.filter((info, i) => (game === 'all' ? i === 0 || VARIANTS[i - 1].game !== info.game || shown.variants[info.id].record.played > 0 : info.game === game)).map((info) => {
              const v = shown.variants[info.id]
              const par = parFor(info.id)
              const vsExpert = (best: number | null, expert: number, show: (n: number) => string) => (best === null ? '-' : `${show(best)} · ${describeVsPar(best, expert, 'expert')}`)
              const yourPar = parPlayer === null ? null : playerParFor(info.id, recentWins[parPlayer]?.[info.id] ?? [])
              // The average win is over the wins added up since 2026-10-22 (statsTypes.ts' winsCounted).
              const average = getAverageWin(v)
              return (
                <StatSection key={info.id} label={`${GAME_TITLES[info.game]}${info.label ? ` · ${info.label}` : ''}`.toUpperCase()}>
                  <StatRow label='Played' value={commaString(v.record.played)} />
                  <StatRow label='Won' value={commaString(v.record.wins)} />
                  <StatRow label='Lost' value={commaString(v.record.losses)} />
                  <StatRow label='Win Rate' value={winRate(v.record.wins, v.record.played)} />
                  <StatRow label='Streak' value={`${v.streak.currentWinStreak} (best ${v.streak.bestWinStreak})`} />
                  <StatRow label='Expert Par' value={`${commaString(par.score)} · ${formatTime(par.seconds)} · ${commaString(par.moves)} moves`} />
                  {yourPar && <StatRow label='Your Par' value={yourPar.kind === 'personal' ? `${commaString(yourPar.score)} · ${describeVsPar(yourPar.score, par.score, 'expert')}` : '-'} />}
                  <StatRow label='Lowest Score' value={vsExpert(v.bestScore, par.score, commaString)} />
                  <StatRow label='Fastest' value={vsExpert(v.bestTimeSeconds, par.seconds, formatTime)} />
                  <StatRow label='Fewest Moves' value={vsExpert(v.bestMoves, par.moves, commaString)} />
                  <StatRow label='Average Score' value={average ? commaString(Math.round(average.score)) : '-'} />
                  <StatRow label='Average Time' value={average ? formatTime(average.seconds) : '-'} />
                  <StatRow label='Average Moves' value={average ? commaString(Math.round(average.moves)) : '-'} />
                  <StatRow label='Time Played' value={formatDuration(v.totalSeconds)} />
                  <StatRow label='Hints Used' value={commaString(v.hintsUsed)} />
                  <StatRow label='Undos Used' value={commaString(v.undosUsed)} />
                  <StatRow label='Wins Without Hints' value={commaString(v.winsWithoutHint)} />
                </StatSection>
              )
            })}
          </>
        )}

        {tab === 'achievements' && getAchievementCatalogRows(ACHIEVEMENT_CATALOG, stats, statsView, unlockedAchievements, effectiveProfileId).map((row) => <AchievementRow key={row.id} icon={row.icon} title={row.title} description={row.description} badgeColor={row.unlockedAt !== undefined ? row.tierColor : LOCKED_BADGE_COLOR} checkColor={tierAccent(row.tierColor)} unlockedLabel={row.unlockedLabel} progress={row.progress} deviceMarker={row.deviceMarker} />)}
      </BaseStatsScreen>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1
  },
  // SegmentedButtons' own rounding, so the surface behind it is the same pill.
  tabs: {
    borderRadius: 20
  }
})
