import { Pressable } from '@rific/feedback-press'
import { rotateInsets, useRotation } from '@tastic/core'
import { ConfirmDialog, CornerActionButtons } from '@tastic/hud'
import { useRouter } from 'expo-router'
import { ReactNode, useEffect, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { Icon, Portal } from 'react-native-paper'
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Par } from '@/engine/par'
import { computeScore } from '@/engine/score'
import { useSettings } from '@/hooks/useSettings'
import { useLastActiveGame } from '@/stores/lastActiveGame'

import { HintHandler, useAutoHint } from './autoHint'
import { useBoardScroll } from './boardScroll'
import { AUTO_PLAY_STAGGER_MS } from './dragdrop/dragSpring'
import { GAME_CONTENT_BOTTOM_PADDING, GAME_CONTENT_MAX_WIDTH, GAME_CONTENT_PADDING, GAME_CONTENT_TOP_PADDING, useGameLayout } from './gameLayout'
import { RotatedContentGutter } from './RotatedContentGutter'
import { RulesDialog } from './RulesDialog'
import { SettingsDialog } from './SettingsDialog'
import { CHROME_FG } from './theme'
import { UndoHandler, useUndoHold } from './undoHold'
import { CARD_FONT_FAMILY } from './useFontsPreload'

export function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** The horizontal padding GameChrome's own scroll content actually renders with (see `content`
 * below) - every game screen's own cardLayoutForRow call must subtract this same value (not some
 * separately-hardcoded, possibly-drifted number of its own), or its tableau/row math ends up
 * sized for a different available width than the one it actually renders into. Confirmed live:
 * Spider previously used its own SCREEN_PADDING (8) plus a now-redundant paddingHorizontal on its
 * own tableauRow (8 more), while this component was already contributing 12 - three
 * independently-chosen numbers for what has to be one true value, and the mismatch ran a 10-column
 * board off the right edge of the screen.
 *
 * Deliberately equal to CARD_GAP_MIN, not just a separately-chosen round number: the whole point of
 * a shared card-row gap is that a card grid reads as one consistent unit of spacing - the edge of
 * the screen to the nearest card should feel like just another gap in that same grid, not a bigger
 * or smaller margin of its own. This only tracks CARD_GAP_MIN's own floor value, not a per-game
 * `gap` once it's grown past that floor (see cardLayoutForRow) - fully closing that gap would mean
 * threading each game's own render-scoped `gap` into this shared, cross-game constant, which only
 * matters on a wide enough window that a low-column game's cards have already maxed out, a case
 * this app's real (mobile-first) usage rarely reaches. */
export { GAME_CONTENT_PADDING }

/** Upper bound on the board's own content width on a wide desktop/web window - past this, the
 * leftover horizontal space becomes empty, symmetric gutters (see `ContentGutter` below) instead
 * of the board stretching or drifting off-center. Sized to Spider's own widest natural case: at
 * `cardWidthForRow`'s own 96px/card max, Spider's 10-column tableau renders at
 * 96*10 + CARD_GAP_MIN(6)*9 = 1014px, plus this same GAME_CONTENT_PADDING(6) on both sides = 1026px of
 * content width before Spider's own cards stop growing regardless of how much wider the window
 * gets - past that point cardLayoutForRow's own gap-growing behavior (see cardLayout.ts) takes over
 * instead of leaving dead space, so 1040 doesn't need much margin past that exact saturation point
 * the way a hard cliff would have; it's still meaningfully capping well short of an ultrawide
 * monitor. Every game screen's own `cardLayoutForRow` call must run its raw window width through
 * `computeContentBounds(winWidth, GAME_CONTENT_MAX_WIDTH)` first - same as GAME_CONTENT_PADDING
 * above, one true shared value, not a per-game guess. */
export { GAME_CONTENT_MAX_WIDTH }

/** The ScrollView's own top/bottom content padding (see `contentContainerStyle` below), i.e. how
 * much vertical space the title/corner-icon band and the timer band each reserve above/below the
 * scrolling board content - on top of `insets.top`/`insets.bottom`, which these two are combined
 * with inline rather than baked in here. Exported so a game screen's own tableau-height budget
 * (useTableauMaxHeight) can subtract the exact same two numbers this component actually renders
 * with, instead of guessing at them independently. */
export { GAME_CONTENT_TOP_PADDING }
// The band reserved below the board for the footer buttons and the scoreboard's numbers above them (see
// FOOTER_BUTTON_HEIGHT and MOVES_TIMER_BOTTOM below); the scoreboard's labels and chevron reach a little
// above it, over the felt.
export { GAME_CONTENT_BOTTOM_PADDING }

