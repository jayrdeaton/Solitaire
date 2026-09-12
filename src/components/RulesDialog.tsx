import { Button } from '@rific/feedback-press'
import { ScrollView, StyleSheet, View } from 'react-native'
import { Modal, Portal, Text, useTheme } from 'react-native-paper'

import { CARD_FONT_FAMILY } from './useFontsPreload'

interface RulesDialogProps {
  visible: boolean
  onDismiss: () => void
  title: string
  rules: string[]
}

/** "How to play" sheet for a game - a plain bulleted rules list, reached from GameChrome's own
 * rules icon. Built directly on Paper's Modal/Portal (no existing @tastic/hud dialog fits:
 * BaseSettingsDialog is genuinely settings-specific, and ConfirmDialog's `message` is a single
 * string with no scroll area, not a bulleted list). */
export function RulesDialog({ visible, onDismiss, title, rules }: RulesDialogProps) {
  const { colors } = useTheme()

  return (
    <Portal>
      <Modal visible={visible} onDismiss={onDismiss} contentContainerStyle={[styles.container, { backgroundColor: colors.surface }]}>
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
