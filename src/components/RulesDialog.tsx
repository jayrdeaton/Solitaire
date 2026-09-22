import { Button } from '@rific/feedback-press'
import { ScrollView, StyleSheet, View } from 'react-native'
import { Modal, Portal, Text, useTheme } from 'react-native-paper'

import { CARD_FONT_FAMILY } from './useFontsPreload'

interface RulesDialogProps {
  visible: boolean
  onDismiss: () => void
  title: string
  rules: string[]
  // The wide (landscape) layout: the sheet is only ~400pt tall there, so it trades some padding and
  // margin for reading room (the portrait sizing left a ~50pt scroll area, about two bullets). Both the game
  // screens and the menu pass it when their rotated footprint is landscape.
  compact?: boolean
}

/** "How to play" sheet for a game - a plain bulleted rules list, reached from GameChrome's own
 * rules icon. Built directly on Paper's Modal/Portal (no existing @tastic/hud dialog fits:
 * BaseSettingsDialog is genuinely settings-specific, and ConfirmDialog's `message` is a single
 * string with no scroll area, not a bulleted list). */
export function RulesDialog({ visible, onDismiss, title, rules, compact = false }: RulesDialogProps) {
  const { colors } = useTheme()

  return (
    <Portal>
      <Modal visible={visible} onDismiss={onDismiss} contentContainerStyle={[styles.container, compact && styles.containerCompact, { backgroundColor: colors.surface }]}>
        <Text style={[styles.title, { color: colors.onSurface }]}>{title}</Text>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {rules.map((rule, i) => (
            <View key={i} style={styles.row}>
              <Text style={[styles.bullet, { color: colors.onSurfaceVariant }]}>{'•'}</Text>
              <Text style={[styles.ruleText, { color: colors.onSurfaceVariant }]}>{rule}</Text>
            </View>
          ))}
          {/* One shared section rather than a per-game rules.ts bullet - the formula (see
          engine/score.ts) is identical across every game, so duplicating this sentence into all
          11 games' constants/gameRules.ts entries would just be 11 copies to keep in sync. */}
          <Text style={[styles.scoreHeading, { color: colors.onSurface }]}>Scoring</Text>
          <Text style={[styles.scoreText, { color: colors.onSurfaceVariant }]}>Score is moves + seconds elapsed, so lower is better - a fast, efficient win scores low.</Text>
        </ScrollView>
        <Button mode='contained' onPress={onDismiss} style={[styles.closeButton, compact && styles.closeButtonCompact]}>
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
  closeButtonCompact: {
    marginTop: 8
  },
  container: {
    borderRadius: 16,
    marginHorizontal: 24,
    maxHeight: '80%',
    padding: 24
  },
  containerCompact: {
    maxHeight: '94%',
    padding: 16
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
  scoreHeading: {
    fontFamily: CARD_FONT_FAMILY,
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 6,
    marginTop: 8
  },
  scoreText: {
    fontFamily: CARD_FONT_FAMILY,
    fontSize: 14,
    lineHeight: 20
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
