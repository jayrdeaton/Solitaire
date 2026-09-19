import { CARD_ASPECT, faceUpFanOffset } from '@tastic/cards'
import { rotateInsets, useRotatedWindowDimensions, useRotation } from '@tastic/core'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { CARD_GAP_MAX, CARD_GAP_MIN } from './cardLayout'

/* ---------------------------------------------------------------------------------------------
 * The one place a game screen's board geometry comes from - both orientations.
 *
 * Portrait chrome (GameChrome's title/corner band on top, moves/timer + footer band on the bottom)
 * reserves GAME_CONTENT_TOP_PADDING + GAME_CONTENT_BOTTOM_PADDING = 144pt of a screen that's ~870pt
 * tall, which is fine. Rotated to landscape the same screen is only ~402pt tall, and 144pt of that
 * gone to chrome (plus a card row sized from the much WIDER rotated width) left no room for a
 * board at all - the tableau scrolled off the short axis with its playable bottom cards out of view.
 * So a "wide" layout (any window whose rotated footprint is landscape - a phone held sideways, an
 * iPad, a desktop browser) drops the vertical chrome bands instead: the corner buttons stay put,
 * the footer and the moves/timer readout move into narrow side gutters, and the cards are then
 * sized to whichever of width or HEIGHT runs out first (fitCardWidthToHeight) instead of width alone.
 * Portrait (any window taller than wide) is byte-for-byte what it always was.
 * ------------------------------------------------------------------------------------------- */

/** The horizontal padding GameChrome's own scroll content renders with. Deliberately equal to
 * CARD_GAP_MIN so the screen edge to the nearest card reads as just another gap in the card grid. */
export const GAME_CONTENT_PADDING = CARD_GAP_MIN

/** Cap on the board's own content width on a very wide window - past this the leftover becomes
 * empty, symmetric gutters. See GameChrome's own doc comment on this for how 1040 was derived. */
export const GAME_CONTENT_MAX_WIDTH = 1040

/** Vertical space GameChrome's title/corner-icon band and its moves/timer + footer band each reserve
 * above/below the scrolling board in PORTRAIT (on top of the safe-area insets). */
export const GAME_CONTENT_TOP_PADDING = 56
export const GAME_CONTENT_BOTTOM_PADDING = 88

/** Wide layout: width the TRAILING (local right) gutter reserves for the footer column (an 8pt margin off the
 * safe edge, a 40pt IconButton, and 8pt of air before the board), ON TOP of the safe-area inset on that
 * side. The controls live on the right - where the thumb is in a landscape hold. */
export const WIDE_FOOTER_SIDE_WIDTH = 56
/** Wide layout: width the LEADING (local left) gutter reserves for the moves/score/time readout (an 8pt margin off
 * the safe edge plus room for a 5-digit score / 3-digit-minute time), ON TOP of the inset on that side. */
export const WIDE_STATS_SIDE_WIDTH = 64
/** Wide layout: the thin margin left above/below the board (the corner buttons sit beside it, in the
 * gutters, so no vertical band is reserved for them). */
export const WIDE_CONTENT_TOP_PADDING = 8
export const WIDE_CONTENT_BOTTOM_PADDING = 8

export interface LayoutInsets {
  top: number
  right: number
  bottom: number
  left: number
}

export interface GameLayout {
  /** The rotated footprint is landscape - the side-chrome layout is in effect. */
  isWide: boolean
  /** The window's footprint AFTER rotation (width/height already swapped under a +/-90deg hold). */
  windowWidth: number
  windowHeight: number
  /** Safe-area insets remapped onto the rotated frame's own edges (see @tastic/core's rotateInsets). */
  insets: LayoutInsets
  /** Width reserved on the LEADING (local left, the moves/score/time readout) / TRAILING (local right, the
   * footer controls) side for the chrome columns -
   * each hugs ITS OWN safe-area inset rather than both using the larger one, so a side with a small
   * inset (the home-indicator side of a phone held sideways) doesn't carry dead space the other side's
   * notch inset needs. 0 in portrait. */
  leftGutter: number
  rightGutter: number
  /** Width the board may occupy (the window minus both gutters, capped) - what a screen feeds
   * cardLayoutForRow (minus GAME_CONTENT_PADDING*2) and what RotatedContentGutter caps its content column at. */
  contentWidth: number
  /** Vertical space reserved above/below the board (on top of the insets). */
  topPadding: number
  bottomPadding: number
  /** Height left for the board itself: window height minus insets minus the two paddings. */
  availableHeight: number
}

