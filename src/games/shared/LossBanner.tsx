import { useAutoPaperTheme } from '@rific/auto-paper'
import { Button } from '@rific/feedback-press'
import { getOverlayCardColors, overlayActionStyles, overlayStyles } from '@tastic/hud'
import { StyleSheet, View } from 'react-native'
import { Icon, Text } from 'react-native-paper'

import { GAME_DIALOG_Z_INDEX } from '@/components/GameChrome'

export interface LossBannerProps {
  onNewGame: () => void
  /** Takes back the last move. The loss is often one bad draw or play away from a live board. */
  onUndo?: () => void
}

/** The post-loss overlay for a game with a genuine, non-abandonment loss condition (see
 * games/shared/useStuckLossCheck.ts). Visual sibling of WinBanner.tsx, the same fleet overlay card,
 * but no score/time/moves summary - a loss has none worth showing. */
export function LossBanner({ onNewGame, onUndo }: LossBannerProps) {
  const { colors, dark } = useAutoPaperTheme()
  const { fg, fgMuted, cardBg, cardBorder } = getOverlayCardColors(dark)
  return (
    // The backdrop takes every touch, like WinBanner's: Undo is on the card, and Home/Settings are portaled above it.
    <View style={[overlayStyles.overlay, styles.overlay]}>
      <View style={[overlayStyles.card, styles.card, { backgroundColor: cardBg, borderColor: cardBorder }]}>
        <Icon source='cards-outline' size={64} color={fgMuted} />
        <Text variant='headlineLarge' style={[styles.title, { color: fg }]}>
          No Moves Left
        </Text>
        <Text variant='bodyLarge' style={[styles.body, { color: fg }]}>
          This deal can&rsquo;t be won from here.
        </Text>
        <View style={overlayActionStyles.actions}>
          {onUndo ? (
            <Button mode='outlined' onPress={onUndo} style={overlayActionStyles.actionButton} testID='loss-undo'>
              Undo
            </Button>
          ) : null}
          <Button mode='contained' onPress={onNewGame} style={onUndo ? overlayActionStyles.actionButton : overlayActionStyles.actionButtonSingle} buttonColor={colors.primary} textColor={colors.onPrimary} testID='loss-new-game'>
            New Game
          </Button>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  body: {
    textAlign: 'center'
  },
  // ConfirmDialog's own card/overlay additions: the card claims its full maxWidth, and the overlay
  // keeps it off the screen edges.
  card: {
    width: '100%'
  },
  overlay: {
    paddingHorizontal: 24,
    zIndex: GAME_DIALOG_Z_INDEX
  },
  title: {
    fontWeight: 'bold',
    textAlign: 'center'
  }
})
