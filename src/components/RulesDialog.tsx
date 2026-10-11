import { Button } from '@rific/feedback-press'
import { useRotatedWindowDimensions } from '@tastic/core'
import { ScrollView, StyleSheet, View } from 'react-native'
import { Modal, Portal, Text, useTheme } from 'react-native-paper'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

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
  // The sheet's cap is a number, never a percentage. On iOS Paper's Surface splits its style over two
  // views, and maxHeight lands on the INNER one, so '80%' resolved against the outer view's
  // content-sized height: the outer white sheet came out 80% of the screen and the content was clipped
  // to 80% of THAT, leaving an empty band under the button. This is the size '80%' already gives on
  // web/Android: a share of Paper's Modal wrapper, the frame (the turned window, since the dialog
  // portals into the rotated frame's host) less the top/bottom insets Paper sets as its margins.
  const { height } = useRotatedWindowDimensions()
  const { top, bottom } = useSafeAreaInsets()
  const maxHeight = Math.max(0, height - top - bottom) * (compact ? COMPACT_MAX_HEIGHT_RATIO : MAX_HEIGHT_RATIO)

  return (
    <Portal>
      <Modal visible={visible} onDismiss={onDismiss} contentContainerStyle={[styles.container, compact && styles.containerCompact, { backgroundColor: colors.surface, maxHeight }]}>
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

const MAX_HEIGHT_RATIO = 0.8
const COMPACT_MAX_HEIGHT_RATIO = 0.94

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
    padding: 24
  },
  containerCompact: {
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
