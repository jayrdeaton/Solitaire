import { IconButton, Pressable, useHoldToRepeat } from '@rific/feedback-press'
import { type TableColors } from '@tastic/cards'
import { ConfirmDialog, ContentGutter, CornerActionButtons } from '@tastic/hud'
import { useRouter } from 'expo-router'
import { ReactNode, useEffect, useMemo, useState } from 'react'
import { Pressable as RNPressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useLastActiveGame } from '@/stores/lastActiveGame'

import { RulesDialog } from './RulesDialog'
import { SettingsDialog } from './SettingsDialog'
import { CHROME_FG, useTableColors } from './theme'
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
 * 96*10 + CARD_GAP_MIN(6)*9 = 1014px, plus this same GAME_CONTENT_PADDING on both sides = 1038px of
 * content width before Spider's own cards stop growing regardless of how much wider the window
 * gets - past that point cardLayoutForRow's own gap-growing behavior (see cardLayout.ts) takes over
 * instead of leaving dead space, so 1040 doesn't need much margin past that exact saturation point
 * the way a hard cliff would have; it's still meaningfully capping well short of an ultrawide
 * monitor. Every game screen's own `cardLayoutForRow` call must run its raw window width through
 * `computeContentBounds(winWidth, GAME_CONTENT_MAX_WIDTH)` first - same as GAME_CONTENT_PADDING
 * above, one true shared value, not a per-game guess. */
export const GAME_CONTENT_MAX_WIDTH = 1040

/** The ScrollView's own top/bottom content padding (see `contentContainerStyle` below), i.e. how
 * much vertical space the title/corner-icon band and the timer band each reserve above/below the
 * scrolling board content - on top of `insets.top`/`insets.bottom`, which these two are combined
 * with inline rather than baked in here. Exported so a game screen's own tableau-height budget
 * (useTableauMaxHeight) can subtract the exact same two numbers this component actually renders
 * with, instead of guessing at them independently. */
export const GAME_CONTENT_TOP_PADDING = 56
// 8 (footer's own bottom offset) + 40 (an IconButton's touch size, size=24 + 2*8 padding) + 8 (gap
// up to the moves/timer row sitting right above it) + ~20 (that row's own text line) + 12 of actual
// breathing room above that, so the last row of board content doesn't sit flush against either row.
export const GAME_CONTENT_BOTTOM_PADDING = 88

// Press-and-hold-to-repeat undo (see the IconButton below) - matches the delayLongPress/repeat-tick
// convention @rific/feedback-press's own useHoldToRepeat is already used with elsewhere (Swirlio's
// hold-to-repeat FABs). UNDO_HOLD_REPEAT_MS is tuned to this app's own measured ~150-300ms undo-
// flight settle time (see dragSpring.ts/dealSpring.ts) - each game's own handleUndo guards itself
// against being re-entered before that settle completes, so a tick that lands mid-animation is
// simply dropped rather than desyncing anything.
const UNDO_LONG_PRESS_MS = 400
const UNDO_HOLD_REPEAT_MS = 250

// Vertical rhythm shared by the footer and the moves/timer row that sits just above it - single
// source for both their JSX bottom offsets and how far the moves/timer row slides down to fill the
// footer's own spot once it's hidden (see toggleFooter's movesTimerTranslateY).
const FOOTER_BOTTOM = 8
const MOVES_TIMER_BOTTOM = 56

