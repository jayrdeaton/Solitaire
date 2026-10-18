import { useAutoPaperTheme } from '@rific/auto-paper'
import { Button } from '@rific/feedback-press'
import { DialogHeader, overlayActionStyles, OverlayBackdrop, OverlayCard, useCompactDialog, useOverlayCardColors } from '@tastic/hud/chrome'
import { StyleSheet, View } from 'react-native'
import { Text } from 'react-native-paper'

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
  const { colors } = useAutoPaperTheme()
  const { fg } = useOverlayCardColors()
  const { compact, onLayout } = useCompactDialog()
  return (
    // The backdrop takes every touch, like WinBanner's: Undo is on the card, and Home/Settings are portaled above it.
    <OverlayBackdrop style={styles.overlay} onLayout={onLayout}>
      <OverlayCard style={styles.card}>
        {/* The theme's primary like every other dialog's header (it used to be the muted ink, a
          deliberate "not a celebration"; Jay, 2026-10-15, wants one header everywhere). */}
        <DialogHeader icon='cards-outline' title='No Moves Left' compact={compact} />
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
      </OverlayCard>
    </OverlayBackdrop>
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
  }
})
