import { IconButton } from '@rific/feedback-press'
import { ConfirmDialog, ContentGutter, CornerActionButtons } from '@tastic/hud'
import { useRouter } from 'expo-router'
import { ReactNode, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useLastActiveGame } from '@/stores/lastActiveGame'

import { SettingsDialog } from './SettingsDialog'
import { CHROME_FG, TableColors, useTableColors } from './theme'
import { CARD_FONT_FAMILY } from './useFontsPreload'

export function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** The horizontal padding GameChrome's own scroll content actually renders with (see `content`
 * below) - every game screen's own cardWidthForRow call must subtract this same value (not some
 * separately-hardcoded, possibly-drifted number of its own), or its tableau/row math ends up
 * sized for a different available width than the one it actually renders into. Confirmed live:
 * Spider previously used its own SCREEN_PADDING (8) plus a now-redundant paddingHorizontal on its
 * own tableauRow (8 more), while this component was already contributing 12 - three
 * independently-chosen numbers for what has to be one true value, and the mismatch ran a 10-column
 * board off the right edge of the screen. */
export const GAME_CONTENT_PADDING = 12

/** Upper bound on the board's own content width on a wide desktop/web window - past this, the
 * leftover horizontal space becomes empty, symmetric gutters (see `ContentGutter` below) instead
 * of the board stretching or drifting off-center. Sized to Spider's own widest natural case: at
 * `cardWidthForRow`'s own 96px/card max, Spider's 10-column tableau renders at
 * 96*10 + TABLEAU_GAP(4)*9 = 996px, plus this same GAME_CONTENT_PADDING on both sides = 1020px of
 * content width before Spider's own cards stop growing regardless of how much wider the window
 * gets - 1040 leaves a small margin past that exact point so the cap never kicks in before
 * Spider's own natural saturation, while still meaningfully capping well short of an ultrawide
 * monitor. Every game screen's own `cardWidthForRow` call must run its raw window width through
 * `computeContentBounds(winWidth, GAME_CONTENT_MAX_WIDTH)` first - same as GAME_CONTENT_PADDING
 * above, one true shared value, not a per-game guess. */
export const GAME_CONTENT_MAX_WIDTH = 1040

interface GameChromeProps {
  /** Shown top-center, in the band New Game/Undo/Settings share - which game (and, where a game
   * has one, which variant: Klondike's draw count, Spider's suit count) is currently in play. */
  title: string
  /** Deals a fresh game - already confirmed if confirmation was needed (see the New Game button
   * below), so callers can unconditionally treat any call to this as "the player committed to a
   * new deal" (e.g. for recording an abandoned-deal loss). */
  onNewGame: () => void
  onUndo: () => void
  undoDisabled: boolean
  /** Whether the current deal has had any real player moves - gates the New Game confirm dialog
   * below. Deliberately NOT the same thing as `!undoDisabled`: a resumed deal (see
   * stores/gameInProgress.ts) always restores with an empty undo stack (undo history isn't
   * persisted) even though it may have real progress, so `undoDisabled` alone would wrongly skip
   * the warning - and wrongly skip recording the abandon - for any resumed, in-progress game. */
  hasProgress: boolean
  elapsedSeconds: number
  movesCount: number
  /** Game-specific settings section (Klondike draw count, Spider suit count, ...), rendered above
   * the global Solitaire settings inside the shared dialog. Omitted by FreeCell/Pyramid, which
   * have no game-specific settings. */
  settingsContent?: ReactNode
  /** The game board itself - foundations/tableau/stock, whatever shape a given game needs. Scrolls
   * if it doesn't fit (Pyramid's triangle + stock row can exceed a short viewport). */
  children: ReactNode
}

/** Shared top/bottom chrome for every game screen. Left corner: Back paired with a title showing
 * which game (and variant, where one exists) is in play, like a standard nav-bar back+title pair.
 * Right corner: Settings, with New Game and Undo clustered just inside it - both are game controls
 * (one resets play, the other reverses the last move) reached for far less often than anything
 * mid-board, so neither needs a labeled pill, and grouping them with Settings keeps every
 * "affects the game, not the board" action in one place. The elapsed timer sits at the bottom
 * edge, out of the way of the board and everything up top.
 *
 * Previously each of the four game screens hand-rolled its own version of this row (and Pyramid's
 * had drifted to a bottom button row entirely) - unifying it here means a layout tweak (like this
 * one, and the left/right regrouping that followed it) only has to happen once. */