interface GameChromeProps {
  /** Shown top-left, next to Back - which game is currently in play. */
  title: string
  /** The active variant (Klondike's draw count, Spider's suit count), shown as a small muted
   * caption under `title` rather than crammed onto the same line - `${title} · ${variant}` used to
   * be one numberOfLines={1} string, which read as clutter and crowded the info icon on narrower
   * screens. Omitted by every screen with nothing variant-shaped to show. */
  subtitle?: string
  /** Deals a fresh game - already confirmed if confirmation was needed (see the New Game button
   * below), so callers can unconditionally treat any call to this as "the player committed to a
   * new deal" (e.g. for recording an abandoned-deal loss). */
  onNewGame: () => void
  onUndo: () => void
  undoDisabled: boolean
  /** Highlights a legal move (or suggests a stock draw) somewhere on the board - see
   * engine/hint.ts's findHint, which every screen calls this from. */
  onHint: () => void
  /** True once the deal is won - a hint has nothing left to suggest. */
  hintDisabled?: boolean
  /** Whether the current deal has had any real player moves - gates the New Game confirm dialog
   * below. Deliberately NOT the same thing as `!undoDisabled`: a resumed deal (see
   * stores/gameInProgress.ts) always restores with an empty undo stack (undo history isn't
   * persisted) even though it may have real progress, so `undoDisabled` alone would wrongly skip
   * the warning - and wrongly skip recording the abandon - for any resumed, in-progress game. */
  hasProgress: boolean
  /** Live elapsed seconds, read on demand rather than passed as an ever-changing number - see
   * useGameSession's getElapsed doc comment. GameChrome owns its own once-a-second re-render for
   * the timer text below (while `clockRunning`) so re-rendering the rest of the screen - the whole
   * board - once a second isn't the price of a ticking clock display anymore. */
  getElapsedSeconds: () => number
  /** Whether the clock is actively counting up (session.started && !won) - gates GameChrome's own
   * internal once-a-second tick. Still re-reads getElapsedSeconds() whenever this flips even while
   * false, so a not-yet-started (0:00) or just-frozen post-win value shows immediately. */
  clockRunning: boolean
  movesCount: number
  /** Game-specific settings section (Klondike draw count, Spider suit count, ...), rendered above
   * the global Solitaire settings inside the shared dialog. Omitted by FreeCell/Pyramid, which
   * have no game-specific settings. */
  settingsContent?: ReactNode
  /** This game's own "how to play" bullets (see constants/gameRules.ts) - shown by the rules icon
   * below via RulesDialog. Owned by each screen, same as settingsContent, rather than GameChrome
   * looking a gameId up itself. */
  rules: string[]
  /** The game board itself - foundations/tableau/stock, whatever shape a given game needs. Scrolls
   * if it doesn't fit (Pyramid's triangle + stock row can exceed a short viewport). */
  children: ReactNode
}

/** Shared top/bottom chrome for every game screen. Left corner: Back paired with a title showing
 * which game (and variant, where one exists) is in play, like a standard nav-bar back+title pair.
 * Right corner: Settings, unchanged from where it's always lived (also top-right on the main menu -
 * see index.tsx - so moving it would break that cross-screen consistency). The moves count +
 * elapsed timer live at the bottom instead, in their own always-visible row just above the footer -
 * New Game, Undo, and Hint (highlights a legal move on the board - see engine/hint.ts), which the
 * player can tuck away by tapping empty table felt and bring back the same way (see footerVisible/
 * toggleFooter and the RNPressable wrapping {children} below), since those three are game controls
 * reached for far less often than anything mid-board and don't need to stay onscreen while the
 * player's actually working the tableau - unlike the moves/timer readout, which stays put
 * regardless of the footer's own hidden state.
 *
 * Previously each of the four game screens hand-rolled its own version of this row (and Pyramid's
 * had drifted to a bottom button row entirely) - unifying it here means a layout tweak (like this
 * one, and the header/footer regrouping that followed it) only has to happen once. */
