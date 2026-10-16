import { PopoverHost } from '@tastic/hud'
import { ProfilePicker, type ProfilePickerColorSection } from '@tastic/profile'
import { useRouter } from 'expo-router'
import { useMemo } from 'react'
import { StyleSheet } from 'react-native'
import { useTheme } from 'react-native-paper'

import { previewCardBack } from '@/components/theme'
import { useProfilePickerAlign } from '@/components/useProfilePickerAlign'
import { DEFAULT_SEED_COLOR } from '@/constants/theme'
import { useProfiles } from '@/stores/profiles'

// The popover id prefix; the picker's own id is `${PROFILE_ID_PREFIX}-profile` (see @tastic/profile's
// ProfilePicker), which the frame-aware placement hook's `open` below checks.
const PROFILE_ID_PREFIX = 'home-player'

interface ProfilePanelProps {
  // Owned by the caller (Home) rather than this component, so Home can also render a full-screen
  // @tastic/hud PressAwayOverlay keyed off the same host - the same "host lives with the screen,
  // panel just consumes it" shape the fleet's split-screen loadout/lobby screens use for their own
  // player panels, scaled down to Solitaire's single, non-split zone.
  host: PopoverHost
}

// The player control on Home: ONE button (a chip in the color in effect with the player's tag, their
// name, a chevron) opening one dropdown, with the color at the top and the profiles under it (Jay,
// 2026-10-16). It used to be a color swatch beside a separate name dropdown, and it wasn't clear the
// swatch was a color for Solitaire only and a different thing from the profile.
export function ProfilePanel({ host }: ProfilePanelProps) {
  const router = useRouter()
  const { dark, colors: paperColors } = useTheme()
  const { profiles, activeProfileId, activeProfile, selectProfile, tableColorOverride, setTableColorOverride } = useProfiles()

  // Must be the raw seed, not useTableColors()'s derived colors.cardBack - the color section matches
  // this against each swatch's own raw value for the checkmark, and previewValue turns each into the
  // muted color that's actually drawn.
  const liveColor = tableColorOverride ?? DEFAULT_SEED_COLOR
  // "Solitaire only" tells a profile's player the pick doesn't change their color in the other games. Guest has
  // no color there, so Guest gets no caption.
  const hasProfile = activeProfile !== null
  const colorSection = useMemo<ProfilePickerColorSection>(() => ({ value: liveColor, onChange: setTableColorOverride, previewValue: (hex) => previewCardBack(hex, dark), label: 'Color', caption: hasProfile ? 'Solitaire only' : undefined }), [liveColor, setTableColorOverride, dark, hasProfile])

  // Home lives inside a fake-rotated frame, where the picker's own popover placement (it compares a
  // screen-space measurement with the un-rotated portrait window) picks the wrong side and can run the
  // popover under the notch/island or past the frame's bottom, so it's placed by a frame-aware hook
  // instead (`alignOverride`), sized from the same color section and Manage row the picker draws.
  const align = useProfilePickerAlign(host.openId === `${PROFILE_ID_PREFIX}-profile`, profiles.length, true, colorSection)
  // The pill's background can't live in the static StyleSheet below - it's a function of both `dark` and the
  // live Paper theme's surface color.
  const pillStyle = useMemo(() => [styles.pill, { backgroundColor: dark ? paperColors.surface : '#ffffffee' }], [dark, paperColors.surface])

  return <ProfilePicker idPrefix={PROFILE_ID_PREFIX} host={host} profiles={profiles} selectedId={activeProfileId} color={previewCardBack(liveColor, dark)} dark={dark} guestLabel='GUEST' nullLabel='Guest' onSelect={(profile) => selectProfile(profile?.id ?? null)} onManage={() => router.push('/profiles')} alignOverride={align} colorSection={colorSection} triggerStyle={pillStyle} />
}

const styles = StyleSheet.create({
  // A neutral surface behind the button, the same idea as the game tiles below (light mode: an opaque
  // near-white pill; dark mode: Paper's own surface color, set inline above since it depends on the live
  // theme) - the label and (once a color is chosen) the felt itself can otherwise wash it out.
  pill: {
    borderRadius: 999
  }
})
