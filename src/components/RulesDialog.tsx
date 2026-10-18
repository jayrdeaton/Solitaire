import { FadingScrollView, useAutoPaperTheme } from '@rific/auto-paper'
import { Button } from '@rific/feedback-press'
import { rotateInsets, useRotatedWindowDimensions, useRotation } from '@tastic/core'
import { DialogHeader, overlayActionStyles, OverlayBackdrop, OverlayCard, useCompactDialog } from '@tastic/hud/chrome'
import { useEffect } from 'react'
import { BackHandler, Pressable, StyleSheet, View } from 'react-native'
import { Portal, Text } from 'react-native-paper'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import type { Par } from '@/engine/par'

import { CARD_FONT_FAMILY } from './useFontsPreload'

interface RulesDialogProps {
  visible: boolean
  onDismiss: () => void
  title: string
  rules: string[]
  /** In a game: its variant's expert par, told after the medals. Home's sheet has no deal, so no par. */
  par?: Par
}

/** "How to play" sheet for a game - a bulleted rules list, reached from GameChrome's info button and
 * each Home tile's. Built from the fleet's dialog parts (@tastic/hud's OverlayBackdrop/OverlayCard,
 * DialogHeader and the single-button action row), so it matches the Settings sheet, the New Game
 * confirm and the win/loss cards (Jay, 2026-10-15: "I value consistency above all else"). It used to
 * be a Paper Modal with its own plain dark title and a 160pt "Got it" button. ConfirmDialog itself
 * doesn't fit: its `message` is one centered paragraph with no scroll area. Like the Settings sheet
 * (and unlike a confirm), a tap outside the card or Android's back button closes it. */
export function RulesDialog({ visible, onDismiss, title, rules, par }: RulesDialogProps) {
  const { colors } = useAutoPaperTheme()
  const { compact, onLayout } = useCompactDialog()
  // The card's cap is a number, never a percentage: the space the dialog lays out in (the rotated
  // frame, since it portals into the frame's host) less the frame's own safe-area edges and the
  // backdrop's 24pt gutter on each side, so a long list scrolls inside the card instead of running
  // off the screen. The insets come in portrait and are turned onto the frame's edges here: held
  // sideways, the notch is on a side of the turned frame, not its top.
  const { height } = useRotatedWindowDimensions()
  const insets = rotateInsets(useSafeAreaInsets(), useRotation())
  const maxHeight = Math.max(0, height - insets.top - insets.bottom - OVERLAY_GUTTER * 2)

  useEffect(() => {
    if (!visible) return undefined
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onDismiss()
      return true
    })
    return () => subscription.remove()
  }, [visible, onDismiss])

  if (!visible) return null

  return (
    <Portal>
      <OverlayBackdrop style={styles.overlay} onLayout={onLayout}>
        <Pressable accessibilityLabel='Close rules' accessibilityRole='button' onPress={onDismiss} style={StyleSheet.absoluteFill} />
        <OverlayCard accessibilityViewIsModal style={[styles.card, { maxHeight }]}>
          {/* The header scrolls away with the rules, as on the Settings sheet, so a long list gets the
            whole card once scrolled; Done stays pinned below, and the rules fade out above it while
            there is more to read (auto-paper's FadingScrollView, the Settings sheet's too). */}
          <FadingScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} testID='rules-scroll'>
            <DialogHeader icon='information-outline' title={title} compact={compact} />
            <View>
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
              <Text style={[styles.scoreText, { color: colors.onSurfaceVariant }]}>Score is moves plus seconds, and lower is better. The clock starts with your first move and pauses while you&rsquo;re away from the game or in Settings or Rules. Every move counts, even one you undo or one the game plays for you. Every win earns a medal: bronze, silver for beating your par (the middle score of your last 20 wins here), or gold for a win in your best fifth of them.{par ? ` Expert par, a strong win under these rules, is ${par.score}: ${par.moves} moves in ${formatParTime(par.seconds)}. It is your par until your first win here, and what the achievements measure.` : ''}</Text>
            </View>
          </FadingScrollView>
          <View style={overlayActionStyles.actions}>
            <Button mode='contained' onPress={onDismiss} style={overlayActionStyles.actionButtonSingle} buttonColor={colors.primary} textColor={colors.onPrimary} testID='rules-done'>
              Done
            </Button>
          </View>
        </OverlayCard>
      </OverlayBackdrop>
    </Portal>
  )
}

// The backdrop's side gutter, as on ConfirmDialog and the win/loss cards.
const OVERLAY_GUTTER = 24

// m:ss, as the game's own readout shows time (GameChrome's formatTime, which this file can't import: GameChrome imports it).
function formatParTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const styles = StyleSheet.create({
  bullet: {
    fontSize: 15,
    lineHeight: 22,
    width: 16
  },
  // ConfirmDialog's own card addition: the card claims its full maxWidth instead of shrinking to its
  // content. The scroll area runs to the card's top edge (its content carries the 24pt inset), and
  // meets the Done row with no gap of its own, like the Settings sheet's.
  card: {
    gap: 0,
    paddingTop: 0,
    width: '100%'
  },
  overlay: {
    paddingHorizontal: OVERLAY_GUTTER
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
  // The card centers its children; the list takes the card's full width and shrinks (scrolling) when
  // the card reaches its maxHeight.
  scroll: {
    alignSelf: 'stretch',
    flexGrow: 0,
    flexShrink: 1
  },
  // The header and the rules scroll together: the card's 24pt inset above the header, the overlay
  // cards' 16pt gap below it, and 16pt below the last line before the Done row.
  scrollContent: {
    gap: 16,
    paddingBottom: 16,
    paddingTop: 24
  }
})
