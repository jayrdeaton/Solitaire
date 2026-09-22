import { defaultColors } from '@rific/auto-paper'
import { getInlineColorPickerContentSize, InlineColorPicker, PopoverHost } from '@tastic/hud'
import { ProfilePicker } from '@tastic/profile'
import { useRouter } from 'expo-router'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import { useTheme } from 'react-native-paper'

import { DEFAULT_SEED_COLOR, previewCardBack } from '@/components/theme'
import { useFrameAutoAlign } from '@/components/useFrameAutoAlign'
import { useProfilePickerAlign } from '@/components/useProfilePickerAlign'
import { useProfiles } from '@/stores/profiles'

// The popover host ids of the two triggers - shared with the frame-aware placement hooks' `open` below. The
// profile picker's is `${idPrefix}-profile` (see @tastic/profile's ProfilePicker).
const COLOR_PICKER_ID = 'home-player-color'
const PROFILE_ID_PREFIX = 'home-player'

interface ProfilePanelProps {
  // Owned by the caller (Home) rather than this component, so Home can also render a full-screen
  // @tastic/hud PressAwayOverlay keyed off the same host - the same "host lives with the screen,
  // panel just consumes it" shape the fleet's split-screen loadout/lobby screens use for their own
  // player panels, scaled down to Solitaire's single, non-split zone.
  host: PopoverHost
}

// Single-seat profile picker + color override for the main screen - Solitaire's simpler
// counterpart to the fleet's per-seat loadout panels (no takenId/takenValue/allowSwapTaken, since
// there's no second seat to conflict with here).
export function ProfilePanel({ host }: ProfilePanelProps) {
  const router = useRouter()
  const { dark, colors: paperColors } = useTheme()
  const { profiles, activeProfileId, selectProfile, tableColorOverride, setTableColorOverride } = useProfiles()

  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? null
  // Must be the raw seed, not useTableColors()'s derived colors.cardBack - InlineColorPicker
  // matches this against each swatch's own raw value to show the checkmark, and previewValue
  // already handles turning it into the muted color that's actually rendered.
  const liveColor = tableColorOverride ?? DEFAULT_SEED_COLOR

  // Home lives inside a fake-rotated frame, where @tastic/hud's own popover placement (it compares a
  // screen-space measurement with the un-rotated portrait window) picks the wrong side and can run a popover
  // under the notch/island or past the frame's bottom. So both popovers are placed by a frame-aware hook instead
  // (`alignOverride`): the swatch sized with the same raw-window-width formula InlineColorPicker itself uses, the
  // profile list with @tastic/profile's own getProfilePickerContentSize (this picker has a Manage row).
  const { width: windowWidth } = useWindowDimensions()
  const { width: swatchesWidth, height: swatchesHeight } = getInlineColorPickerContentSize(defaultColors.length, windowWidth)
  const swatchAlign = useFrameAutoAlign(host.openId === COLOR_PICKER_ID, swatchesWidth, swatchesHeight)
  const profileAlign = useProfilePickerAlign(host.openId === `${PROFILE_ID_PREFIX}-profile`, profiles.length, true)

  return (
    // backgroundColor genuinely can't live in the static StyleSheet below - it's a function of
    // both `dark` and the live Paper theme's surface color, neither of which a module-level
    // StyleSheet.create can see (same reasoning SettingsDialog.tsx's PreviewOption borderColor
    // documents for the identical situation).
    // eslint-disable-next-line react-native/no-inline-styles
    <View style={[styles.row, { backgroundColor: dark ? paperColors.surface : '#ffffffee' }]}>
      <InlineColorPicker id={COLOR_PICKER_ID} host={host} value={liveColor} onChange={setTableColorOverride} previewValue={(hex) => previewCardBack(hex, dark)} dark={dark} tag={activeProfile?.tag} alignOverride={swatchAlign} />
      <ProfilePicker idPrefix={PROFILE_ID_PREFIX} host={host} profiles={profiles} selectedId={activeProfileId} color={previewCardBack(liveColor, dark)} dark={dark} guestLabel='GUEST' nullLabel='Guest' onSelect={(profile) => selectProfile(profile?.id ?? null)} onManage={() => router.push('/profiles')} alignOverride={profileAlign} />
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    // Neutral surface behind the trigger/swatch pair - same idea as the game cards below (light
    // mode: an opaque near-white pill; dark mode: Paper's own surface color, set inline above
    // since it depends on the live theme) - both the picker's label text and (once a color is
    // chosen) the felt itself can otherwise wash the row out against the table.
    borderRadius: 999,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 6
  }
})
