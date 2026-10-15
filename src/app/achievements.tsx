import { getAchievementCatalogRows } from '@tastic/achievements'
import { AchievementRow, BaseStatsScreen, LOCKED_BADGE_COLOR, StatRow, StatSection, usePopoverHost } from '@tastic/hud'
import { ProfilePicker } from '@tastic/profile'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Text, useTheme } from 'react-native-paper'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { RotatedScreen } from '@/components/RotatedScreen'
import { CHROME_FG, CHROME_FG_MUTED, CHROME_SECTION_BG } from '@/components/theme'
import { useProfilePickerAlign } from '@/components/useProfilePickerAlign'
import { describeVsPar, parFor } from '@/engine/par'
import { VARIANTS } from '@/engine/variants'
import { ACHIEVEMENT_CATALOG } from '@/stores/achievementCatalog'
import { useGameStats } from '@/stores/gameStats'
import { usePlayerData } from '@/stores/playerData'
import { useProfiles } from '@/stores/profiles'
import { getBestParRatio, getBestStreak, getGamesWon, getProfileStatsView, getTotalHintsUsed, getTotalPlayed, getTotalWins } from '@/stores/statsEngine'
import { SOLITAIRE_GAME_IDS, SolitaireGameId } from '@/stores/statsTypes'
import { DEFAULT_PROFILE_STATS } from '@/stores/statsValidation'
import { safeBack } from '@/utils/navigation'

// Widest the stats column gets in the WIDE (landscape) layout - a list of stat rows stretched across a 874pt
// screen reads badly. Portrait is never capped (see @tastic/hud's RotatedFrame).
const SCREEN_MAX_WIDTH = 640

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

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Same rotated frame as every other screen (see RotatedScreen). `rotatedSafeArea` because BaseStatsScreen and the
 * content below read the safe-area insets themselves, and inside a turned frame the physical ones sit on the
 * wrong edges. */
export default function AchievementsScreen() {
  return (
    <RotatedScreen rotatedSafeArea maxContentWidth={SCREEN_MAX_WIDTH}>
      <AchievementsContent />
    </RotatedScreen>
  )
}