/** zIndex for a screen-level win/loss dialog (WinBanner/LossBanner, or a game's own custom banner
 * like Spider's/Pyramid's) - comfortably above every other explicit zIndex anywhere in this app
 * (GameChrome's own chrome at 10; SequenceFlightGhosts' per-card zIndex, which can climb into the
 * low thousands for a long run) and high enough to win even if a dialog and some other screen-level
 * overlay (Fireworks, WinCascadeGhosts, or the single shared drag/deal ghost - the latter two render
 * from a provider that wraps the whole screen, so they're true DOM/view siblings of the dialog, not
 * just siblings-in-spirit) turn out to share a stacking context on a given platform. Every dialog
 * previously relied purely on being the last JSX sibling ("later sibling wins"), which this
 * codebase's own comments already flag as unreliable for anything that actually matters (see the
 * zIndex:10 comment below) - confirmed to fail for real on Spider's win-cascade animation and on
 * AcesUp's winning move (whose flight ghost is a structural sibling of the whole screen, including
 * the dialog, regardless of this file's own JSX order). Don't rely on JSX order for a dialog again;
 * set this explicitly instead. */
export const GAME_DIALOG_Z_INDEX = 9999

// Press-and-hold-to-repeat undo (see the Undo button below and useUndoHold). The cards stream back at
// the auto-play's own pace, AUTO_PLAY_STAGGER_MS apart (96ms at the default), each leaving while the
// ones before it are still flying - the hold is the auto-play run backwards. A screen whose next undo
// can't share the air yet (the same card still landing, a deal-layer revert) makes it wait rather than
// dropping it, so every repeat is one undo.
const UNDO_LONG_PRESS_MS = 400
const UNDO_HOLD_REPEAT_MS = AUTO_PLAY_STAGGER_MS

// Vertical rhythm shared by the footer and the moves/timer row that sits just above it - single
// source for both their JSX bottom offsets and how far the moves/timer row slides down to fill the
// footer's own spot once it's hidden (see toggleFooter's movesTimerTranslateY).
// The scoreboard's bottom sits a clear gap above the buttons' tops (60), wider than the gap between any
// number or icon and its own label, so each label reads as its own row's (Jay, 2026-10-16: every label goes
// under its number or icon).
const FOOTER_BOTTOM = 8
const MOVES_TIMER_BOTTOM = 66

// Portrait footer buttons (New Game | Undo | Hint): each a wide 88x52 target, 8pt apart, so a thumb that
// lands a little off still hits. Rules isn't in this row - tapping the title opens it. Each button is its
// 24pt icon over a caption in the scoreboard's label style (Jay, 2026-10-16: his kids had to ask where to
// start a new game; the icon alone, a fan of cards, didn't say it). The caption fits inside the same 52pt
// box: icon, a 2pt gap, the caption's line, set a little low (FOOTER_CAPTION_BOTTOM).
const FOOTER_BUTTON_WIDTH = 88
const FOOTER_ICON_SIZE = 24
const FOOTER_ICON_TOP = 8
const FOOTER_CAPTION_GAP = 2
const FOOTER_CAPTION_BOTTOM = 4
const FOOTER_GAP = 8

// The moves/score/time readout is the footer's show/hide button. Captioned, it is laid out on the footer's own grid
// (each stat as wide as a footer button, the same gap, so Moves sits over New Game, Score over Undo, Time over Hint -
// Jay, 2026-10-14: a narrow block centred over the wider button row read as two unrelated things). Its box is that
// row's width and reaches 6pt above the text, so it is easy to hit without covering the board.
const SCOREBOARD_WIDTH = 3 * FOOTER_BUTTON_WIDTH + 2 * FOOTER_GAP
// The scoreboard's text lines: fixed, so SCOREBOARD_DROP below is exact.
const STAT_LABEL_LINE = 14
const STAT_VALUE_LINE = 22
const STAT_LABEL_COLOR = 'rgba(255, 255, 255, 0.65)'
// A footer button: icon, gap and one caption line (in the scoreboard's label style) plus its padding.
const FOOTER_BUTTON_HEIGHT = FOOTER_ICON_TOP + FOOTER_ICON_SIZE + FOOTER_CAPTION_GAP + STAT_LABEL_LINE + FOOTER_CAPTION_BOTTOM
// A footer button while pressed (Paper's IconButton overlay on iOS): the chrome's white at 12%.
const FOOTER_PRESSED_COLOR = 'rgba(255, 255, 255, 0.12)'
const CHEVRON_SIZE = 18
// How far the scoreboard drops when the footer is tucked away: its numbers (the row's top line, over the labels'
// line, which sits MOVES_TIMER_BOTTOM up) land centred on the buttons' row (FOOTER_BOTTOM plus half a button).
const SCOREBOARD_DROP = MOVES_TIMER_BOTTOM + STAT_LABEL_LINE + STAT_VALUE_LINE / 2 - (FOOTER_BOTTOM + FOOTER_BUTTON_HEIGHT / 2)
const SCOREBOARD_TOP_SLOP = 6
// How far a portrait footer button's touch area reaches above its pill: over the gap and the scoreboard's labels'
// line, up to its numbers (Jay, 2026-10-16: he kept collapsing the footer when he meant to press Hint). Nobody taps
// the word TIME to tuck the controls away, so a tap there is a Hint tap a little high. The footer is drawn after
// the scoreboard, so while it is up it wins that line; tucked away it takes no touches (and the scoreboard is
// stacked above it), so the whole scoreboard is the toggle again.
const FOOTER_TOUCH_REACH = MOVES_TIMER_BOTTOM + STAT_LABEL_LINE - (FOOTER_BOTTOM + FOOTER_BUTTON_HEIGHT)

