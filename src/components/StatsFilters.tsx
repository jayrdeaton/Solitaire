import { type PopoverHost, PressAwayOverlay } from '@tastic/hud/chrome'
import { getOptionPickerContentSize, OptionPicker, type OptionPickerOption, type Profile } from '@tastic/profile'
import { useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import { useTheme } from 'react-native-paper'

import { previewCardBack } from '@/components/theme'
import { useFrameAutoAlign } from '@/components/useFrameAutoAlign'
import { GAME_TITLES, SOLITAIRE_GAME_IDS, type SolitaireGameId } from '@/stores/statsTypes'

/** Every game, or one. */
export type GameFilter = SolitaireGameId | 'all'

// The player picker's value for All Profiles (a profile id never takes this form).
const ALL_PROFILES = '__all__'

export const PLAYER_PICKER_ID = 'achievements-player'
export const GAME_PICKER_ID = 'achievements-game'

interface StatsFiltersProps {
  host: PopoverHost
  profiles: Profile[]
  // null = All Profiles.
  profileId: string | null
  onProfile: (profileId: string | null) => void
  game: GameFilter
  onGame: (game: GameFilter) => void
}

/**
 * The Stats screen's two pickers, side by side: whose stats (All Profiles, or one player: only once there is a profile, as
 * on every Tastic game's stats screen) and which game (All Games, or one, to narrow everything down to it: Jay, 2026-10-22).
 * Both are @tastic/profile's OptionPicker, the pill Home's player button is, on the theme's surface. They used to be
 * ProfilePicker's plain name trigger alone; a game picker beside it in OptionPicker's pill would not have matched, and
 * ProfilePicker draws a pill only with a color section, which a stats filter has no use for.
 */
export function StatsFilters({ host, profiles, profileId, onProfile, game, onGame }: StatsFiltersProps) {
  const { dark, colors } = useTheme()
  const pillStyle = useMemo(() => [styles.pill, { backgroundColor: colors.surface }], [colors.surface])

  const selectedProfile = profiles.find((p) => p.id === profileId) ?? null
  const profileOptions = useMemo<OptionPickerOption<string>[]>(() => [{ value: ALL_PROFILES, label: 'All Profiles', icon: 'account-group' }, ...profiles.map((p) => ({ value: p.id, label: p.name, icon: 'account', color: previewCardBack(p.color, dark) }))], [profiles, dark])
  const gameOptions = useMemo<OptionPickerOption<GameFilter>[]>(() => [{ value: 'all', label: 'All Games', icon: 'cards' }, ...SOLITAIRE_GAME_IDS.map((id) => ({ value: id, label: GAME_TITLES[id] }))], [])

  // Placed by the frame-aware hook, like Home's player button: inside the fake-rotated frame the pickers' own placement
  // measures along the wrong axes (see useFrameAutoAlign).
  const playerSize = getOptionPickerContentSize(profileOptions.length)
  const playerAlign = useFrameAutoAlign(host.openId === PLAYER_PICKER_ID, playerSize.width, playerSize.height)
  const gameSize = getOptionPickerContentSize(gameOptions.length)
  const gameAlign = useFrameAutoAlign(host.openId === GAME_PICKER_ID, gameSize.width, gameSize.height)

  // Mounted as two siblings in the stats screen's scroll content, as Home's player button is: a press-away overlay (closes
  // the menu on a tap anywhere else) and, above it, the pickers, raised over the cards that follow. Without the raise each
  // later card painted over the open menu, and on the web took its taps (see Home's profilePanelWrap).
  return (
    <>
      <PressAwayOverlay active={host.openId !== null} onPress={host.close} style={styles.pressAway} />
      <View style={styles.row}>
        {profiles.length > 0 && <OptionPicker id={PLAYER_PICKER_ID} host={host} options={profileOptions} value={profileId ?? ALL_PROFILES} onChange={(value) => onProfile(value === ALL_PROFILES ? null : value)} color={selectedProfile ? previewCardBack(selectedProfile.color, dark) : colors.primary} dark={dark} icon={selectedProfile ? 'account' : 'account-group'} alignOverride={playerAlign} triggerStyle={pillStyle} />}
        <OptionPicker id={GAME_PICKER_ID} host={host} options={gameOptions} value={game} onChange={onGame} color={colors.primary} dark={dark} icon={game === 'all' ? 'cards' : 'cards-playing-outline'} rowIcon='cards-playing-outline' alignOverride={gameAlign} triggerStyle={pillStyle} />
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  // The same pill as Home's player button (ProfilePanel): the theme's surface behind it, set inline from the live theme.
  pill: {
    borderRadius: 999
  },
  // Above the cards' own (unset) stacking, so a tap on blank space reaches it, and below the pickers.
  pressAway: {
    zIndex: 5
  },
  row: {
    columnGap: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    position: 'relative',
    rowGap: 8,
    zIndex: 10
  }
})
