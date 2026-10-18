import { useAutoPaperTheme } from '@rific/auto-paper'
import { Button } from '@rific/feedback-press'
import { overlayActionStyles, OverlayBackdrop, OverlayCard, useCompactDialog, useOverlayCardColors } from '@tastic/hud/chrome'
import { StyleSheet, View } from 'react-native'
import { Text } from 'react-native-paper'

import { formatTime, GAME_DIALOG_Z_INDEX } from '@/components/GameChrome'
import { describeVsPar, playerParFor, playerParMedal } from '@/engine/par'
import type { VariantId } from '@/engine/variants'
import { useGameStats } from '@/stores/gameStats'

import { MedalHeader } from './MedalHeader'

export interface WinBannerProps {
  elapsedSeconds: number
  moves: number
  score: number
  /** The deal's variant: the win is measured against the player's par in it (engine/par.ts' playerParFor). */
  variant: VariantId
  onNewGame: () => void
}

/** The post-win overlay, shared by every game: the fleet's overlay card (@tastic/hud's
 * OverlayBackdrop/OverlayCard, the card ConfirmDialog and every other game's game-over dialog use) with the score summary, each number over its par, and a New Game button. Home is GameChrome's own corner button,
 * which is portaled above this backdrop so it stays live. */
export function WinBanner({ elapsedSeconds, moves, score, variant, onNewGame }: WinBannerProps) {
  const { colors } = useAutoPaperTheme()
  const { fg, fgMuted } = useOverlayCardColors()
  const { compact, onLayout } = useCompactDialog()
  // The player's par as it stood just before this win (useGameStats' lastWin: their recent wins hold this one by now),
  // or expert par if none was taken for this variant. The shown numbers are judged against it, not the recorded ones, so
  // a win reached again after an Undo (recorded once, at the first) still gets the medal its own score earns.
  const { lastWin } = useGameStats()
  const par = lastWin?.variant === variant ? lastWin.par : playerParFor(variant, [])
  const stats = [
    { label: 'MOVES', value: String(moves), par: String(par.moves) },
    { label: 'SCORE', value: String(score), par: String(par.score) },
    { label: 'TIME', value: formatTime(elapsedSeconds), par: formatTime(par.seconds) }
  ]
  const vsPar = describeVsPar(score, par.score, par.kind === 'personal' ? 'your par' : 'expert par')
  return (
    // The backdrop takes every touch, so nothing behind the dialog (the board, the footer) can be played.
    // GameChrome's Home and Settings stay live: they're portaled above this backdrop.
    <OverlayBackdrop style={styles.overlay} onLayout={onLayout}>
      <OverlayCard style={styles.card}>
        {/* The trophy and "You Won!" in the metal of the medal the score earned against the player's par (playerParMedal). */}
        <MedalHeader medal={playerParMedal(score, par)} title='You Won!' compact={compact} />
        <View style={styles.statRow}>
          {stats.map(({ label, value, par: parValue }) => (
            <View key={label} style={styles.stat}>
              <Text variant='labelSmall' style={{ color: fgMuted }}>
                {label}
              </Text>
              <Text variant='headlineSmall' style={{ color: fg }}>
                {value}
              </Text>
              <Text variant='labelSmall' style={{ color: fgMuted }}>
                Par {parValue}
              </Text>
            </View>
          ))}
        </View>
        <Text variant='bodySmall' style={[styles.caption, { color: fgMuted }]}>
          {/* Names the score (the percentage is the score's alone; moves and time show their own par above), with no "Lower is
          better" (par already says so) and no period: one phrase, not a sentence (Jay, 2026-10-17). */}
          Score {vsPar}
        </Text>
        <View style={overlayActionStyles.actions}>
          <Button mode='contained' onPress={onNewGame} style={overlayActionStyles.actionButtonSingle} buttonColor={colors.primary} textColor={colors.onPrimary} testID='win-new-game'>
            New Game
          </Button>
        </View>
      </OverlayCard>
    </OverlayBackdrop>
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
  }
})