/** Pure form of useGameLayout, for tests and non-React callers. */
export function computeGameLayout(windowWidth: number, windowHeight: number, insets: LayoutInsets): GameLayout {
  const isWide = windowWidth > windowHeight
  const leftGutter = isWide ? WIDE_STATS_SIDE_WIDTH + insets.left : 0
  const rightGutter = isWide ? WIDE_FOOTER_SIDE_WIDTH + insets.right : 0
  const contentWidth = Math.min(Math.max(0, windowWidth - leftGutter - rightGutter), GAME_CONTENT_MAX_WIDTH)
  const topPadding = isWide ? WIDE_CONTENT_TOP_PADDING : GAME_CONTENT_TOP_PADDING
  const bottomPadding = isWide ? WIDE_CONTENT_BOTTOM_PADDING : GAME_CONTENT_BOTTOM_PADDING
  const availableHeight = windowHeight - insets.top - insets.bottom - topPadding - bottomPadding
  return { isWide, windowWidth, windowHeight, insets, leftGutter, rightGutter, contentWidth, topPadding, bottomPadding, availableHeight }
}

/** The live layout for the current window + rotation. Reads useRotatedWindowDimensions()/rotateInsets()
 * rather than raw useWindowDimensions()/useSafeAreaInsets(), so it describes the footprint a rotated
 * game screen actually renders into (both are exact identities at 0deg / with no OrientationProvider). */
export function useGameLayout(): GameLayout {
  const { width, height } = useRotatedWindowDimensions()
  const rotation = useRotation()
  const insets = rotateInsets(useSafeAreaInsets(), rotation)
  return computeGameLayout(width, height, insets)
}

/* ---- board height model -------------------------------------------------------------------- */

/** Card height / width. */
export const CARD_HEIGHT_RATIO = 1 / CARD_ASPECT
/** How far a face-down card in a fan shows below the one above it, per unit of card width - mirrors
 * PileView's own `cardHeight * 0.13` default. */
export const FACE_DOWN_FAN_RATIO = 0.13 * CARD_HEIGHT_RATIO
/** Same for a face-up card - mirrors PileView's `faceUpFanOffset(cardWidth)` (linear in width). */
export const FACE_UP_FAN_RATIO = faceUpFanOffset(1)
/** The tableau row's own paddingBottom and a top row's marginBottom - identical across the column
 * games (see useTableauMaxHeight's own notes). */
export const TOP_ROW_MARGIN_BOTTOM = 16
export const TABLEAU_ROW_PADDING_BOTTOM = 20
/** Face-up cards of headroom a board model budgets on top of its deal, so a column doesn't start
 * compressing the instant the first few moves are made. */
export const DEFAULT_HEADROOM_FACE_UP = 3

/** A board's total height as an affine function of card width: `perWidth * cardWidth + fixed`.
 * Everything a column board draws (a top row of cards, fanned columns, paddings) is linear in card
 * width except the fixed paddings, which is what makes a closed-form fit possible. */
export interface BoardHeightModel {
  perWidth: number
  fixed: number
}

export interface ColumnBoardOptions {
  /** How many card-heights tall the row above the tableau is (0 = none, 1 = a single row of cards).
   * Default 1. */
  topRowCards?: number
  topRowMargin?: number
  tableauPaddingBottom?: number
  /** The tallest tableau column at the START of a deal: how many face-down cards, and how many face-up
   * ones (counting the last, fully-visible card). */
  faceDown: number
  faceUp: number
  /** Extra face-up cards to budget beyond the deal. Default DEFAULT_HEADROOM_FACE_UP. */
  headroomFaceUp?: number
  /** Any additional fixed height (px) the board carries that isn't card-relative. */
  extraFixed?: number
  /** Any additional height in card widths (e.g. a second row of cards). */
  extraPerWidth?: number
}