function AchievementsContent() {
  // Already remapped onto the rotated frame's edges by RotatedScreen's SafeAreaInsetsContext.
  const insets = useSafeAreaInsets()
  const { dark } = useTheme()
  const { stats, unlockedAchievements, resetAll } = useGameStats()
  const { resetPlayer } = usePlayerData()
  const { profiles } = useProfiles()
  // Own popover host, independent of whichever profile is active for gameplay elsewhere (see
  // stores/profiles.tsx's activeProfileId, which only drives the cosmetic card-back/felt color) -
  // this screen's own view of "whose stats am I looking at" is local and always resets to All
  // Profiles when reopened, matching every other @tastic game's achievements screen (e.g.
  // LightCycles').
  const profilePickerHost = usePopoverHost()
  // Frame-aware placement for the picker's popover (see useProfilePickerAlign) - @tastic/hud's own measures along
  // the wrong axes inside the turned frame. No Manage row here, so the popover is one row shorter than Home's.
  const profilePickerAlign = useProfilePickerAlign(profilePickerHost.openId === 'achievements-profile', profiles.length, false)

  // null = "All Profiles" (device-wide, today's original default view). Self-heals to null if the
  // selected profile gets deleted while this screen is still mounted.
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null)
  const effectiveProfileId = selectedProfileId && profiles.some((p) => p.id === selectedProfileId) ? selectedProfileId : null
  const profileBucket = effectiveProfileId ? (stats.profiles[effectiveProfileId] ?? DEFAULT_PROFILE_STATS) : null
  const statsView = profileBucket ? getProfileStatsView(profileBucket) : stats

  // Reset follows the picker: one player's stats, achievements and saved games while they are shown, everyone's on All
  // Profiles. A player's reset leaves the All Profiles totals alone, so the copy says so.
  const selectedName = effectiveProfileId ? (profiles.find((p) => p.id === effectiveProfileId)?.name ?? '') : null
  const reset = selectedName !== null ? { onReset: () => resetPlayer(effectiveProfileId!), label: `Reset ${selectedName}'s Stats`, title: `Reset ${selectedName}?`, body: `Erases ${selectedName}'s stats, achievements and saved games. All Profiles keeps its totals. This cannot be undone.` } : { onReset: resetAll, label: 'Reset All Stats', title: 'Reset Everything?', body: "Erases every player's stats, achievements and saved games. This cannot be undone." }

  const played = getTotalPlayed(statsView)
  const wins = getTotalWins(statsView)
  const bestScoreVsPar = getBestParRatio(statsView, 'score')

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
      <BaseStatsScreen onBack={safeBack} insets={insets} onReset={reset.onReset} resetLabel={reset.label} resetConfirmTitle={reset.title} resetConfirmBody={reset.body} fg={CHROME_FG} bg='transparent' rotation={0}>
        {profiles.length > 0 && <ProfilePicker idPrefix='achievements' host={profilePickerHost} profiles={profiles} selectedId={effectiveProfileId} color={CHROME_FG} dark={dark} guestLabel='All Profiles' nullLabel='All Profiles' nullIcon='account-group' onSelect={(profile) => setSelectedProfileId(profile?.id ?? null)} alignOverride={profilePickerAlign} />}

        <StatSection label='OVERALL' fg={CHROME_FG} sectionBg={CHROME_SECTION_BG}>
          <StatRow label='Games Played' value={String(played)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
          <StatRow label='Wins' value={String(wins)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
          <StatRow label='Win Rate' value={played > 0 ? `${Math.round((wins / played) * 100)}%` : '-'} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
          <StatRow label='Best Streak' value={String(getBestStreak(statsView))} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
          <StatRow label='Games Solved' value={`${getGamesWon(statsView)} / ${SOLITAIRE_GAME_IDS.length}`} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
          {/* Overall bests are measured against par: a raw lowest score or fastest time across all 11 games would just
          name the quickest game (Golf, Aces Up), not the best play. */}
          <StatRow label='Best Score' value={bestScoreVsPar === null ? '-' : describeVsPar(bestScoreVsPar, 1)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
          <StatRow label='Hints Used' value={String(getTotalHintsUsed(statsView))} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
        </StatSection>

        {/* Per variant: one game under one rule set (engine/variants.ts), since a 1-suit and a 4-suit Spider win aren't the
        same. A game's default rules always show; its other rules once a deal under them has been played. Each best is shown
        next to its par. "Lost" counts both ways a deal ends without a win: dealt over mid-game, and the No Moves Left dead
        board of Aces Up, Golf, TriPeaks, Forty Thieves and Scorpion - see stores/statsTypes.ts. */}
        {VARIANTS.filter((info, i) => i === 0 || VARIANTS[i - 1].game !== info.game || statsView.variants[info.id].record.played > 0).map((info) => {
          const v = statsView.variants[info.id]
          const par = parFor(info.id)
          const vsPar = (best: number | null, parValue: string, show: (n: number) => string) => (best === null ? `- · par ${parValue}` : `${show(best)} · par ${parValue}`)
          return (
            <StatSection key={info.id} label={`${GAME_TITLES[info.game]}${info.label ? ` · ${info.label}` : ''}`.toUpperCase()} fg={CHROME_FG} sectionBg={CHROME_SECTION_BG}>
              <StatRow label='Played' value={String(v.record.played)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
              <StatRow label='Won' value={String(v.record.wins)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
              <StatRow label='Lost' value={String(v.record.losses)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
              <StatRow label='Streak' value={`${v.streak.currentWinStreak} (best ${v.streak.bestWinStreak})`} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
              <StatRow label='Fastest' value={vsPar(v.bestTimeSeconds, formatTime(par.seconds), formatTime)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
              <StatRow label='Fewest Moves' value={vsPar(v.bestMoves, String(par.moves), String)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
              <StatRow label='Lowest Score' value={vsPar(v.bestScore, String(par.score), String)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
            </StatSection>
          )
        })}

        <StatSection label='ACTIVITY' fg={CHROME_FG} sectionBg={CHROME_SECTION_BG}>
          <StatRow label='Days Played' value={String(statsView.distinctDaysPlayed)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
          <StatRow label='Day Streak' value={String(statsView.currentDayStreak)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
          <StatRow label='Best Day Streak' value={String(statsView.bestDayStreak)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
        </StatSection>

        <Text variant='labelMedium' style={[styles.listLabel, { color: CHROME_FG_MUTED }]}>
          ALL ACHIEVEMENTS
        </Text>
        {getAchievementCatalogRows(ACHIEVEMENT_CATALOG, stats, statsView, unlockedAchievements, effectiveProfileId).map((row) => (
          <AchievementRow key={row.id} icon={row.icon} title={row.title} description={row.description} badgeColor={row.unlockedAt !== undefined ? row.tierColor : LOCKED_BADGE_COLOR} checkColor={row.tierColor} unlockedLabel={row.unlockedLabel} progress={row.progress} deviceMarker={row.deviceMarker} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} sectionBg={CHROME_SECTION_BG} />
        ))}
      </BaseStatsScreen>
    </View>
  )
}

const styles = StyleSheet.create({
  listLabel: {
    letterSpacing: 2,
    marginTop: 8
  },
  screen: {
    flex: 1
  }
})
