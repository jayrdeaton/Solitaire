import { InlineColorPicker, usePopoverHost } from '@tastic/hud';
import { ProfilePicker } from '@tastic/profile';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useTheme } from 'react-native-paper';
import { DEFAULT_SEED_COLOR, previewCardBack } from '@/components/theme';
import { useProfiles } from '@/stores/profiles';

// Single-seat profile picker + color override for the main screen - Solitaire's simpler
// counterpart to the fleet's per-seat loadout panels (no takenId/takenValue/allowSwapTaken, since
// there's no second seat to conflict with here).
export function ProfilePanel() {
  const router = useRouter();
  const { dark } = useTheme();
  const { profiles, activeProfileId, selectProfile, tableColorOverride, setTableColorOverride } = useProfiles();
  const host = usePopoverHost();

  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? null;
  // Must be the raw seed, not useTableColors()'s derived colors.cardBack - InlineColorPicker
  // matches this against each swatch's own raw value to show the checkmark, and previewValue
  // already handles turning it into the muted color that's actually rendered.
  const liveColor = tableColorOverride ?? DEFAULT_SEED_COLOR;

  return (
    <View style={styles.row}>
      <InlineColorPicker
        id="home-player-color"
        host={host}
        value={liveColor}
        onChange={setTableColorOverride}
        previewValue={(hex) => previewCardBack(hex, dark)}
        dark={dark}
        tag={activeProfile?.tag}
      />
      <ProfilePicker
        idPrefix="home-player"
        host={host}
        profiles={profiles}
        selectedId={activeProfileId}
        color={previewCardBack(liveColor, dark)}
        dark={dark}
        guestLabel="GUEST"
        nullLabel="Guest"
        onSelect={(profile) => selectProfile(profile?.id ?? null)}
        onManage={() => router.push('/profiles')}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    // Neutral surface behind the trigger/swatch pair - same translucent-white pill the game cards
    // below already use, since both the picker's label text and (once a color is chosen) the felt
    // itself can otherwise wash the row out against the table.
    backgroundColor: '#ffffffee',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
});