/** Builds the height model for a "top row + fanned tableau columns" board - every column game in this
 * app (Klondike, Yukon, FreeCell, Spider, Scorpion, Canfield, Forty Thieves, Golf, Aces Up) is one,
 * differing only in what its tallest starting column holds. The result is the height of the board
 * INCLUDING its paddings, which is what fitCardWidthToHeight compares against the available height. */
export function columnBoardModel(opts: ColumnBoardOptions): BoardHeightModel {
  const topRowCards = opts.topRowCards ?? 1
  const headroom = opts.headroomFaceUp ?? DEFAULT_HEADROOM_FACE_UP
  const fanFaceUp = Math.max(0, opts.faceUp - 1 + headroom)
  const tableau = opts.faceDown * FACE_DOWN_FAN_RATIO + fanFaceUp * FACE_UP_FAN_RATIO + CARD_HEIGHT_RATIO
  return {
    perWidth: topRowCards * CARD_HEIGHT_RATIO + tableau + (opts.extraPerWidth ?? 0),
    fixed: (topRowCards > 0 ? (opts.topRowMargin ?? TOP_ROW_MARGIN_BOTTOM) : 0) + (opts.tableauPaddingBottom ?? TABLEAU_ROW_PADDING_BOTTOM) + (opts.extraFixed ?? 0)
  }
}

/** Never shrink a card below this (mirrors @tastic/cards' own cardWidthForRow default minimum), so a
 * window with almost no height still renders tappable cards rather than shrinking toward zero. */
export const MIN_CARD_WIDTH = 28

/** The largest card width - capped at the width-derived one - at which `model`'s board still fits in
 * `availableHeight`. */
export function fitCardWidthToHeight(widthCardWidth: number, availableHeight: number, model: BoardHeightModel): number {
  const heightCardWidth = (availableHeight - model.fixed) / model.perWidth
  return Math.max(MIN_CARD_WIDTH, Math.min(widthCardWidth, heightCardWidth))
}

/** A screen's final card width: the width-derived one in portrait (unchanged), fitted to the height in
 * the wide layout. `model` describes THIS game's board - see columnBoardModel. */
export function useFittedCardWidth(widthCardWidth: number, model: BoardHeightModel): number {
  const { isWide, availableHeight } = useGameLayout()
  return isWide ? fitCardWidthToHeight(widthCardWidth, availableHeight, model) : widthCardWidth
}

/** The gap between cards once the height fit (rather than the width) is what sized them: the width-
 * derived layout assumed the row would fill the window, so a shrunken row would otherwise sit as a
 * tight clump in the middle of a mostly empty content column. Spreads the leftover width across the
 * gaps, clamped to [CARD_GAP_MIN, CARD_GAP_MAX] - the same ceiling cardLayoutForRow already applies
 * once cards max out - which also gives the (small) cards bigger drop targets. */
export function fittedGap(rowWidth: number, cardWidth: number, columns: number): number {
  if (columns <= 1) return CARD_GAP_MIN
  return Math.min(CARD_GAP_MAX, Math.max(CARD_GAP_MIN, (rowWidth - cardWidth * columns) / (columns - 1)))
}

/** A screen's final card gap: the width-derived one unless the height fit actually shrank the cards
 * (only ever in the wide layout), in which case the leftover width is spread - see fittedGap. */
export function useFittedGap(widthGap: number, widthCardWidth: number, cardWidth: number, rowWidth: number, columns: number): number {
  const { isWide } = useGameLayout()
  return isWide && cardWidth < widthCardWidth ? fittedGap(rowWidth, cardWidth, columns) : widthGap
}
