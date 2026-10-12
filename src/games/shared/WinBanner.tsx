import { useAutoPaperTheme } from '@rific/auto-paper'
import { Button } from '@rific/feedback-press'
import { getOverlayCardColors, overlayActionStyles, overlayStyles } from '@tastic/hud'
import { StyleSheet, View } from 'react-native'
import { Icon, Text } from 'react-native-paper'

import { formatTime, GAME_DIALOG_Z_INDEX } from '@/components/GameChrome'

export interface WinBannerProps {
  elapsedSeconds: number
  moves: number
  score: number
  onNewGame: () => void
}

/** The post-win overlay, shared by every game: the fleet's overlay card (@tastic/hud's
 * overlayStyles/getOverlayCardColors, the shape ConfirmDialog and every other game's game-over
 * dialog use) with the score summary and a New Game button. Home is GameChrome's own corner button,
 * which is portaled above this backdrop so it stays live. */
export function WinBanner({ elapsedSeconds, moves, score, onNewGame }: WinBannerProps) {
  const { colors, dark } = useAutoPaperTheme()
  const { fg, fgMuted, cardBg, cardBorder } = getOverlayCardColors(dark)
  const stats = [
    { label: 'MOVES', value: String(moves) },
    { label: 'SCORE', value: String(score) },
    { label: 'TIME', value: formatTime(elapsedSeconds) }
  ]
  return (
    // The backdrop takes every touch, so nothing behind the dialog (the board, the footer) can be played.
    // GameChrome's Home and Settings stay live: they're portaled above this backdrop.
    <View style={[overlayStyles.overlay, styles.overlay]}>
      <View style={[overlayStyles.card, styles.card, { backgroundColor: cardBg, borderColor: cardBorder }]}>
        <Icon source='trophy' size={64} color={colors.primary} />
        <Text variant='headlineLarge' style={[styles.title, { color: colors.primary }]}>
          You Won!
        </Text>
        <View style={styles.statRow}>
          {stats.map(({ label, value }) => (
            <View key={label} style={styles.stat}>
              <Text variant='labelSmall' style={{ color: fgMuted }}>
                {label}
              </Text>
              <Text variant='headlineSmall' style={{ color: fg }}>
                {value}
              </Text>
            </View>
          ))}
        </View>
        <Text variant='bodySmall' style={[styles.caption, { color: fgMuted }]}>
          Lower is better. Fewer moves, less time.
        </Text>
        <View style={overlayActionStyles.actions}>
          <Button mode='contained' onPress={onNewGame} style={overlayActionStyles.actionButtonSingle} buttonColor={colors.primary} textColor={colors.onPrimary} testID='win-new-game'>
            New Game
          </Button>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  caption: {
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
  stat: {
    alignItems: 'center',
    gap: 2
  },
  statRow: {
    flexDirection: 'row',
    gap: 28
  },
  title: {
    fontWeight: 'bold',
    textAlign: 'center'
  }
})
