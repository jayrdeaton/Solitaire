import { ProfilesScreen } from '@tastic/profile'
import { StyleSheet, View } from 'react-native'

import { RotatedScreen } from '@/components/RotatedScreen'
import { CHROME_FG } from '@/components/theme'
import { useFrameAutoAlign } from '@/components/useFrameAutoAlign'
import { DEFAULT_SEED_COLOR } from '@/constants/theme'
import { forgetPlayerData } from '@/stores/playerData'
import { useProfiles } from '@/stores/profiles'
import { safeBack } from '@/utils/navigation'

// @tastic/profile's ProfilesScreen now owns the header row, back button, and
// managerRef/commitPendingEdit-before-navigate composition internally (see that component's own
// doc comment - it folds in the exact escape hatch this file used to hand-roll for expo-router's
// web renderer keeping a popped screen mounted-but-hidden instead of unmounting it, per this
// repo's own CLAUDE.md finding). This wrapper only themes it - ProfilesScreen owns its own opaque
// bg with no background-slot prop, so bg='transparent' lets the app-wide felt (TableBackground,
// mounted once in _layout.tsx) show through underneath, same as achievements.tsx's BaseStatsScreen
// usage. fg/titleVariant mirror the same overrides the old ProfilesManager call passed
// directly - same chrome palette, same headlineSmall title size, instead of ProfilesScreen's own
// literal-black/white default and oversized displaySmall. Muted profile colors (chips and swatch
// previews alike) come from _layout.tsx's MutedProfileColors, not a prop here.
//
// Same rotated frame as every other screen (see RotatedScreen). `rotatedSafeArea` because ProfilesManager reads
// the safe-area insets itself (the header padding), and inside a turned frame the physical ones sit on the wrong
// edges; its delete-confirm is hud's ConfirmDialog (@tastic/profile 0.13.0+, the same card as every other confirm
// here), a Paper Portal, which lands in the Portal.Host RotatedScreen mounts INSIDE the frame and is turned with it
// (at rotation 0). The edit row's colour swatch gets a frame-aware
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
  const { profiles, createProfile, updateProfile, deleteProfile } = useProfiles()
  // A deleted profile's saved deals and settings go with it.
  const handleDelete = (id: string) => {
    deleteProfile(id)
    forgetPlayerData(id)
  }

  return (
    <View style={styles.container}>
      <ProfilesScreen profiles={profiles} defaultColor={DEFAULT_SEED_COLOR} onCreate={(patch) => createProfile(patch)} onSave={(id, patch) => updateProfile(id, patch)} onDelete={handleDelete} onBack={safeBack} fg={CHROME_FG} bg='transparent' titleVariant='headlineSmall' useColorPickerAlign={useFrameAutoAlign} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 }
})
