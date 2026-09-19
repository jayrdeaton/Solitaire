import { Pressable } from '@rific/feedback-press'
import { type TableColors } from '@tastic/cards'
import { useMemo } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { formatTime, GAME_DIALOG_Z_INDEX } from '@/components/GameChrome'
import { CARD_FONT_FAMILY } from '@/components/useFontsPreload'

export interface WinBannerProps {
  colors: TableColors
  elapsedSeconds: number
  moves: number
  score: number
  onNewGame: () => void
}

/** The post-win overlay: a centered card with a score summary and a New Game button, dimming the
 * board behind it. Shared by every game. */
export function WinBanner({ colors, elapsedSeconds, moves, score, onNewGame }: WinBannerProps) {
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    // box-none (not the default 'auto'): this View covers the full screen, but only its centered
    // winCard content should ever catch a tap - left uncorrected, the transparent surrounding area
    // silently swallows every touch across the whole screen, including GameChrome's header buttons
    // underneath it (Home/Undo/Settings), since this renders as a later sibling of GameChrome and
    // therefore wins pointer-event hit-testing by plain sibling order.
    <View style={styles.winOverlay} pointerEvents='box-none'>
      <View style={styles.winCard}>
        <Text style={styles.winTitle}>You Won!</Text>
        <Text style={styles.winSubtitle}>
          Moves: {moves} · Score: {score} · Time: {formatTime(elapsedSeconds)}
        </Text>
        <Text style={styles.winCaption}>Lower is better — fewer moves and less time.</Text>
        <Pressable style={styles.button} onPress={onNewGame}>
          <Text style={styles.buttonText}>New Game</Text>
        </Pressable>
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
    winCaption: {
      color: '#777',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 12,
      marginBottom: 8
    },
    winCard: {
      alignItems: 'center',
      backgroundColor: '#ffffffee',
      borderRadius: 16,
      gap: 12,
      padding: 28
    },
    winOverlay: {
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
    winSubtitle: {
      color: '#444',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 16
    },
    winTitle: {
      color: colors.tableFeltDark,
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 28,
      fontWeight: '800'
    }
  })
}
