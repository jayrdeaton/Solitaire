import { Button } from '@rific/feedback-press'
import { toRotationStyle, type ViewRotation } from '@tastic/core'
import { ScrollView, StyleSheet, View } from 'react-native'
import { Modal, Portal, Text, useTheme } from 'react-native-paper'

import { CARD_FONT_FAMILY } from './useFontsPreload'

interface RulesDialogProps {
  visible: boolean
  onDismiss: () => void
  title: string
  rules: string[]
  // Live physical-hold rotation (see @tastic/core's getViewRotation), same convention as
  // @tastic/hud's ConfirmDialog/BaseSettingsDialog - needed because this Portals out from under any
  // rotated ancestor (GameChrome's own withGameProviders/FakeLandscapeView wrapper included), so it
  // has no rotation of its own to inherit. Defaults to 0 for a caller with nothing to match.
  rotation?: ViewRotation
}

/** "How to play" sheet for a game - a plain bulleted rules list, reached from GameChrome's own
 * rules icon. Built directly on Paper's Modal/Portal (no existing @tastic/hud dialog fits:
 * BaseSettingsDialog is genuinely settings-specific, and ConfirmDialog's `message` is a single
 * string with no scroll area, not a bulleted list). */
export function RulesDialog({ visible, onDismiss, title, rules, rotation = 0 }: RulesDialogProps) {
  const { colors } = useTheme()

  return (
    <Portal>
      <Modal visible={visible} onDismiss={onDismiss} contentContainerStyle={[styles.container, { backgroundColor: colors.surface }, toRotationStyle(rotation)]}>
        <Text style={[styles.title, { color: colors.onSurface }]}>{title}</Text>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {rules.map((rule, i) => (
            <View key={i} style={styles.row}>
              <Text style={[styles.bullet, { color: colors.onSurfaceVariant }]}>{'•'}</Text>
              <Text style={[styles.ruleText, { color: colors.onSurfaceVariant }]}>{rule}</Text>
            </View>
          ))}
        </ScrollView>
        <Button mode='contained' onPress={onDismiss} style={styles.closeButton}>
          Got it
        </Button>
      </Modal>
    </Portal>
  )
}

const styles = StyleSheet.create({
  bullet: {
    fontSize: 15,
    lineHeight: 22,
    width: 16
  },
  closeButton: {
    alignSelf: 'center',
    marginTop: 16,
    width: 160
  },
  container: {
    borderRadius: 16,
    marginHorizontal: 24,
    maxHeight: '80%',
    padding: 24
  },
  row: {
    flexDirection: 'row',
    gap: 4,
    marginBottom: 10
  },
  ruleText: {
    flex: 1,
    fontFamily: CARD_FONT_FAMILY,
    fontSize: 15,
    lineHeight: 22
  },
  scroll: {
    flexGrow: 0
  },
  scrollContent: {
    paddingTop: 4
  },
  title: {
    fontFamily: CARD_FONT_FAMILY,
    fontSize: 22,
    fontWeight: '800',
    marginBottom: 12
  }
})
