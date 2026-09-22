import { getAchievementCatalogRows } from '@tastic/achievements'
import { AchievementRow, BaseStatsScreen, LOCKED_BADGE_COLOR, StatRow, StatSection, usePopoverHost } from '@tastic/hud'
import { ProfilePicker } from '@tastic/profile'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Text, useTheme } from 'react-native-paper'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { LoadingIndicator } from '@/components/GameLoading'
import { RotatedScreen } from '@/components/RotatedScreen'
import { CHROME_FG, CHROME_FG_MUTED, CHROME_SECTION_BG } from '@/components/theme'
import { useProfilePickerAlign } from '@/components/useProfilePickerAlign'
import { ACHIEVEMENT_CATALOG } from '@/stores/achievementCatalog'
import { useGameStats } from '@/stores/gameStats'
import { useProfiles } from '@/stores/profiles'
import { getBestMoves, getBestScore, getBestStreak, getBestTimeSeconds, getProfileStatsView, getTotalHintsUsed, getTotalPlayed, getTotalWins, getVariantsWon } from '@/stores/statsEngine'
import { SOLITAIRE_GAME_IDS, SolitaireGameId } from '@/stores/statsTypes'
import { DEFAULT_PROFILE_STATS } from '@/stores/statsValidation'
import { safeBack } from '@/utils/navigation'

// Widest the stats column gets in the WIDE (landscape) layout - a list of stat rows stretched across a 874pt
// screen reads badly. Portrait is never capped (see RotatedFrame).
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
  const { stats, unlockedAchievements, loaded, resetAll } = useGameStats()
  const { profiles } = useProfiles()
  // Own popover host, independent of whichever profile is active for gameplay elsewhere (see
  // stores/profiles.tsx's activeProfileId, which only drives the cosmetic card-back/felt color) —
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

  const played = getTotalPlayed(statsView)
  const wins = getTotalWins(statsView)
  const bestTime = getBestTimeSeconds(statsView)
  const bestMoves = getBestMoves(statsView)
  const bestScore = getBestScore(statsView)

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
      <BaseStatsScreen onBack={safeBack} insets={insets} onReset={resetAll} fg={CHROME_FG} bg='transparent' rotation={0}>
        {!loaded ? (
          // Stats load asynchronously from AsyncStorage (see useGameStats' own `loaded` doc comment) -
          // without this guard, this screen would render a full flash of zeroed-out "0 games played"
          // content for a beat before the real numbers pop in once the read resolves.
          <View style={styles.loading}>
            <LoadingIndicator />
          </View>
        ) : (
          <>
            {profiles.length > 0 && <ProfilePicker idPrefix='achievements' host={profilePickerHost} profiles={profiles} selectedId={effectiveProfileId} color={CHROME_FG} dark={dark} guestLabel='All Profiles' nullLabel='All Profiles' nullIcon='account-group' onSelect={(profile) => setSelectedProfileId(profile?.id ?? null)} alignOverride={profilePickerAlign} />}

            <StatSection label='OVERALL' fg={CHROME_FG} sectionBg={CHROME_SECTION_BG}>
              <StatRow label='Games Played' value={String(played)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
              <StatRow label='Wins' value={String(wins)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
              <StatRow label='Win Rate' value={played > 0 ? `${Math.round((wins / played) * 100)}%` : '—'} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
              <StatRow label='Best Streak' value={String(getBestStreak(statsView))} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
              <StatRow label='Games Solved' value={`${getVariantsWon(statsView)} / ${SOLITAIRE_GAME_IDS.length}`} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
              <StatRow label='Fastest Win' value={bestTime === null ? '—' : formatTime(bestTime)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
              <StatRow label='Fewest Moves' value={bestMoves === null ? '—' : String(bestMoves)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
              <StatRow label='Lowest Score' value={bestScore === null ? '—' : String(bestScore)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
              <StatRow label='Hints Used' value={String(getTotalHintsUsed(statsView))} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
            </StatSection>

            {/* Per game. "Abandoned" rather than "lost": a solitaire deal is won or walked away from,
          never lost outright — see stores/statsTypes.ts. */}
            {SOLITAIRE_GAME_IDS.map((id) => {
              const v = statsView.variants[id]
              return (
                <StatSection key={id} label={GAME_TITLES[id].toUpperCase()} fg={CHROME_FG} sectionBg={CHROME_SECTION_BG}>
                  <StatRow label='Played' value={String(v.record.played)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
                  <StatRow label='Won' value={String(v.record.wins)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
                  <StatRow label='Abandoned' value={String(v.record.losses)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
                  <StatRow label='Streak' value={`${v.streak.currentWinStreak} (best ${v.streak.bestWinStreak})`} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
                  <StatRow label='Fastest' value={v.bestTimeSeconds === null ? '—' : formatTime(v.bestTimeSeconds)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
                  <StatRow label='Fewest Moves' value={v.bestMoves === null ? '—' : String(v.bestMoves)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
                  <StatRow label='Lowest Score' value={v.bestScore === null ? '—' : String(v.bestScore)} fg={CHROME_FG} fgMuted={CHROME_FG_MUTED} />
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
          </>
        )}
      </BaseStatsScreen>
    </View>
  )
}

const styles = StyleSheet.create({
  listLabel: {
    letterSpacing: 2,
    marginTop: 8
  },
  loading: {
    alignItems: 'center',
    marginTop: 24
  },
  screen: {
    flex: 1
  }
})
