import { Pressable } from '@rific/feedback-press'
import { type TableColors } from '@tastic/cards'
import { useMemo } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { GAME_DIALOG_Z_INDEX } from '@/components/GameChrome'
import { CARD_FONT_FAMILY } from '@/components/useFontsPreload'

export interface LossBannerProps {
  colors: TableColors
  onNewGame: () => void
  /** Takes back the last move - the loss is often one bad draw or play away from a live board. Undo stays in the footer too,
   * but the scrim dims it. */
  onUndo?: () => void
}

/** The post-loss overlay for a game with a genuine, non-abandonment loss condition (see
 * games/shared/useStuckLossCheck.ts). Visual sibling of WinBanner.tsx, same overlay
 * shape and dimmed-scrim treatment, but no score/time/moves summary - a loss has none worth
 * showing. */
export function LossBanner({ colors, onNewGame, onUndo }: LossBannerProps) {
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    // box-none: see WinBanner's identical doc comment - only the centered card should ever catch
    // a tap, not the full-screen transparent area around it.
    <View style={styles.overlay} pointerEvents='box-none'>
      <View style={styles.card}>
        <Text style={styles.title}>No Moves Left</Text>
        <Text style={styles.subtitle}>This deal can&rsquo;t be won from here.</Text>
        <View style={styles.buttons}>
          {onUndo ? (
            <Pressable style={styles.button} onPress={onUndo} testID='loss-undo'>
              <Text style={styles.buttonText}>Undo</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.button} onPress={onNewGame} testID='loss-new-game'>
            <Text style={styles.buttonText}>New Game</Text>
          </Pressable>
        </View>
      </View>
    </View>
  )
}

function makeStyles(colors: TableColors) {
  return StyleSheet.create({
    button: {
      backgroundColor: '#ffffffee',
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 8
    },
    buttonText: {
      color: colors.tableFeltDark,
      fontFamily: CARD_FONT_FAMILY,
      fontWeight: '700'
    },
    buttons: {
      flexDirection: 'row',
      gap: 12
    },
    card: {
      alignItems: 'center',
      backgroundColor: '#ffffffee',
      borderRadius: 16,
      gap: 12,
      padding: 28
    },
    overlay: {
      alignItems: 'center',
      backgroundColor: '#00000088',
      bottom: 0,
      justifyContent: 'center',
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
      zIndex: GAME_DIALOG_Z_INDEX
    },
    subtitle: {
      color: '#444',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 16,
      marginBottom: 8
    },
    title: {
      color: colors.tableFeltDark,
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 28,
      fontWeight: '800'
    }
  })
}
