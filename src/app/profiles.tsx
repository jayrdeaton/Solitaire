import { IconButton } from '@rific/feedback-press'
import { ProfilesManager, ProfilesManagerHandle } from '@tastic/profile'
import { useRouter } from 'expo-router'
import { useRef } from 'react'
import { StyleSheet, View } from 'react-native'
import { useTheme } from 'react-native-paper'

import { CHROME_FG, DEFAULT_SEED_COLOR, previewCardBack, useTableColors } from '@/components/theme'
import { useProfiles } from '@/stores/profiles'

// ProfilesManager renders its own internal header row (see _layout.tsx's headerShown: false for
// this route), so this wrapper only supplies the felt background and a back button. fg/cardBg/
// titleVariant mirror achievements.tsx's identical BaseStatsScreen overrides - same chrome
// palette, same headlineSmall title size, instead of ProfilesManager's own literal-black/white
// default and oversized displaySmall.
export default function ProfilesScreen() {
  const router = useRouter()
  const { dark } = useTheme()
  const colors = useTableColors()
  const { profiles, createProfile, updateProfile, deleteProfile } = useProfiles()
  // expo-router's web renderer keeps a popped screen mounted-but-hidden instead of unmounting it,
  // so ProfilesManager's own unmount-flush fallback never fires here on back — this ref + explicit
  // commitPendingEdit() call is the documented escape hatch for exactly that host (see
  // ProfilesManagerHandle's own doc in @tastic/profile). Without it, a name typed but not yet
  // submitted via the keyboard's Return/Done key is silently discarded on back — see this repo's own
  // CLAUDE.md, which independently documents having hit exactly this.
  const managerRef = useRef<ProfilesManagerHandle>(null)

  const handleBack = () => {
    managerRef.current?.commitPendingEdit()
    router.back()
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.tableFelt }]}>
      <ProfilesManager ref={managerRef} profiles={profiles} defaultColor={DEFAULT_SEED_COLOR} onCreate={(patch) => createProfile(patch)} onSave={(id, patch) => updateProfile(id, patch)} onDelete={(id) => deleteProfile(id)} headerLeft={<IconButton icon='arrow-left' iconColor='#fff' size={24} onPress={handleBack} accessibilityLabel='Back' />} fg={CHROME_FG} cardBg={colors.tableFeltDark} titleVariant='headlineSmall' colorPreview={(hex) => previewCardBack(hex, dark)} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 }
})
