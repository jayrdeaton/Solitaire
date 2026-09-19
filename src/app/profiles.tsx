import { ProfilesScreen } from '@tastic/profile'
import { StyleSheet, View } from 'react-native'
import { useTheme } from 'react-native-paper'

import { TableBackground } from '@/components/TableBackground'
import { CHROME_FG, DEFAULT_SEED_COLOR, previewCardBack, useTableColors } from '@/components/theme'
import { useProfiles } from '@/stores/profiles'
import { safeBack } from '@/utils/navigation'

// @tastic/profile's ProfilesScreen now owns the header row, back button, and
// managerRef/commitPendingEdit-before-navigate composition internally (see that component's own
// doc comment - it folds in the exact escape hatch this file used to hand-roll for expo-router's
// web renderer keeping a popped screen mounted-but-hidden instead of unmounting it, per this
// repo's own CLAUDE.md finding). This wrapper only supplies the felt background - ProfilesScreen
// owns its own opaque bg with no background-slot prop, so bg='transparent' lets TableBackground
// show through underneath, same as achievements.tsx's BaseStatsScreen usage. fg/cardBg/
// titleVariant/colorPreview mirror the same overrides the old ProfilesManager call passed
// directly - same chrome palette, same headlineSmall title size, instead of ProfilesScreen's own
// literal-black/white default and oversized displaySmall.
export default function Profiles() {
  const { dark } = useTheme()
  const colors = useTableColors()
  const { profiles, createProfile, updateProfile, deleteProfile } = useProfiles()

  return (
    <View style={styles.container}>
      <TableBackground />
      <ProfilesScreen profiles={profiles} defaultColor={DEFAULT_SEED_COLOR} onCreate={(patch) => createProfile(patch)} onSave={(id, patch) => updateProfile(id, patch)} onDelete={(id) => deleteProfile(id)} onBack={safeBack} fg={CHROME_FG} bg='transparent' cardBg={colors.tableFeltDark} titleVariant='headlineSmall' colorPreview={(hex) => previewCardBack(hex, dark)} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 }
})