export function GameChrome({ title, onNewGame, onUndo, undoDisabled, hasProgress, elapsedSeconds, movesCount, settingsContent, children }: GameChromeProps) {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const colors = useTableColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [confirmNewGameVisible, setConfirmNewGameVisible] = useState(false)
  const { clearLastActiveGame } = useLastActiveGame()

  return (
    <View style={styles.screen}>
      <ContentGutter maxContentWidth={GAME_CONTENT_MAX_WIDTH} style={styles.gutterRow}>
        <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, { paddingTop: 56 + insets.top, paddingBottom: 48 + insets.bottom }]}>
          {children}
        </ScrollView>
      </ContentGutter>

      {/* Paired with the reserved Back button on the left, like a standard nav-bar title - New
      Game joins Undo and Settings on the right instead, since it's a game control (resets play)
      in the same category as those two, not a navigation/label element like Back/the title. */}
      <View style={[styles.titleWrap, { top: 14 + insets.top, left: 60 + insets.left, right: 140 + insets.right }]} pointerEvents='none'>
        <Text style={styles.titleText} numberOfLines={1}>
          {title}
        </Text>
      </View>

      <IconButton icon='undo' iconColor={CHROME_FG} size={24} disabled={undoDisabled} style={[styles.cornerAdjacentButton, { top: 8 + insets.top, right: 96 + insets.right }]} onPress={onUndo} accessibilityLabel='Undo' />

      <IconButton
        icon='cards-playing-outline'
        iconColor={CHROME_FG}
        size={24}
        style={[styles.cornerAdjacentButton, { top: 8 + insets.top, right: 52 + insets.right }]}
        onPress={() => {
          // Nothing to lose yet - deal immediately, no warning. Otherwise, dealing a new game
          // abandons the one in progress (counted as a loss - see stores/gameStats.tsx), so confirm
          // first rather than losing the player's board to a stray tap - see the ConfirmDialog
          // below, which owns the actual prompt.
          if (!hasProgress) {
            onNewGame()
            return
          }
          setConfirmNewGameVisible(true)
        }}
        accessibilityLabel='New Game'
      />

      <View style={styles.cornerButtons}>
        <CornerActionButtons
          onBack={() => {
            // Cleared explicitly on the tap itself, not left to each screen's own unmount cleanup:
            // on web, React Navigation's Stack keeps the previous screen mounted (hidden, not
            // unmounted) across a pop (same quirk this app's own ProfilesManager integration hit -
            // see .claude/CLAUDE.md), so an unmount-based clear never fires there, and app/index.tsx
            // would see a stale lastActiveGame and immediately redirect right back into this game.
            clearLastActiveGame()
            // Every game screen is one level below the main menu with nothing deeper, so this is
            // always "go home," not "undo the last navigation" - router.back() depended on real
            // history existing (it errors with "GO_BACK was not handled" whenever this screen was
            // reached directly, e.g. a deep link, a dev reload straight into /klondike, or the
            // cold-launch redirect in app/index.tsx). replace() ignores history entirely and always
            // lands on the menu, and - unlike push() - doesn't grow the stack on repeated round trips.
            router.replace('/')
          }}
          onSettings={() => setSettingsOpen(true)}
          fg={CHROME_FG}
          insets={insets}
          backIcon='home'
          backLabel='Home'
        />
      </View>

      <View style={[styles.timerWrap, { bottom: 8 + insets.bottom }]} pointerEvents='none'>
        <Text style={styles.timerText}>
          {movesCount} · {formatTime(elapsedSeconds)}
        </Text>
      </View>

      <SettingsDialog visible={settingsOpen} onDismiss={() => setSettingsOpen(false)}>
        {settingsContent}
      </SettingsDialog>

      <ConfirmDialog
        visible={confirmNewGameVisible}
        title='Start a new game?'
        message='This game is still in progress — starting a new one will count it as a loss.'
        confirmLabel='New Game'
        cancelLabel='Cancel'
        icon='alert-circle-outline'
        onConfirm={() => {
          setConfirmNewGameVisible(false)
          onNewGame()
        }}
        onCancel={() => setConfirmNewGameVisible(false)}
      />
    </View>
  )
}

function makeStyles(colors: TableColors) {
  return StyleSheet.create({
    screen: {
      backgroundColor: colors.tableFelt,
      flex: 1
    },
    // ContentGutter's own row needs this to consume `screen`'s full remaining height - the same
    // flex:1 that used to govern the ScrollView directly against `screen`, one level further in -
    // so its two gutters (and anything a game optionally renders into them) run the full vertical
    // extent of the play area, not just as tall as the board happens to be.
    gutterRow: {
      flex: 1
    },
    // Without an explicit style here (contentContainerStyle alone isn't enough), a vertical
    // ScrollView's cross-axis (width) sizes to its content instead of its parent - harmless for
    // content narrower than the screen, but a wider board (Spider's 10 columns) just grows the
    // whole page instead of being constrained and clipped/scrollable within the viewport.
    scroll: {
      flex: 1
    },
    content: {
      paddingHorizontal: GAME_CONTENT_PADDING,
      // Centers any top-level child narrower than the available content width (e.g. a board once
      // genuinely narrower than GAME_CONTENT_MAX_WIDTH's own cap) instead of leaving it
      // default-stretched full-width and therefore left-anchored.
      alignItems: 'center'
    },
    // The title wrap, the two corner-adjacent icon buttons, and the corner buttons themselves are
    // all absolutely positioned siblings of the scrolling content - on web, a later positioned
    // sibling wins pointer-event hit-testing over an earlier one by DOM order alone unless
    // elevated explicitly (see PileView's identical stacking-context note), so every chrome layer
    // needs its own zIndex to reliably sit above the board and receive taps regardless of source
    // order.
    titleWrap: {
      position: 'absolute',
      // Fixed height matching IconButton's own 40px touchable (see cornerAdjacentButton), centered
      // via justifyContent rather than left to this text's natural line-height, so it lines up
      // with the icon row exactly instead of hugging the top of the same nominal offset.
      height: 40,
      justifyContent: 'center',
      // Left-aligned (hugging the Back button, like a standard nav-bar title), not centered in
      // its own left/right band - that band is sized to clear the right-side icon cluster, which
      // isn't the same as being centered on the screen.
      alignItems: 'flex-start',
      zIndex: 10
    },
    titleText: {
      color: '#fff',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 16,
      fontWeight: '700'
    },
    // Shared by the New Game and Undo icon buttons - both cluster to the left of Settings, in
    // reach-for-it-occasionally order (New Game furthest out, Undo closest), with Back and the
    // title occupying the opposite corner as a navigation pair instead.
    cornerAdjacentButton: {
      position: 'absolute',
      zIndex: 10
    },
    cornerButtons: {
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
      zIndex: 10
    },
    timerWrap: {
      alignItems: 'center',
      left: 0,
      position: 'absolute',
      right: 0,
      zIndex: 10
    },
    timerText: {
      color: '#fff',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 16,
      fontVariant: ['tabular-nums']
    }
  })
}