// Wide (landscape) layout only - the footer and the readout live in the side gutters GameLayout
// reserves (see gameLayout.ts), never over the board. The 8pt margin keeps the readout off the
// gutter's own outer edge / the safe-area inset. The footer column is one button wide: 48pt, room for
// its widest caption (RULES, ~45pt; NEW GAME wraps onto two lines), 4pt off the safe edge, so each icon
// sits where the old 40pt IconButton at 8pt drew it. Both columns are centred in the height below the
// corner buttons (GAME_CONTENT_TOP_PADDING, their band), so a tall footer column never runs under the
// Settings cog on a short screen (a 320pt-tall phone held sideways).
const WIDE_FOOTER_RIGHT_MARGIN = 4
const WIDE_FOOTER_BUTTON_WIDTH = 48
const WIDE_FOOTER_GAP = 8

interface FooterButtonLayout {
  width: number
  /** Touch area above the pill (FOOTER_TOUCH_REACH in portrait). */
  reach: number
  /** Half the gap to each neighbour, so a press between two buttons still lands. Only along the row or column:
   * iOS and Android never hand a child a touch outside its parent's bounds, and the wide column is one button wide. */
  hitSlop: { top?: number; bottom?: number; left?: number; right?: number }
}
const FOOTER_BUTTON_LAYOUT: FooterButtonLayout = { width: FOOTER_BUTTON_WIDTH, reach: FOOTER_TOUCH_REACH, hitSlop: { left: FOOTER_GAP / 2, right: FOOTER_GAP / 2 } }
const WIDE_FOOTER_BUTTON_LAYOUT: FooterButtonLayout = { width: WIDE_FOOTER_BUTTON_WIDTH, reach: 0, hitSlop: { top: WIDE_FOOTER_GAP / 2, bottom: WIDE_FOOTER_GAP / 2 } }
const WIDE_STATS_LEFT_MARGIN = 8
const WIDE_STATS_GAP = 10

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
  /** One undo per call - see UndoHandler. */
  onUndo: UndoHandler
  undoDisabled: boolean
  /** Highlights a legal move (or suggests a stock draw) somewhere on the board - see
   * engine/hint.ts's findHint, which every screen calls this from. Also called by the Auto Hint
   * setting (see autoHint.ts), with `{ auto: true }`. */
  onHint: HintHandler
  /** The board as it stands (each screen's state object): the Auto Hint setting's wait starts over
   * whenever it changes. */
  autoHintKey: unknown
  /** A hint is showing for the board as it stands, so Auto Hint has nothing to add. */
  hintShowing: boolean
  /** True once the deal is won - a hint has nothing left to suggest. */
  hintDisabled?: boolean
  /** True once the deal is won - hides the footer (Undo/New Game/Hint/Rules) and the moves/timer/
   * score row below, since the win dialog (WinBanner) already shows all three and covers the board
   * anyway. Deliberately NOT the same thing as `hintDisabled`: AcesUp passes `won || stuck` for the
   * latter (a stuck, unwinnable deal has nothing left to hint either), but a stuck deal isn't a win -
   * its LossBanner has no score to duplicate, and Undo stays reachable there on purpose, so this
   * chrome should keep showing while merely stuck. */
  won: boolean
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
  /** The session's setPaused: GameChrome holds the clock ('dialog') while Rules or Settings is open, so reading the
   * rules or changing a setting costs no score. */
  pauseClock: (reason: string, paused: boolean) => void
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
  /** The deal's variant's par (engine/par.ts), told in the Rules sheet's Scoring paragraph. */
  par: Par
  /** The game board itself - foundations/tableau/stock, whatever shape a given game needs. Laid out to
   * fit the screen; scrolls only when a column too long to compress any further runs past the bottom
   * (see boardScroll.ts). */
  children: ReactNode
}

/** Owns the once-a-second tick that keeps the moves/score/time readout live, so ONLY the readout
 * re-renders each second. The tick used to be state on GameChrome itself, which re-rendered the whole
 * chrome (footer, hidden dialogs, settings content, every animated style) once a second for as long as
 * a deal was in progress - measured at ~140ms of JS per tick, i.e. a busy thread ~14% of the time
 * exactly while the player is dragging cards. Unmounted while `won` (its caller only renders it then),
 * so a fresh New Game after a win remounts it and re-reads the clock instead of showing the frozen
 * time of the deal that just ended. */
function ElapsedClock({ getElapsedSeconds, clockRunning, children }: { getElapsedSeconds: () => number; clockRunning: boolean; children: (displayedElapsed: number) => ReactNode }) {
  const [displayedElapsed, setDisplayedElapsed] = useState(getElapsedSeconds)
  // Resyncs the instant clockRunning flips (deal starts/resumes), rather than waiting up to a second
  // for the interval below - e.g. resuming an in-progress deal would otherwise flash "0:00" for up to
  // a second before its first tick. Setting state directly during render (React's documented "adjust
  // state when a prop changes" pattern) re-renders immediately, before paint, instead of the extra
  // committed-then-corrected frame a same-effect setState would cost.
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
  return <>{children(displayedElapsed)}</>
}