export function GameChrome({ title, subtitle, onNewGame, onUndo, undoDisabled, onHint, hintDisabled, hasProgress, getElapsedSeconds, clockRunning, movesCount, settingsContent, rules, children }: GameChromeProps) {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const colors = useTableColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [confirmNewGameVisible, setConfirmNewGameVisible] = useState(false)
  const [footerVisible, setFooterVisible] = useState(true)
  const { clearLastActiveGame } = useLastActiveGame()
  const undoHold = useHoldToRepeat(onUndo, UNDO_HOLD_REPEAT_MS)

  // The only thing in this whole screen that re-renders once a second while a deal is in progress
  // - not the parent game screen (and therefore not the board it renders as `children`), which no
  // longer has any per-second-ticking state of its own to force that (see useGameSession.ts).
  const [displayedElapsed, setDisplayedElapsed] = useState(getElapsedSeconds)
  // Resyncs displayedElapsed the instant clockRunning flips (deal starts/resumes/wins), rather than
  // waiting up to a second for the interval below to get around to it - e.g. resuming an
  // in-progress deal would otherwise flash "0:00" for up to a second before its first tick. Setting
  // state directly during render (React's documented pattern for "adjust state when a prop
  // changes") re-renders immediately, before paint, instead of the extra committed-then-corrected
  // frame a same-effect setState would cost - see the interval effect below, which only manages
  // truly external state now (a timer subscription).
  const [prevClockRunning, setPrevClockRunning] = useState(clockRunning)
  if (clockRunning !== prevClockRunning) {
    setPrevClockRunning(clockRunning)
    setDisplayedElapsed(getElapsedSeconds())
  }
  useEffect(() => {
    if (!clockRunning) return
    const id = setInterval(() => setDisplayedElapsed(getElapsedSeconds()), 1000)
    return () => clearInterval(id)
  }, [clockRunning, getElapsedSeconds])

  const footerOpacity = useSharedValue(1)
  const footerTranslateY = useSharedValue(0)
  const footerAnimatedStyle = useAnimatedStyle(() => ({ opacity: footerOpacity.value, transform: [{ translateY: footerTranslateY.value }] }))

  // Slides the moves/timer row down to fill the footer's own spot once it's hidden, rather than
  // leaving it stranded above an empty gap - moves/timer itself never fades (see toggleFooter),
  // only repositions, so this is a plain translateY with no matching opacity value of its own.
  const movesTimerTranslateY = useSharedValue(0)
  const movesTimerAnimatedStyle = useAnimatedStyle(() => ({ transform: [{ translateY: movesTimerTranslateY.value }] }))

  function toggleFooter() {
    const next = !footerVisible
    setFooterVisible(next)
    // react-hooks/immutability has no model of Reanimated SharedValues as a side-channel that
    // deliberately lives outside React's render/memoization system - mutating `.value` here never
    // re-renders anything itself (see the identical, fuller explanation in DragGhostLayer.tsx).
    /* eslint-disable react-hooks/immutability */
    footerOpacity.value = withTiming(next ? 1 : 0, { duration: 180, easing: next ? Easing.out(Easing.quad) : Easing.in(Easing.quad) })
    footerTranslateY.value = withTiming(next ? 0 : 24, { duration: 180, easing: next ? Easing.out(Easing.quad) : Easing.in(Easing.quad) })
    movesTimerTranslateY.value = withTiming(next ? 0 : MOVES_TIMER_BOTTOM - FOOTER_BOTTOM, { duration: 180, easing: next ? Easing.out(Easing.quad) : Easing.in(Easing.quad) })
    /* eslint-enable react-hooks/immutability */
  }

  return (
    <View style={styles.screen}>
      <ContentGutter maxContentWidth={GAME_CONTENT_MAX_WIDTH} style={styles.gutterRow}>
        <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, { paddingTop: GAME_CONTENT_TOP_PADDING + insets.top, paddingBottom: GAME_CONTENT_BOTTOM_PADDING + insets.bottom }]}>
          {/* Plain RN Pressable, not @rific/feedback-press's - a background tap toggling the
          footer isn't a button and shouldn't trigger haptic/sound feedback (same reasoning as
          DealLayer's screen-wide skip-tap overlay). Wrapping {children} rather than sitting
          behind it as a separate sibling matters: RN's touch responder negotiation bubbles up
          from whichever nested view claims it first (every card already nests its own Pressable
          for tap-to-move, which claims its own taps), so a card tap never reaches this outer
          onPress - a sibling overlay instead risks a ScrollView or a plain layout View eating
          the tap via native z-order hit-testing before it ever reaches a handler. */}
          <RNPressable onPress={toggleFooter} style={styles.tableTapCatcher}>
            {children}
          </RNPressable>
        </ScrollView>
      </ContentGutter>

      {/* Paired with the reserved Back button on the left, like a standard nav-bar title - still
      the rules trigger (tapping it opens the same dialog the footer's own Rules icon does below),
      just with no glyph riding beside the text anymore - that crowded the title and fought it for
      space. `subtitle` (the active variant, where a game has one) appends onto this same line as
      `Title · Subtitle` - one plain Text, not a second element, so a subtitle-less screen (most of
      them) renders nothing extra at all rather than an empty caption slot. This band has plenty of
      width for it now that neither the info glyph nor the moves/timer readout shares it anymore
      (see GameChromeProps' own doc comment on `title`/`subtitle`). */}
      <Pressable onPress={() => setRulesOpen(true)} style={[styles.titleWrap, { top: 14 + insets.top, left: 60 + insets.left, right: 56 + insets.right }]} accessibilityLabel={`${title}${subtitle ? ` ${subtitle}` : ''} rules`}>
        <Text style={styles.titleText} numberOfLines={1}>
          {subtitle ? `${title} · ${subtitle}` : title}
        </Text>
      </Pressable>

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

      {/* Moves + elapsed time - always visible (not part of footerAnimatedStyle/footerVisible
      below), sitting in its own row above the footer. Unlike Undo/New Game/Hint, this is a
      read-only status line, not a control reached for occasionally - there's no reason tapping
      the table to declutter the board should also take this away entirely, but it does slide
      down to fill the footer's own spot once those buttons are gone (movesTimerAnimatedStyle),
      rather than sitting stranded above an empty gap. */}
      <Animated.View style={[styles.movesTimerWrap, { bottom: MOVES_TIMER_BOTTOM + insets.bottom }, movesTimerAnimatedStyle]} pointerEvents='none'>
        <Text style={styles.timerText} numberOfLines={1}>
          {movesCount} · {formatTime(displayedElapsed)}
        </Text>
      </Animated.View>

      {/* Undo/New Game/Hint/Rules - the controls reached for far less often than anything
      mid-board, tucked into a footer the player can hide (tap empty table felt) to get them out
      of the way of the board, then bring back the same way. Hint is disabled once the deal is won
      - see GameChromeProps' own doc comment. Rules also still opens by tapping the title itself
      (see the titleWrap comment above) - this icon is a second, more discoverable way in, matching
      the other three exactly, rather than the title's own glyph crowding the text. */}
      <Animated.View style={[styles.footerWrap, { bottom: FOOTER_BOTTOM + insets.bottom }, footerAnimatedStyle]} pointerEvents={footerVisible ? 'auto' : 'none'}>
        <IconButton icon='undo' iconColor={CHROME_FG} size={24} disabled={undoDisabled} onPress={onUndo} onLongPress={undoHold.onLongPress} onPressOut={undoHold.onPressOut} delayLongPress={UNDO_LONG_PRESS_MS} accessibilityLabel='Undo' />

        <IconButton
          icon='cards-playing-outline'
          iconColor={CHROME_FG}
          size={24}
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

        <IconButton icon='lightbulb-on-outline' iconColor={CHROME_FG} size={24} disabled={hintDisabled} onPress={onHint} accessibilityLabel='Hint' />

        <IconButton icon='information-outline' iconColor={CHROME_FG} size={24} onPress={() => setRulesOpen(true)} accessibilityLabel='Rules' />
      </Animated.View>

      <SettingsDialog visible={settingsOpen} onDismiss={() => setSettingsOpen(false)}>
        {settingsContent}
      </SettingsDialog>

      <RulesDialog visible={rulesOpen} onDismiss={() => setRulesOpen(false)} title={title} rules={rules} />

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
    content: {
      // Centers any top-level child narrower than the available content width (e.g. a board once
      // genuinely narrower than GAME_CONTENT_MAX_WIDTH's own cap) instead of leaving it
      // default-stretched full-width and therefore left-anchored.
      alignItems: 'center',
      paddingHorizontal: GAME_CONTENT_PADDING
    },
    // The title wrap, the moves/timer band, the footer, and the corner buttons themselves are
    // all absolutely positioned siblings of the scrolling content - on web, a later positioned
    // sibling wins pointer-event hit-testing over an earlier one by DOM order alone unless
    // elevated explicitly (see PileView's identical stacking-context note), so every chrome layer
    // needs its own zIndex to reliably sit above the board and receive taps regardless of source
    // order.
    cornerButtons: {
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
      zIndex: 10
    },
    // Undo/New Game/Hint, floating bottom-center - no bar/background, matching the minimal look
    // the rest of this chrome already has. Hidden/shown by GameChrome's own footerVisible state
    // (see footerAnimatedStyle) rather than unmounting, so the fade/slide has something to animate.
    footerWrap: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 16,
      justifyContent: 'center',
      left: 0,
      position: 'absolute',
      right: 0,
      zIndex: 10
    },
    // ContentGutter's own row needs this to consume `screen`'s full remaining height - the same
    // flex:1 that used to govern the ScrollView directly against `screen`, one level further in -
    // so its two gutters (and anything a game optionally renders into them) run the full vertical
    // extent of the play area, not just as tall as the board happens to be.
    gutterRow: {
      flex: 1
    },
    // Centered full-width, matching footerWrap's own centering below - reads as one visually
    // related pair (status line + the controls that act on it) even though only the footer
    // actually hides.
    movesTimerWrap: {
      alignItems: 'center',
      left: 0,
      position: 'absolute',
      right: 0,
      zIndex: 10
    },
    screen: {
      backgroundColor: colors.tableFelt,
      flex: 1
    },
    // Without an explicit style here (contentContainerStyle alone isn't enough), a vertical
    // ScrollView's cross-axis (width) sizes to its content instead of its parent - harmless for
    // content narrower than the screen, but a wider board (Spider's 10 columns) just grows the
    // whole page instead of being constrained and clipped/scrollable within the viewport.
    scroll: {
      flex: 1
    },
    // Wraps {children} as the table-tap-to-hide-footer catcher (see where it's rendered) -
    // reproduces `content`'s own alignItems: 'center' so wrapping it doesn't change how a board
    // narrower than the available width lays out (Spider's board is several top-level siblings,
    // not one, so this can't be left to the default alignItems: 'stretch').
    tableTapCatcher: {
      alignItems: 'center',
      width: '100%'
    },
    timerText: {
      color: '#fff',
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 16,
      fontVariant: ['tabular-nums']
    },
    titleText: {
      color: '#fff',
      // Shrinks rather than overflowing titleWrap's own right bound - numberOfLines={1} truncation
      // still applies within whatever width that leaves it.
      flexShrink: 1,
      fontFamily: CARD_FONT_FAMILY,
      fontSize: 16,
      fontWeight: '700'
    },
    titleWrap: {
      // Left-aligned (hugging the Back button, like a standard nav-bar title), not centered in
      // its own left/right band - that band is sized to clear the Settings gear, which isn't the
      // same as being centered on the screen.
      //
      // Fixed height matching Home/Settings' own 40px touchable box (react-native-paper's MD3
      // IconButton: 24px icon + 8px padding each side - see its own PADDING constant), at the same
      // top offset those buttons render at - so centering titleText within this box via
      // justifyContent lands it on the exact same vertical center as the icon row beside it,
      // rather than a content-sized box (title's own ~19px line height) whose center sits several
      // px higher and reads as visibly uncentered against them. Confirmed against live
      // getBoundingClientRect() measurements, not just the nominal `top: 8` CornerActionButtons
      // itself renders with - IconButton's own default margin pushes its real box a few px further
      // than that alone would suggest.
      height: 40,
      justifyContent: 'center',
      position: 'absolute',
      zIndex: 10
    }
  })
}
