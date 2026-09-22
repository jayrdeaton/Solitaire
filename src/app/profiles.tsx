import { ProfilesScreen } from '@tastic/profile'
import { StyleSheet, View } from 'react-native'
import { useTheme } from 'react-native-paper'

import { RotatedScreen } from '@/components/RotatedScreen'
import { useFrameAutoAlign } from '@/components/useFrameAutoAlign'
import { CHROME_FG, DEFAULT_SEED_COLOR, previewCardBack, useTableColors } from '@/components/theme'
import { useProfiles } from '@/stores/profiles'
import { safeBack } from '@/utils/navigation'

// @tastic/profile's ProfilesScreen now owns the header row, back button, and
// managerRef/commitPendingEdit-before-navigate composition internally (see that component's own
// doc comment - it folds in the exact escape hatch this file used to hand-roll for expo-router's
// web renderer keeping a popped screen mounted-but-hidden instead of unmounting it, per this
// repo's own CLAUDE.md finding). This wrapper only themes it - ProfilesScreen owns its own opaque
// bg with no background-slot prop, so bg='transparent' lets the app-wide felt (TableBackground,
// mounted once in _layout.tsx) show through underneath, same as achievements.tsx's BaseStatsScreen
// usage. fg/cardBg/
// titleVariant/colorPreview mirror the same overrides the old ProfilesManager call passed
// directly - same chrome palette, same headlineSmall title size, instead of ProfilesScreen's own
// literal-black/white default and oversized displaySmall.
//
// Same rotated frame as every other screen (see RotatedScreen). `rotatedSafeArea` because ProfilesManager reads
// the safe-area insets itself (the header padding), and inside a turned frame the physical ones sit on the wrong
// edges; its delete-confirm is a Paper Portal, which lands in the Portal.Host RotatedScreen mounts INSIDE the frame
// and is turned with it (it has no rotation of its own). The edit row's colour swatch gets a frame-aware
// placement via `useColorPickerAlign` (@tastic/profile >= 0.9.0) - `useFrameAutoAlign`'s own signature already
// matches what it wants exactly (`(open, contentWidth, contentHeight) => AlignResult`), so it's passed straight
// through with no adapter.
export default function Profiles() {
  return (
    <RotatedScreen rotatedSafeArea maxContentWidth={SCREEN_MAX_WIDTH}>
      <ProfilesContent />
    </RotatedScreen>
  )
}

// Widest the roster gets in a wide (landscape) frame.
const SCREEN_MAX_WIDTH = 640

function ProfilesContent() {
  const { dark } = useTheme()
  const colors = useTableColors()
  const { profiles, createProfile, updateProfile, deleteProfile } = useProfiles()

  return (
    <View style={styles.container}>
      <ProfilesScreen profiles={profiles} defaultColor={DEFAULT_SEED_COLOR} onCreate={(patch) => createProfile(patch)} onSave={(id, patch) => updateProfile(id, patch)} onDelete={(id) => deleteProfile(id)} onBack={safeBack} fg={CHROME_FG} bg='transparent' cardBg={colors.tableFeltDark} titleVariant='headlineSmall' colorPreview={(hex) => previewCardBack(hex, dark)} useColorPickerAlign={useFrameAutoAlign} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 }
})