/** Shared top/bottom chrome for every game screen. Left corner: Back paired with a title showing
 * which game (and variant, where one exists) is in play, like a standard nav-bar back+title pair.
 * Right corner: Settings, unchanged from where it's always lived (also top-right on the main menu -
 * see index.tsx - so moving it would break that cross-screen consistency). The moves count +
 * elapsed timer live at the bottom instead, in their own always-visible row just above the footer -
 * New Game, Undo, and Hint (highlights a legal move on the board - see engine/hint.ts), which the
 * player can tuck away by tapping the moves/timer readout and bring back the same way (see footerVisible/
 * toggleFooter), since those three are game controls
 * reached for far less often than anything mid-board and don't need to stay onscreen while the
 * player's actually working the tableau - unlike the moves/timer readout, which stays put
 * regardless of the footer's own hidden state (though both disappear together once `won`, per
 * GameChromeProps' own doc comment on it).
 *
 * Previously each of the four game screens hand-rolled its own version of this row (and Pyramid's
 * had drifted to a bottom button row entirely) - unifying it here means a layout tweak (like this
 * one, and the header/footer regrouping that followed it) only has to happen once. */
export function GameChrome({ title, subtitle, onNewGame, onUndo, undoDisabled, onHint, autoHintKey, hintShowing, hintDisabled, won, hasProgress, getElapsedSeconds, pauseClock, par, clockRunning, movesCount, settingsContent, rules, children }: GameChromeProps) {
  const router = useRouter()
  // The safe-area insets remapped onto the rotated frame's own edges (a no-op at rotation 0). The dialogs
  // below need no rotation of their own - see the Portal.Host in withGameProviders.
  const rotation = useRotation()
  const insets = rotateInsets(useSafeAreaInsets(), rotation)
  const { isWide, windowWidth, leftGutter, topPadding, bottomPadding } = useGameLayout()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [confirmNewGameVisible, setConfirmNewGameVisible] = useState(false)
  const [footerVisible, setFooterVisible] = useState(true)
  const { clearLastActiveGame } = useLastActiveGame()
  const undoHold = useUndoHold(onUndo, UNDO_HOLD_REPEAT_MS)
  const { scrollProps, holdHeight, boardKey } = useBoardScroll(movesCount)
  const { settings } = useSettings()
  const dialogOpen = settingsOpen || rulesOpen
  useEffect(() => {
    pauseClock('dialog', dialogOpen)
  }, [pauseClock, dialogOpen])
  useAutoHint({ seconds: settings.autoHintSeconds, boardKey: autoHintKey, paused: !!hintDisabled || settingsOpen || rulesOpen || confirmNewGameVisible, hintShowing, onHint })

  const footerOpacity = useSharedValue(1)
  const footerTranslateY = useSharedValue(0)
  const footerAnimatedStyle = useAnimatedStyle(() => ({ opacity: footerOpacity.value, transform: [{ translateY: footerTranslateY.value }] }))

  // Slides the moves/timer row down to fill the footer's own spot once it's hidden, rather than
  // leaving it stranded above an empty gap - the row itself never fades as a whole (see
  // toggleFooter), only repositions; its labels fade (labelOpacity below) as it goes.
  const movesTimerTranslateY = useSharedValue(0)
  const movesTimerAnimatedStyle = useAnimatedStyle(() => ({ transform: [{ translateY: movesTimerTranslateY.value }] }))

  // The scoreboard's MOVES/SCORE/TIME labels: shown while the footer is up (the scoreboard is expanded), faded out while
  // it is tucked away. It is ONE row in both states (Jay, 2026-10-14): the numbers keep their columns and only drop
  // into the buttons' place, rather than swapping to a separate one-line "12 · 45 · 0:33" that regrouped them.
  const labelOpacity = useSharedValue(1)
  const labelAnimatedStyle = useAnimatedStyle(() => ({ opacity: labelOpacity.value }))
  // The chevron over the scoreboard's numbers (Jay, 2026-10-14: nothing said the scoreboard hides the buttons): points
  // down while they show and turns to point up as they tuck away. Driven by labelOpacity, so it turns as the labels fade.
  const chevronAnimatedStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${(1 - labelOpacity.value) * 180}deg` }] }))

  function toggleFooter() {
    const next = !footerVisible
    setFooterVisible(next)
    // react-hooks/immutability has no model of Reanimated SharedValues as a side-channel that
    // deliberately lives outside React's render/memoization system - mutating `.value` here never
    // re-renders anything itself (see the identical, fuller explanation in DragGhostLayer.tsx).
    /* eslint-disable react-hooks/immutability */
    footerOpacity.value = withTiming(next ? 1 : 0, { duration: 180, easing: next ? Easing.out(Easing.quad) : Easing.in(Easing.quad) })
    footerTranslateY.value = withTiming(next ? 0 : 24, { duration: 180, easing: next ? Easing.out(Easing.quad) : Easing.in(Easing.quad) })
    movesTimerTranslateY.value = withTiming(next ? 0 : SCOREBOARD_DROP, { duration: 180, easing: next ? Easing.out(Easing.quad) : Easing.in(Easing.quad) })
    labelOpacity.value = withTiming(next ? 1 : 0, { duration: 180, easing: next ? Easing.out(Easing.quad) : Easing.in(Easing.quad) })
    /* eslint-enable react-hooks/immutability */
  }

  // Portrait gives each button a wide target (see FOOTER_BUTTON_WIDTH); the wide layout's column is one
  // button wide (see WIDE_FOOTER_BUTTON_WIDTH).
  const footerLayout = isWide ? WIDE_FOOTER_BUTTON_LAYOUT : FOOTER_BUTTON_LAYOUT

  const undoButton = <FooterButton icon='undo' label='Undo' layout={footerLayout} disabled={undoDisabled} onPress={() => void onUndo()} onLongPress={undoHold.onLongPress} onPressOut={undoHold.onPressOut} delayLongPress={UNDO_LONG_PRESS_MS} />

  const newGameButton = (
    <FooterButton
      icon='cards-playing-outline'
      label='New Game'
      layout={footerLayout}
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
    />
  )

  const hintButton = <FooterButton icon='lightbulb-on-outline' label='Hint' layout={footerLayout} disabled={hintDisabled} onPress={() => onHint()} />

  // The dialogs below (Settings, Rules, the New Game confirm) portal into the Portal.Host that
  // withGameProviders mounts INSIDE the rotated frame - so they lay out against the rotated size and
  // need no transform of their own (rotation={0}). See withGameProviders for why it lives there.
  return (
    <View style={styles.screen}>
      <RotatedContentGutter maxContentWidth={GAME_CONTENT_MAX_WIDTH} style={styles.gutterRow}>
        <ScrollView key={boardKey} {...scrollProps} testID='game-board-scroll' style={styles.scroll} contentContainerStyle={[styles.content, { paddingTop: (isWide ? topPadding : GAME_CONTENT_TOP_PADDING) + insets.top }, holdHeight > 0 && { minHeight: holdHeight }]}>
          {/* The bottom reserve (GAME_CONTENT_BOTTOM_PADDING, where the moves/timer row and footer float)
          is this wrapper's own paddingBottom. alignItems: 'center' lays out a board narrower than the
          available width the same way `content` does (Spider's board is several top-level siblings). The
          felt itself does nothing on a tap: it used to toggle the footer, and a tap that just missed a card
          hid it without the player noticing - the readout is the toggle now. */}
          <View style={[styles.boardWrap, { paddingBottom: (isWide ? bottomPadding : GAME_CONTENT_BOTTOM_PADDING) + insets.bottom }]}>{children}</View>
        </ScrollView>
      </RotatedContentGutter>

      {/* Paired with the reserved Back button on the left, like a standard nav-bar title - still
      the rules trigger in portrait (the portrait footer has no Rules icon; the wide layout's column does),
      just with no glyph riding beside the text anymore - that crowded the title and fought it for
      space. `subtitle` (the active variant, where a game has one) appends onto this same line as
      `Title · Subtitle` - one plain Text, not a second element, so a subtitle-less screen (most of
      them) renders nothing extra at all rather than an empty caption slot. This band has plenty of
      width for it now that neither the info glyph nor the moves/timer readout shares it anymore
      (see GameChromeProps' own doc comment on `title`/`subtitle`). */}
      {/* Wide layout: the title is not rendered at all - there is no band above the board for it
      (the board takes ~all of the height), and the corner buttons already fill the only free
      spots beside it. The Rules icon in the wide footer column opens the same dialog. */}
      {!isWide && (
        <Pressable onPress={() => setRulesOpen(true)} style={[styles.titleWrap, { top: 14 + insets.top, left: 60 + insets.left, right: 56 + insets.right }]} accessibilityLabel={`${title}${subtitle ? ` ${subtitle}` : ''} rules`}>
          <Text style={styles.titleText} numberOfLines={1}>
            {subtitle ? `${title} · ${subtitle}` : title}
          </Text>
        </Pressable>
      )}

      {/* Portaled into withGameProviders' in-frame Portal.Host, so Home and Settings sit above everything the
      screen draws over its board (the win/loss dialog's backdrop, the win cascade, fireworks, flying cards) and
      stay crisp and live there: the win dialog needs no Home button of its own, and the loss dialog has no room
      for one. Rendered BEFORE the dialogs below, so their portals (mounted after this one) still cover it.
      box-none: this box spans the full screen width (left:0/right:0) to place Home and Settings
      at its two far ends, but the dead space between them isn't a button - box-none lets a tap
      there fall through to whatever is underneath instead of being silently swallowed (see
      footerWrap's identical fix/comment below). */}
      <Portal>
        <View style={styles.cornerButtons} pointerEvents='box-none'>
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
              // cold-launch redirect in app/index.tsx). dismissTo() pops back to the Home that's
              // already in the stack beneath this game (same instance, no remount - the menu is still
              // exactly as it was), and only falls back to replace semantics when there is no Home
              // beneath (a deep link / cold-launch resume). replace('/') did NOT do this: it mounted a
              // brand-new Home on top of the old one, so every round trip leaked one more live Home
              // (each rebuilding ~370 SVG preview cards on the next tap) and going Home got slower each time.
              router.dismissTo('/')
            }}
            onSettings={() => setSettingsOpen(true)}
            fg={CHROME_FG}
            insets={insets}
            backIcon='home'
            backLabel='Home'
          />
        </View>
      </Portal>

      {/* Moves + elapsed time + running score - visible throughout play (not part of
      footerAnimatedStyle/footerVisible below), sitting in its own row above the footer. Unlike
      Undo/New Game/Hint, this is a read-only status line, not a control reached for occasionally -
      there's no reason hiding the footer to declutter the board should also take this away
      entirely, but it does slide down to fill the footer's own spot once those buttons are gone
      (movesTimerAnimatedStyle), rather than sitting stranded above an empty gap. Hidden entirely
      once `won`, alongside the footer below - see GameChromeProps' own doc comment on `won`: the
      win dialog already shows the same three numbers, so this would just be a stale duplicate
      sitting behind it.

      In portrait this row is also the footer's show/hide button (toggleFooter): tapping it tucks the
      footer away and tapping it again brings it back, from the same spot either way since the row slides
      into the footer's place. Labeled (MOVES/SCORE/TIME under each value, as each button's name is under its
      icon) while the footer is up: the scoreboard is expanded along with the controls. Tucked away, the labels
      fade and the same three numbers drop into the buttons' place, each staying in its column (Jay, 2026-10-14:
      it used to swap to a separate one-line readout, and labeled the tucked-away state instead of the expanded
      one). */}
      {!won && isWide && (
        // Leading (local left) gutter, left-aligned inside [insets.left + 8, leftGutter] and vertically
        // centred in the safe area. Always the captioned form (there is room for it and no footer to
        // compete with) and never animated - see the footer's own wide branch below.
        <ElapsedClock getElapsedSeconds={getElapsedSeconds} clockRunning={clockRunning}>
          {(displayedElapsed) => (
            <View style={[styles.wideStatsWrap, { left: insets.left + WIDE_STATS_LEFT_MARGIN, right: windowWidth - leftGutter, top: insets.top + GAME_CONTENT_TOP_PADDING, bottom: insets.bottom }]} pointerEvents='none'>
              <View style={styles.wideStatBlock}>
                <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
                  {movesCount}
                </Text>
                <Text style={styles.statCaption}>Moves</Text>
              </View>
              <View style={styles.wideStatBlock}>
                <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
                  {computeScore(movesCount, displayedElapsed)}
                </Text>
                <Text style={styles.statCaption}>Score</Text>
              </View>
              <View style={styles.wideStatBlock}>
                <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
                  {formatTime(displayedElapsed)}
                </Text>
                <Text style={styles.statCaption}>Time</Text>
              </View>
            </View>
          )}
        </ElapsedClock>
      )}
      {!won && !isWide && (
        <ElapsedClock getElapsedSeconds={getElapsedSeconds} clockRunning={clockRunning}>
          {(displayedElapsed) => (
            // Above the footer while it is hidden: the lowered readout then sits under the hidden buttons, and on
            // the web a child's own pointer-events beat a parent's pointerEvents='none', so they would take its tap.
            <Animated.View style={[styles.movesTimerWrap, { bottom: MOVES_TIMER_BOTTOM + insets.bottom }, !footerVisible && styles.movesTimerAboveFooter, movesTimerAnimatedStyle]} pointerEvents='box-none'>
              <Pressable onPress={toggleFooter} style={styles.scoreboardButton} accessibilityRole='button' accessibilityLabel={footerVisible ? 'Hide controls' : 'Show controls'}>
                <Animated.View style={[styles.chevron, chevronAnimatedStyle]} accessibilityElementsHidden importantForAccessibility='no-hide-descendants'>
                  <Icon source='chevron-down' size={CHEVRON_SIZE} color={STAT_LABEL_COLOR} />
                </Animated.View>
                <View style={styles.statsRow}>
                  <View style={styles.statBlock}>
                    <Text style={styles.statValue}>{movesCount}</Text>
                    <Animated.Text style={[styles.statCaption, labelAnimatedStyle]}>Moves</Animated.Text>
                  </View>
                  <View style={styles.statBlock}>
                    <Text style={styles.statValue}>{computeScore(movesCount, displayedElapsed)}</Text>
                    <Animated.Text style={[styles.statCaption, labelAnimatedStyle]}>Score</Animated.Text>
                  </View>
                  <View style={styles.statBlock}>
                    <Text style={styles.statValue}>{formatTime(displayedElapsed)}</Text>
                    <Animated.Text style={[styles.statCaption, labelAnimatedStyle]}>Time</Animated.Text>
                  </View>
                </View>
              </Pressable>
            </Animated.View>
          )}
        </ElapsedClock>
      )}

      {/* New Game | Undo | Hint - the controls reached for far less often than anything mid-board,
      tucked into a footer the player can hide (tap the moves/score/time readout) to get them out of the
      way of the board, then bring back the same way. Undo, the one used most, sits in the middle, the
      easiest spot for either thumb; New Game, the destructive one, sits furthest out. Rules has no icon
      here: the title opens it (see the titleWrap comment above). Hint is disabled once the deal is won
      - see GameChromeProps' own doc comment. Hidden entirely once `won` (see the moves/timer row's own comment just above) - the win dialog's "New Game"
      button already covers that one control, and there's nothing left to Undo/Hint/check Rules for
      on a finished board. */}
      {!won && !isWide && (
        // box-none (not 'auto') while visible: footerWrap's own box spans the full screen width
        // (left:0/right:0), wider than the centered icon row it actually contains, so plain 'auto'
        // silently swallowed every tap in that empty side margin - never reaching the board
        // underneath. box-none lets only the icons themselves (and their own touch targets)
        // claim a tap, same idiom WinBanner/LossBanner already use for their own full-screen overlay.
        <Animated.View style={[styles.footerWrap, { bottom: FOOTER_BOTTOM + insets.bottom }, footerAnimatedStyle]} pointerEvents={footerVisible ? 'box-none' : 'none'}>
          {newGameButton}
          {undoButton}
          {hintButton}
        </Animated.View>
      )}

      {/* Wide layout: the same buttons plus Rules (there is no title here to open it) as a vertical column in the trailing (local right) gutter -
      where the thumb is in a landscape hold - vertically centred in the safe area. Always visible and
      never animated: tap-to-hide is a portrait feature (there the footer floats over the board, so tucking
      it away frees room); here it sits in a gutter, so hiding it would give the board nothing back. The
      wrapper is box-none so only the icons claim taps; the rest falls through to the board. */}
      {!won && isWide && (
        <View style={[styles.wideFooterWrap, { right: insets.right + WIDE_FOOTER_RIGHT_MARGIN, top: insets.top + GAME_CONTENT_TOP_PADDING, bottom: insets.bottom }]} pointerEvents='box-none'>
          {undoButton}
          {newGameButton}
          {hintButton}
          <FooterButton icon='information-outline' label='Rules' layout={footerLayout} onPress={() => setRulesOpen(true)} />
        </View>
      )}

      <SettingsDialog visible={settingsOpen} onDismiss={() => setSettingsOpen(false)} rotation={0}>
        {settingsContent}
      </SettingsDialog>

      <RulesDialog visible={rulesOpen} onDismiss={() => setRulesOpen(false)} title={title} rules={rules} par={par} />

      <ConfirmDialog
        visible={confirmNewGameVisible}
        title='Start a New Game?'
        message='This game is still in progress. Starting a new one counts it as a loss.'
        confirmLabel='New Game'
        cancelLabel='Cancel'
        icon='alert-circle-outline'
        rotation={0}
        onConfirm={() => {
          setConfirmNewGameVisible(false)
          onNewGame()
        }}
        onCancel={() => setConfirmNewGameVisible(false)}
      />
    </View>
  )
}

interface FooterButtonProps {
  icon: string
  /** The caption under the icon, and the button's screen-reader label. */
  label: string
  layout: FooterButtonLayout
  disabled?: boolean
  onPress: () => void
  onLongPress?: () => void
  onPressOut?: () => void
  delayLongPress?: number
}

/** One of the game's controls (New Game, Undo, Hint, and in the wide layout Rules): its icon over a caption,
 * one touch target. feedback-press's Pressable (the same press sound/haptic an IconButton plays) rather than a
 * Paper IconButton, which has no room for a caption. The touch area is the pill plus `layout.reach` above it
 * (see FOOTER_TOUCH_REACH); the pressed highlight is drawn on the pill alone, on every platform (an Android
 * ripple would fill the whole touch area). */
function FooterButton({ icon, label, layout, disabled, onPress, onLongPress, onPressOut, delayLongPress }: FooterButtonProps) {
  return (
    <Pressable accessibilityRole='button' accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} onLongPress={onLongPress} onPressOut={onPressOut} delayLongPress={delayLongPress} hitSlop={layout.hitSlop} style={{ paddingTop: layout.reach, width: layout.width }}>
      {({ pressed }) => (
        <View style={[styles.footerButton, pressed && styles.footerButtonPressed]}>
          <View style={[styles.footerContent, disabled && styles.footerContentDisabled]}>
            <Icon source={icon} size={FOOTER_ICON_SIZE} color={CHROME_FG} />
            <Text style={[styles.statCaption, styles.footerCaption]}>{label}</Text>
          </View>
        </View>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  // Wraps {children} (see where it's rendered). flexGrow: 1 fills `content`'s own (flexGrow: 1) height,
  // so the bottom reserve on its paddingBottom sits at the bottom of the screen on a short board.
  boardWrap: {
    alignItems: 'center',
    flexGrow: 1,
    width: '100%'
  },
  // Centred over the scoreboard's middle column, in the labels' colour (see chevronAnimatedStyle).
  chevron: {
    alignSelf: 'center',
    height: CHEVRON_SIZE
  },
  content: {
    // Centers any top-level child narrower than the available content width (e.g. a board once
    // genuinely narrower than GAME_CONTENT_MAX_WIDTH's own cap) instead of leaving it
    // default-stretched full-width and therefore left-anchored.
    alignItems: 'center',
    // Without this, a vertical ScrollView's content container shrink-wraps to its actual content
    // height - shorter than the screen on every board that doesn't fill it (most of them, most of
    // the time) - leaving boardWrap (nested inside this container) shrink-wrapped too, with its
    // bottom reserve floating mid-screen. flexGrow:1 makes this container at least as tall as the ScrollView's
    // own viewport when content is shorter (harmless when content is taller - flexGrow can't
    // shrink it below that, so a column running past the bottom still scrolls; see boardScroll.ts).
    flexGrow: 1,
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
  // See FooterButton. Its height is the content's (FOOTER_BUTTON_HEIGHT with a one-line caption); the
  // radius rounds the pressed highlight into a pill. No overflow: 'hidden': the rounded corners reach into
  // the caption's line and clipped RULES in the 48pt wide-layout column.
  footerButton: {
    alignItems: 'center',
    borderRadius: FOOTER_BUTTON_HEIGHT / 2,
    paddingBottom: FOOTER_CAPTION_BOTTOM,
    paddingTop: FOOTER_ICON_TOP
  },
  footerButtonPressed: {
    backgroundColor: FOOTER_PRESSED_COLOR
  },
  // The scoreboard's caption style (statCaption), centred under the icon and allowed to wrap (NEW GAME in the
  // narrow wide-layout column).
  footerCaption: {
    marginTop: FOOTER_CAPTION_GAP,
    textAlign: 'center'
  },
  footerContent: {
    alignItems: 'center'
  },
  // A disabled button (Undo with nothing to undo, Hint on a finished board): icon and caption at 38%, as on a
  // Paper button. The felt is dark in every appearance mode, so this is the chrome's white dimmed rather than
  // the theme's onSurfaceDisabled (dark in light mode, so nearly invisible on the felt).
  footerContentDisabled: {
    opacity: 0.38
  },
  // New Game/Undo/Hint, floating bottom-center - no bar/background, matching the minimal look
  // the rest of this chrome already has. Hidden/shown by GameChrome's own footerVisible state
  // (see footerAnimatedStyle) rather than unmounting, so the fade/slide has something to animate.
  footerWrap: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: FOOTER_GAP,
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
  movesTimerAboveFooter: {
    zIndex: 11
  },
  movesTimerWrap: {
    alignItems: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    zIndex: 10
  },
  // The readout's own tap target (see SCOREBOARD_WIDTH): the padding only adds room above the text,
  // since the wrapper is placed by its bottom edge.
  scoreboardButton: {
    paddingTop: SCOREBOARD_TOP_SLOP,
    width: SCOREBOARD_WIDTH
  },
  screen: {
    flex: 1
  },
  // Without an explicit style here (contentContainerStyle alone isn't enough), a vertical
  // ScrollView's cross-axis (width) sizes to its content instead of its parent - harmless for
  // content narrower than the screen, but a wider board (Spider's 10 columns) just grows the
  // whole page instead of being constrained and clipped/scrollable within the viewport.
  scroll: {
    flex: 1
  },
  // One column of the captioned scoreboard: as wide as the footer button under it (see SCOREBOARD_WIDTH).
  statBlock: {
    alignItems: 'center',
    width: FOOTER_BUTTON_WIDTH
  },
  statCaption: {
    color: STAT_LABEL_COLOR,
    fontFamily: CARD_FONT_FAMILY,
    fontSize: 11,
    letterSpacing: 0.5,
    lineHeight: STAT_LABEL_LINE,
    textTransform: 'uppercase'
  },
  statValue: {
    color: '#fff',
    fontFamily: CARD_FONT_FAMILY,
    fontSize: 17,
    fontVariant: ['tabular-nums'],
    lineHeight: STAT_VALUE_LINE
  },
  statsRow: {
    flexDirection: 'row',
    gap: FOOTER_GAP
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
  },
  // Wide layout footer column: `width` is exactly one button (WIDE_FOOTER_BUTTON_WIDTH).
  // column-reverse: the buttons are declared Undo..Rules (the portrait row's left-to-right order), which as a
  // column would put Undo on top; in landscape the info button is wanted at the top and Undo at the bottom
  // (nearest the thumb's natural rest) - so the same children just stack the other way.
  wideFooterWrap: {
    alignItems: 'center',
    flexDirection: 'column-reverse',
    gap: WIDE_FOOTER_GAP,
    justifyContent: 'center',
    position: 'absolute',
    width: WIDE_FOOTER_BUTTON_WIDTH,
    zIndex: 10
  },
  // maxWidth so a value that outgrows the (narrow) gutter - a 3-digit-minutes TIME like 103:24 - shrinks
  // via adjustsFontSizeToFit instead of ellipsizing.
  wideStatBlock: {
    alignItems: 'flex-start',
    maxWidth: '100%'
  },
  wideStatsWrap: {
    alignItems: 'flex-start',
    gap: WIDE_STATS_GAP,
    justifyContent: 'center',
    position: 'absolute',
    zIndex: 10
  }
})
